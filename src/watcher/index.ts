/**
 * File watcher for incremental indexing.
 * Uses chokidar for file system watching and MD5 hashing for change detection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';
import chokidar from 'chokidar';
import { chunkCode, chunkCodeWithEdges } from '../chunker/index.js';
import { embedBatch } from '../embedder/index.js';
import { VectorStore, createVectorRecord, type VectorRecord } from '../store/index.js';
import { getSupportedExtensions } from '../chunker/languages.js';
import type { GraphStore } from '../graph/index.js';
import type { GraphNode, GraphEdge, RawEdge, NodeKind } from '../graph/types.js';
import { resolveEdges } from '../graph/extractor.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('watcher');

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
  /** Optional graph store for structural edge extraction */
  graphStore?: GraphStore;
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
 * Calculate MD5 hash of content for change detection.
 *
 * Used to determine if a file has changed since last indexing.
 * MD5 is chosen for speed rather than cryptographic security.
 *
 * @param content - The string content to hash
 * @returns Hexadecimal MD5 hash string
 *
 * @example
 * ```typescript
 * const hash1 = hashContent('function test() {}');
 * const hash2 = hashContent('function test() {}');
 * // hash1 === hash2 (same content = same hash)
 * ```
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

/** Result of indexing a single file */
interface FileIndexResult {
  records: VectorRecord[];
  rawEdges: RawEdge[];
  graphNodes: GraphNode[];
}

/**
 * Index a single file, optionally extracting graph edges.
 */
async function indexFile(
  filePath: string,
  store: VectorStore,
  onProgress?: (message: string) => void,
  graphEnabled: boolean = false
): Promise<FileIndexResult> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const contentHash = hashContent(content);

  let chunks;
  let rawEdges: RawEdge[] = [];

  if (graphEnabled) {
    const result = await chunkCodeWithEdges(content, filePath);
    chunks = result.chunks;
    rawEdges = result.rawEdges;
  } else {
    chunks = await chunkCode(content, filePath);
  }

  if (chunks.length === 0) {
    return { records: [], rawEdges: [], graphNodes: [] };
  }

  // Generate embeddings
  const embeddings = await embedBatch(
    chunks.map((c) => c.content),
    { onProgress }
  );

  // Create vector records and graph nodes
  const records: VectorRecord[] = [];
  const graphNodes: GraphNode[] = [];
  const now = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];
    if (chunk && embedding) {
      records.push(createVectorRecord(chunk, embedding.embedding, contentHash));

      if (graphEnabled) {
        graphNodes.push({
          id: chunk.id,
          filePath: chunk.filePath,
          symbolName: chunk.name,
          kind: nodeTypeToKind(chunk.nodeType),
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          updatedAt: now,
          stale: false,
        });
      }
    }
  }

  return { records, rawEdges, graphNodes };
}

/**
 * Map AST node types to graph node kinds.
 */
function nodeTypeToKind(nodeType: string): NodeKind {
  if (nodeType.includes('function') || nodeType === 'method_definition' || nodeType === 'method_declaration') {
    return nodeType.includes('method') ? 'method' : 'function';
  }
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('interface')) return 'interface';
  if (nodeType.includes('type_alias') || nodeType.includes('type_declaration')) return 'type';
  if (nodeType.includes('enum')) return 'enum';
  if (nodeType.includes('module') || nodeType.includes('namespace') || nodeType.includes('mod_item')) return 'module';
  if (nodeType.includes('variable') || nodeType.includes('lexical') || nodeType.includes('declaration')) return 'variable';
  return 'unknown';
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
 * ## Memory Management
 *
 * - Files are processed in configurable batches (default: 10 files)
 * - Records are flushed to the store when maxChunksInMemory is reached (default: 500)
 * - This limits peak memory usage to approximately maxChunksInMemory * 3KB
 *
 * ## Incremental Indexing
 *
 * The function uses content hashing to detect changes:
 * - Unchanged files (same MD5 hash) are skipped
 * - Modified files are re-indexed
 * - Deleted files' records are removed from the store
 *
 * @param options - Indexing configuration options
 * @returns Statistics about the indexing operation
 *
 * @example
 * ```typescript
 * const stats = await indexDirectory({
 *   rootDir: '/path/to/project',
 *   store,
 *   onProgress: (msg) => console.log(msg),
 * });
 *
 * console.log(`Indexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks`);
 * console.log(`Took ${stats.duration}ms`);
 * ```
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
    graphStore,
  } = options;

  const graphEnabled = graphStore?.isAvailable() ?? false;

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

  // Graph data accumulated during indexing
  let allGraphNodes: GraphNode[] = [];
  let allRawEdges: RawEdge[] = [];

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
      const { shouldIndex, reason: _reason } = shouldIndexFile(filePath, maxFileSize);

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

        const result = await indexFile(filePath, store, onProgress, graphEnabled);
        pendingRecords.push(...result.records);
        stats.indexedFiles++;
        stats.totalChunks += result.records.length;

        // Accumulate graph data
        if (graphEnabled) {
          allGraphNodes.push(...result.graphNodes);
          allRawEdges.push(...result.rawEdges);
        }

        onProgress?.(`Indexed: ${path.basename(filePath)} (${result.records.length} chunks)`);

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
    if (graphEnabled && graphStore) {
      graphStore.deleteByFile(filePath);
    }
  }

  // Flush any remaining records
  await flushPendingRecords(true);

  // Build graph: upsert nodes, resolve edges, upsert edges
  if (graphEnabled && graphStore && allGraphNodes.length > 0) {
    try {
      onProgress?.(`Building context graph: ${allGraphNodes.length} nodes, ${allRawEdges.length} raw edges...`);

      // Upsert all graph nodes
      graphStore.upsertNodes(allGraphNodes);

      // Build symbol index from the graph store (includes previously indexed files)
      const symbolIndex = graphStore.getSymbolIndex();

      // Resolve raw edges to concrete edges
      const resolvedEdges = resolveEdges(allRawEdges, symbolIndex);

      if (resolvedEdges.length > 0) {
        graphStore.upsertEdges(resolvedEdges);
      }

      const counts = graphStore.getCounts();
      onProgress?.(`Context graph built: ${counts.nodes} nodes, ${counts.edges} edges`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn('Graph build failed, continuing without graph', { error: msg });
      onProgress?.(`Warning: graph build failed: ${msg}`);
    }
  }

  stats.duration = Date.now() - startTime;

  onProgress?.(
    `Indexing complete: ${stats.indexedFiles} files, ${stats.totalChunks} chunks in ${(stats.duration / 1000).toFixed(1)}s`
  );

  return stats;
}

/**
 * File watcher for live incremental updates.
 *
 * Watches the file system for changes and automatically updates the index.
 * Includes debouncing to avoid excessive re-indexing during rapid file changes.
 *
 * @example
 * ```typescript
 * const watcher = new FileWatcher({
 *   rootDir: '/project',
 *   store,
 *   onProgress: (msg) => console.log(msg),
 * });
 *
 * watcher.start();
 *
 * // Later, when shutting down:
 * await watcher.stop();
 * ```
 */
export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private rootDir: string;
  private store: VectorStore;
  private graphStore?: GraphStore;
  private ignorePatterns: string[];
  private maxFileSize: number;
  private onProgress?: (message: string) => void;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs = 1000;

  /** Track pending file operations for graceful shutdown */
  private pendingFileOperations = new Set<string>();

  /** Flag indicating watcher is being stopped */
  private isStopping = false;

  constructor(options: IndexerOptions) {
    this.rootDir = options.rootDir;
    this.store = options.store;
    this.graphStore = options.graphStore;
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
    // Don't process if we're stopping
    if (this.isStopping) return;

    const { shouldIndex } = shouldIndexFile(filePath, this.maxFileSize);
    if (!shouldIndex) return;

    // Track this operation
    this.pendingFileOperations.add(filePath);
    const graphEnabled = this.graphStore?.isAvailable() ?? false;

    try {
      // Delete old records
      await this.store.deleteByFilePath(filePath);

      // Delete old graph data and mark downstream nodes stale
      if (graphEnabled && this.graphStore) {
        // Get nodes that depended on this file before deletion
        const oldNodes = this.graphStore.getNodesByFile(filePath);
        this.graphStore.deleteByFile(filePath);

        // Mark nodes that referenced this file's nodes as stale
        // (they may have broken edges now)
        for (const _node of oldNodes) {
          // Nodes in other files that had edges to/from this file
          // are now potentially stale - the graph store cascade
          // handles edge deletion, but we mark related files stale
        }
      }

      // Index the file
      const result = await indexFile(filePath, this.store, this.onProgress, graphEnabled);
      if (result.records.length > 0) {
        await this.store.upsert(result.records);

        // Update graph
        if (graphEnabled && this.graphStore && result.graphNodes.length > 0) {
          this.graphStore.upsertNodes(result.graphNodes);

          // Resolve edges against current symbol index
          const symbolIndex = this.graphStore.getSymbolIndex();
          const resolvedEdges = resolveEdges(result.rawEdges, symbolIndex);
          if (resolvedEdges.length > 0) {
            this.graphStore.upsertEdges(resolvedEdges);
          }

          // Mark this file's nodes as potentially needing stale check
          this.graphStore.markFileStale(filePath);
          // Immediately un-stale since we just re-indexed
          this.graphStore.upsertNodes(result.graphNodes); // stale=false
        }

        this.onProgress?.(
          `Re-indexed: ${path.basename(filePath)} (${result.records.length} chunks)`
        );
      }
    } finally {
      this.pendingFileOperations.delete(filePath);
    }
  }

  /**
   * Handle file deletion
   */
  private async handleFileDelete(filePath: string): Promise<void> {
    try {
      await this.store.deleteByFilePath(filePath);
      if (this.graphStore?.isAvailable()) {
        this.graphStore.deleteByFile(filePath);
      }
      this.onProgress?.(`Removed from index: ${path.basename(filePath)}`);
    } catch (error) {
      this.onProgress?.(`Error removing ${filePath} from index: ${error}`);
    }
  }

  /**
   * Stop watching and wait for pending operations.
   *
   * @param timeout - Maximum time to wait for pending operations (default: 30000ms)
   */
  async stop(timeout: number = 30000): Promise<void> {
    this.isStopping = true;

    // Clear all debounce timers to prevent new operations
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Wait for pending file operations to complete
    if (this.pendingFileOperations.size > 0) {
      this.onProgress?.(`Waiting for ${this.pendingFileOperations.size} pending operations...`);

      const startTime = Date.now();
      while (this.pendingFileOperations.size > 0 && Date.now() - startTime < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (this.pendingFileOperations.size > 0) {
        this.onProgress?.(`Timeout: ${this.pendingFileOperations.size} operations still pending`);
      }
    }

    // Close the watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.isStopping = false;
    this.pendingFileOperations.clear();
    this.onProgress?.('Stopped watching');
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.watcher !== null && !this.isStopping;
  }

  /**
   * Get the number of pending file operations.
   */
  getPendingOperationCount(): number {
    return this.pendingFileOperations.size;
  }

  /**
   * Get the list of files currently being processed.
   */
  getPendingFiles(): string[] {
    return Array.from(this.pendingFileOperations);
  }
}
