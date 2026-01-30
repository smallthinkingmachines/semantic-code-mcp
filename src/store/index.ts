/**
 * LanceDB vector store for semantic code search.
 * Provides serverless embedded vector database with hybrid search support.
 */

import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs';
import type { CodeChunk } from '../chunker/index.js';

export interface VectorRecord {
  /** Unique chunk ID */
  id: string;
  /** Embedding vector (768 dimensions) */
  vector: number[];
  /** Source file path */
  filePath: string;
  /** Code content */
  content: string;
  /** Start line number */
  startLine: number;
  /** End line number */
  endLine: number;
  /** Function/class name */
  name: string | null;
  /** AST node type */
  nodeType: string;
  /** Function signature */
  signature: string | null;
  /** Docstring/comment */
  docstring: string | null;
  /** Programming language */
  language: string;
  /** Content hash for change detection */
  contentHash: string;
  /** Timestamp of indexing */
  indexedAt: number;
}

export interface SearchResult {
  /** The matching record */
  record: VectorRecord;
  /** Similarity score (0-1) */
  score: number;
}

export interface StoreOptions {
  /** Base directory for the index (default: .semantic-code/index) */
  indexDir?: string;
  /** Table name (default: code_chunks) */
  tableName?: string;
}

const DEFAULT_INDEX_DIR = '.semantic-code/index';
const DEFAULT_TABLE_NAME = 'code_chunks';

/**
 * LanceDB-based vector store using modern API patterns
 */
export class VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private indexDir: string;
  private tableName: string;
  private initialized = false;
  private ftsIndexCreated = false;

  constructor(options: StoreOptions = {}) {
    this.indexDir = options.indexDir || DEFAULT_INDEX_DIR;
    this.tableName = options.tableName || DEFAULT_TABLE_NAME;
  }

  /**
   * Initialize the database connection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create index directory if it doesn't exist
    if (!fs.existsSync(this.indexDir)) {
      fs.mkdirSync(this.indexDir, { recursive: true });
    }

    // Connect to LanceDB
    this.db = await lancedb.connect(this.indexDir);

    // Check if table exists
    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
    }

    this.initialized = true;
  }

  /**
   * Ensure the database is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Create FTS index on content column for hybrid search
   */
  private async ensureFtsIndex(): Promise<void> {
    if (this.ftsIndexCreated || !this.table) return;

    try {
      // Create full-text search index on content column
      await this.table.createIndex('content', {
        config: lancedb.Index.fts(),
      });
      this.ftsIndexCreated = true;
    } catch (error) {
      // Index might already exist or FTS not supported
      console.error('[VectorStore] FTS index creation skipped:', error);
    }
  }

  /**
   * Create or update the table with records
   */
  async upsert(records: VectorRecord[]): Promise<void> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (records.length === 0) return;

    // Convert records to the format LanceDB expects
    const data = records.map((record) => ({
      id: record.id,
      vector: record.vector,
      filePath: record.filePath,
      content: record.content,
      startLine: record.startLine,
      endLine: record.endLine,
      name: record.name || '',
      nodeType: record.nodeType,
      signature: record.signature || '',
      docstring: record.docstring || '',
      language: record.language,
      contentHash: record.contentHash,
      indexedAt: record.indexedAt,
    }));

    if (!this.table) {
      // Create table with first batch
      this.table = await this.db.createTable(this.tableName, data, {
        mode: 'overwrite',
      });
      // Create FTS index after table creation
      await this.ensureFtsIndex();
    } else {
      // For upsert, delete existing records with same IDs first
      const ids = records.map((r) => r.id);
      try {
        await this.table.delete(`id IN ('${ids.join("','")}')`);
      } catch {
        // Table might be empty or IDs don't exist
      }
      await this.table.add(data);
    }
  }

  /**
   * Delete records by file path
   */
  async deleteByFilePath(filePath: string): Promise<void> {
    await this.ensureInitialized();

    if (!this.table) return;

    try {
      await this.table.delete(`filePath = '${filePath.replace(/'/g, "''")}'`);
    } catch {
      // Ignore errors if no records match
    }
  }

  /**
   * Delete all records
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();

    if (!this.db) return;

    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      await this.db.dropTable(this.tableName);
      this.table = null;
      this.ftsIndexCreated = false;
    }
  }

  /**
   * Vector similarity search using modern query API
   */
  async vectorSearch(
    queryVector: number[],
    limit: number = 50,
    filter?: string
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();

    if (!this.table) {
      return [];
    }

    // Use modern query().nearestTo() API
    let query = this.table
      .query()
      .nearestTo(queryVector)
      .distanceType('cosine')
      .limit(limit);

    if (filter) {
      query = query.where(filter);
    }

    const results = await query.toArray();

    return results.map((row) => ({
      record: this.rowToRecord(row),
      // Convert distance to similarity score (cosine distance to similarity)
      score: row._distance != null ? 1 - (row._distance as number) : 0,
    }));
  }

  /**
   * Full-text search using LanceDB FTS
   */
  async fullTextSearch(
    queryText: string,
    limit: number = 50
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();

    if (!this.table) {
      return [];
    }

    try {
      // Try native FTS search
      const results = await this.table
        .search(queryText, 'fts')
        .limit(limit)
        .toArray();

      return results.map((row) => ({
        record: this.rowToRecord(row),
        score: row._score != null ? (row._score as number) : 0.5,
      }));
    } catch {
      // Fall back to manual keyword matching if FTS not available
      return this.fallbackTextSearch(queryText, limit);
    }
  }

  /**
   * Fallback text search using manual keyword matching
   */
  private async fallbackTextSearch(
    query: string,
    limit: number
  ): Promise<SearchResult[]> {
    if (!this.table) return [];

    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];

    try {
      const allRecords = await this.table.query().limit(10000).toArray();

      const matches = allRecords
        .map((row) => {
          const content = ((row.content as string) || '').toLowerCase();
          const name = ((row.name as string) || '').toLowerCase();
          const signature = ((row.signature as string) || '').toLowerCase();

          let score = 0;
          for (const keyword of keywords) {
            if (content.includes(keyword)) score += 1;
            if (name.includes(keyword)) score += 2;
            if (signature.includes(keyword)) score += 1.5;
          }

          return { row, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return matches.map(({ row, score }) => ({
        record: this.rowToRecord(row),
        score: score / (keywords.length * 4),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Convert a LanceDB row to a VectorRecord
   */
  private rowToRecord(row: Record<string, unknown>): VectorRecord {
    return {
      id: row.id as string,
      vector: row.vector as number[],
      filePath: row.filePath as string,
      content: row.content as string,
      startLine: row.startLine as number,
      endLine: row.endLine as number,
      name: (row.name as string) || null,
      nodeType: row.nodeType as string,
      signature: (row.signature as string) || null,
      docstring: (row.docstring as string) || null,
      language: row.language as string,
      contentHash: row.contentHash as string,
      indexedAt: row.indexedAt as number,
    };
  }

  /**
   * Get record count
   */
  async count(): Promise<number> {
    await this.ensureInitialized();

    if (!this.table) return 0;

    return await this.table.countRows();
  }

  /**
   * Get all unique file paths in the index
   */
  async getIndexedFiles(): Promise<Map<string, string>> {
    await this.ensureInitialized();

    if (!this.table) return new Map();

    const results = await this.table
      .query()
      .select(['filePath', 'contentHash'])
      .toArray();

    const fileMap = new Map<string, string>();
    for (const row of results) {
      const filePath = row.filePath as string;
      const contentHash = row.contentHash as string;
      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, contentHash);
      }
    }

    return fileMap;
  }

  /**
   * Check if the store has any data
   */
  async isEmpty(): Promise<boolean> {
    const count = await this.count();
    return count === 0;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    this.db = null;
    this.table = null;
    this.initialized = false;
    this.ftsIndexCreated = false;
  }
}

/**
 * Create a VectorRecord from a CodeChunk and embedding
 */
export function createVectorRecord(
  chunk: CodeChunk,
  embedding: number[],
  contentHash: string
): VectorRecord {
  return {
    id: chunk.id,
    vector: embedding,
    filePath: chunk.filePath,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    name: chunk.name,
    nodeType: chunk.nodeType,
    signature: chunk.signature,
    docstring: chunk.docstring,
    language: chunk.language,
    contentHash,
    indexedAt: Date.now(),
  };
}
