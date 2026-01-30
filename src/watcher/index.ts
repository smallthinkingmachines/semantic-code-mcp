/**
 * File watcher for incremental indexing.
 * Uses chokidar for file system watching and MD5 hashing for change detection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';
import chokidar from 'chokidar';
import { chunkCode, type CodeChunk } from '../chunker/index.js';
import { embed, embedBatch } from '../embedder/index.js';
import { VectorStore, createVectorRecord, type VectorRecord } from '../store/index.js';
import { getSupportedExtensions } from '../chunker/languages.js';

export interface IndexerOptions {
  /** Root directory to index */
  rootDir: string;
  /** Vector store instance */
  store: VectorStore;
  /** Patterns to ignore (glob patterns) */
  ignorePatterns?: string[];
  /** Maximum file size to index (in bytes) */
  maxFileSize?: number;
  /** Progress callback */
  onProgress?: (message: string) => void;
  /** Batch size for file processing (default: 10) */
  batchSize?: number;
  /**
   * Maximum number of chunks to accumulate before flushing to the store.
   * Lower values use less memory but require more database writes.
   * Default: 500 chunks (~5-10MB of embedding data at 768 dimensions)
   */
  maxChunksInMemory?: number;
}

export interface IndexStats {
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  totalChunks: number;
  duration: number;
}

const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/venv/**',
  '**/.venv/**',
  '**/target/**', // Rust
  '**/vendor/**', // Go
  '**/*.min.js',
  '**/*.bundle.js',
  '**/*.map',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/.semantic-code/**',
];

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1MB

/**
 * Calculate MD5 hash of content
 */
export function hashContent(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Get all indexable files in a directory
 */
async function getIndexableFiles(
  rootDir: string,
  ignorePatterns: string[]
): Promise<string[]> {
  const extensions = getSupportedExtensions();
  const patterns = extensions.map((ext) => `**/*${ext}`);

  const files: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootDir,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });
    files.push(...matches);
  }

  return [...new Set(files)]; // Remove duplicates
}

/**
 * Check if file should be indexed
 */
function shouldIndexFile(
  filePath: string,
  maxFileSize: number
): { shouldIndex: boolean; reason?: string } {
  try {
    const stats = fs.statSync(filePath);

    if (stats.size > maxFileSize) {
      return { shouldIndex: false, reason: 'File too large' };
    }

    if (stats.size === 0) {
      return { shouldIndex: false, reason: 'Empty file' };
    }

    return { shouldIndex: true };
  } catch {
    return { shouldIndex: false, reason: 'Cannot read file' };
  }
}

/**
 * Index a single file
 */
async function indexFile(
  filePath: string,
  store: VectorStore,
  onProgress?: (message: string) => void
): Promise<VectorRecord[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const contentHash = hashContent(content);

  // Chunk the file
  const chunks = await chunkCode(content, filePath);
  if (chunks.length === 0) {
    return [];
  }

  // Generate embeddings
  const embeddings = await embedBatch(
    chunks.map((c) => c.content),
    { onProgress }
  );

  // Create vector records
  const records: VectorRecord[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];
    if (chunk && embedding) {
      records.push(createVectorRecord(chunk, embedding.embedding, contentHash));
    }
  }

  return records;
}

/**
 * Default maximum chunks to keep in memory before flushing to the store.
 * At 768 dimensions with Float32, each embedding is ~3KB, so 500 chunks ≈ 1.5MB.
 * This provides a balance between memory usage and database write efficiency.
 */
const DEFAULT_MAX_CHUNKS_IN_MEMORY = 500;

/**
 * Full indexing of a directory with streaming support for large codebases.
 *
 * This function processes files in batches and periodically flushes accumulated
 * records to the store to prevent memory issues with very large codebases.
 *
 * Memory management:
 * - Files are processed in configurable batches (default: 10 files)
 * - Records are flushed to the store when maxChunksInMemory is reached (default: 500)
 * - This limits peak memory usage to approximately maxChunksInMemory * 3KB
 *
 * @param options - Indexing configuration options
 * @returns Statistics about the indexing operation
 */
export async function indexDirectory(options: IndexerOptions): Promise<IndexStats> {
  const {
    rootDir,
    store,
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
    maxFileSize = DEFAULT_MAX_FILE_SIZE,
    onProgress,
    batchSize = 10,
    maxChunksInMemory = DEFAULT_MAX_CHUNKS_IN_MEMORY,
  } = options;

  const startTime = Date.now();
  const stats: IndexStats = {
    totalFiles: 0,
    indexedFiles: 0,
    skippedFiles: 0,
    totalChunks: 0,
    duration: 0,
  };

  onProgress?.(`Scanning directory: ${rootDir}`);

  // Get all indexable files
  const files = await getIndexableFiles(rootDir, ignorePatterns);
  stats.totalFiles = files.length;

  onProgress?.(`Found ${files.length} files to index`);

  // Get already indexed files for incremental update
  const indexedFiles = await store.getIndexedFiles();

  // Process files in batches with streaming to limit memory usage
  let pendingRecords: VectorRecord[] = [];
  const filesToDelete: string[] = [];

  /**
   * Flush pending records to the store when threshold is reached.
   * This prevents unbounded memory growth for large codebases.
   */
  async function flushPendingRecords(force = false): Promise<void> {
    if (pendingRecords.length === 0) return;
    if (!force && pendingRecords.length < maxChunksInMemory) return;

    onProgress?.(`Flushing ${pendingRecords.length} chunks to index...`);
    await store.upsert(pendingRecords);
    pendingRecords = []; // Clear to free memory
  }

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(files.length / batchSize);

    onProgress?.(`Processing batch ${batchNum}/${totalBatches}`);

    for (const filePath of batch) {
      const { shouldIndex, reason } = shouldIndexFile(filePath, maxFileSize);

      if (!shouldIndex) {
        stats.skippedFiles++;
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const contentHash = hashContent(content);

        // Check if file has changed
        const existingHash = indexedFiles.get(filePath);
        if (existingHash === contentHash) {
          // File unchanged, skip
          stats.indexedFiles++;
          continue;
        }

        // File is new or changed, re-index
        if (existingHash) {
          filesToDelete.push(filePath);
        }

        const records = await indexFile(filePath, store, onProgress);
        pendingRecords.push(...records);
        stats.indexedFiles++;
        stats.totalChunks += records.length;

        onProgress?.(`Indexed: ${path.basename(filePath)} (${records.length} chunks)`);

        // Flush if we've accumulated too many chunks
        await flushPendingRecords();
      } catch (error) {
        onProgress?.(`Error indexing ${filePath}: ${error}`);
        stats.skippedFiles++;
      }
    }
  }

  // Delete old records for changed files
  for (const filePath of filesToDelete) {
    await store.deleteByFilePath(filePath);
  }

  // Flush any remaining records
  await flushPendingRecords(true);

  stats.duration = Date.now() - startTime;

  onProgress?.(
    `Indexing complete: ${stats.indexedFiles} files, ${stats.totalChunks} chunks in ${(stats.duration / 1000).toFixed(1)}s`
  );

  return stats;
}

/**
 * File watcher for live incremental updates
 */
export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private rootDir: string;
  private store: VectorStore;
  private ignorePatterns: string[];
  private maxFileSize: number;
  private onProgress?: (message: string) => void;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs = 1000;

  constructor(options: IndexerOptions) {
    this.rootDir = options.rootDir;
    this.store = options.store;
    this.ignorePatterns = options.ignorePatterns || DEFAULT_IGNORE_PATTERNS;
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;
    this.onProgress = options.onProgress;
  }

  /**
   * Start watching for file changes
   */
  start(): void {
    if (this.watcher) {
      return;
    }

    const extensions = getSupportedExtensions();
    const watchPatterns = extensions.map((ext) => `**/*${ext}`);

    this.watcher = chokidar.watch(watchPatterns, {
      cwd: this.rootDir,
      ignored: this.ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (relativePath) => {
      this.handleFileChange(path.join(this.rootDir, relativePath));
    });

    this.watcher.on('change', (relativePath) => {
      this.handleFileChange(path.join(this.rootDir, relativePath));
    });

    this.watcher.on('unlink', (relativePath) => {
      this.handleFileDelete(path.join(this.rootDir, relativePath));
    });

    this.onProgress?.(`Started watching: ${this.rootDir}`);
  }

  /**
   * Handle file change with debouncing
   */
  private handleFileChange(filePath: string): void {
    // Clear existing timer for this file
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounced handler
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      // Execute async logic separately to enable proper error handling
      this.processFileChange(filePath).catch((error) => {
        this.onProgress?.(`Error re-indexing ${filePath}: ${error}`);
      });
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process file change asynchronously (extracted for proper error handling)
   */
  private async processFileChange(filePath: string): Promise<void> {
    const { shouldIndex } = shouldIndexFile(filePath, this.maxFileSize);
    if (!shouldIndex) return;

    // Delete old records
    await this.store.deleteByFilePath(filePath);

    // Index the file
    const records = await indexFile(filePath, this.store, this.onProgress);
    if (records.length > 0) {
      await this.store.upsert(records);
      this.onProgress?.(
        `Re-indexed: ${path.basename(filePath)} (${records.length} chunks)`
      );
    }
  }

  /**
   * Handle file deletion
   */
  private async handleFileDelete(filePath: string): Promise<void> {
    try {
      await this.store.deleteByFilePath(filePath);
      this.onProgress?.(`Removed from index: ${path.basename(filePath)}`);
    } catch (error) {
      this.onProgress?.(`Error removing ${filePath} from index: ${error}`);
    }
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.onProgress?.('Stopped watching');
  }

  /**
   * Check if watcher is running
   */
  isRunning(): boolean {
    return this.watcher !== null;
  }
}
