/**
 * SQLite-backed graph store for the context graph.
 *
 * Uses better-sqlite3 for synchronous, fast graph operations.
 * Degrades gracefully if SQLite init fails (logs warning, continues without graph).
 *
 * @module graph/index
 */

import Database from 'better-sqlite3';
import { GRAPH_SCHEMA } from './schema.js';
import { GraphError } from '../errors.js';
import { createLogger } from '../utils/logger.js';
import type { GraphNode, GraphEdge, GraphNeighbor, EdgeType, NodeKind } from './types.js';

const log = createLogger('graph-store');

/**
 * SQLite-backed graph store for structural code relationships.
 */
export class GraphStore {
  private db: Database.Database | null = null;
  private dbPath: string;
  private initialized = false;

  // Prepared statements (lazily created)
  private stmts: {
    upsertNode?: Database.Statement;
    upsertEdge?: Database.Statement;
    deleteNodesByFile?: Database.Statement;
    deleteEdgesBySource?: Database.Statement;
    deleteEdgesByTarget?: Database.Statement;
    getNode?: Database.Statement;
    getOutEdges?: Database.Statement;
    getInEdges?: Database.Statement;
    getStaleNodes?: Database.Statement;
    markStale?: Database.Statement;
    getSymbolIndex?: Database.Statement;
    getAllNodes?: Database.Statement;
    getNodesByFile?: Database.Statement;
    getMeta?: Database.Statement;
    setMeta?: Database.Statement;
    countNodes?: Database.Statement;
    countEdges?: Database.Statement;
  } = {};

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Initialize the SQLite database and create schema.
   * Returns false if initialization fails (graph will be disabled).
   */
  initialize(): boolean {
    if (this.initialized) return true;

    try {
      this.db = new Database(this.dbPath);

      // Enable WAL mode for better concurrent read performance
      this.db.pragma('journal_mode = WAL');
      // Enable foreign keys for cascade deletes
      this.db.pragma('foreign_keys = ON');

      // Create schema
      this.db.exec(GRAPH_SCHEMA);

      this.prepareStatements();
      this.initialized = true;
      log.info('Graph store initialized', { dbPath: this.dbPath });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('Graph store initialization failed, continuing without graph', {
        dbPath: this.dbPath,
        error: message,
      });
      this.db = null;
      return false;
    }
  }

  /**
   * Check if the graph store is available.
   */
  isAvailable(): boolean {
    return this.initialized && this.db !== null;
  }

  /**
   * Prepare frequently-used statements for performance.
   */
  private prepareStatements(): void {
    if (!this.db) return;

    this.stmts.upsertNode = this.db.prepare(`
      INSERT INTO graph_nodes (id, file_path, symbol_name, kind, start_line, end_line, updated_at, stale)
      VALUES (@id, @filePath, @symbolName, @kind, @startLine, @endLine, @updatedAt, @stale)
      ON CONFLICT(id) DO UPDATE SET
        file_path = @filePath,
        symbol_name = @symbolName,
        kind = @kind,
        start_line = @startLine,
        end_line = @endLine,
        updated_at = @updatedAt,
        stale = @stale
    `);

    this.stmts.upsertEdge = this.db.prepare(`
      INSERT INTO graph_edges (source_id, target_id, edge_type, weight, metadata)
      VALUES (@sourceId, @targetId, @edgeType, @weight, @metadata)
      ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET
        weight = @weight,
        metadata = @metadata
    `);

    this.stmts.deleteNodesByFile = this.db.prepare(
      `DELETE FROM graph_nodes WHERE file_path = ?`
    );

    this.stmts.deleteEdgesBySource = this.db.prepare(
      `DELETE FROM graph_edges WHERE source_id IN (SELECT id FROM graph_nodes WHERE file_path = ?)`
    );

    this.stmts.deleteEdgesByTarget = this.db.prepare(
      `DELETE FROM graph_edges WHERE target_id IN (SELECT id FROM graph_nodes WHERE file_path = ?)`
    );

    this.stmts.getNode = this.db.prepare(
      `SELECT * FROM graph_nodes WHERE id = ?`
    );

    this.stmts.getOutEdges = this.db.prepare(
      `SELECT * FROM graph_edges WHERE source_id = ?`
    );

    this.stmts.getInEdges = this.db.prepare(
      `SELECT * FROM graph_edges WHERE target_id = ?`
    );

    this.stmts.getStaleNodes = this.db.prepare(
      `SELECT * FROM graph_nodes WHERE stale = 1`
    );

    this.stmts.markStale = this.db.prepare(
      `UPDATE graph_nodes SET stale = 1 WHERE file_path = ?`
    );

    this.stmts.getSymbolIndex = this.db.prepare(
      `SELECT id, symbol_name, file_path FROM graph_nodes WHERE symbol_name IS NOT NULL`
    );

    this.stmts.getAllNodes = this.db.prepare(
      `SELECT * FROM graph_nodes`
    );

    this.stmts.getNodesByFile = this.db.prepare(
      `SELECT * FROM graph_nodes WHERE file_path = ?`
    );

    this.stmts.getMeta = this.db.prepare(
      `SELECT value FROM graph_meta WHERE key = ?`
    );

    this.stmts.setMeta = this.db.prepare(
      `INSERT INTO graph_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );

    this.stmts.countNodes = this.db.prepare(
      `SELECT COUNT(*) as count FROM graph_nodes`
    );

    this.stmts.countEdges = this.db.prepare(
      `SELECT COUNT(*) as count FROM graph_edges`
    );
  }

  /**
   * Ensure the store is initialized before operations.
   */
  private ensureAvailable(): void {
    if (!this.isAvailable()) {
      throw new GraphError('Graph store is not available');
    }
  }

  /**
   * Upsert multiple nodes in a transaction.
   */
  upsertNodes(nodes: GraphNode[]): void {
    this.ensureAvailable();
    if (nodes.length === 0) return;

    const upsertMany = this.db!.transaction((items: GraphNode[]) => {
      for (const node of items) {
        this.stmts.upsertNode!.run({
          id: node.id,
          filePath: node.filePath,
          symbolName: node.symbolName,
          kind: node.kind,
          startLine: node.startLine,
          endLine: node.endLine,
          updatedAt: node.updatedAt,
          stale: node.stale ? 1 : 0,
        });
      }
    });

    upsertMany(nodes);
  }

  /**
   * Upsert multiple edges in a transaction.
   */
  upsertEdges(edges: GraphEdge[]): void {
    this.ensureAvailable();
    if (edges.length === 0) return;

    const upsertMany = this.db!.transaction((items: GraphEdge[]) => {
      for (const edge of items) {
        this.stmts.upsertEdge!.run({
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          edgeType: edge.edgeType,
          weight: edge.weight,
          metadata: edge.metadata,
        });
      }
    });

    upsertMany(edges);
  }

  /**
   * Delete all graph data for a file (nodes + cascading edges).
   */
  deleteByFile(filePath: string): void {
    this.ensureAvailable();

    const deleteAll = this.db!.transaction((fp: string) => {
      // Delete edges first (since FK cascade may not fire for all DBs)
      this.stmts.deleteEdgesBySource!.run(fp);
      this.stmts.deleteEdgesByTarget!.run(fp);
      // Delete nodes
      this.stmts.deleteNodesByFile!.run(fp);
    });

    deleteAll(filePath);
  }

  /**
   * Get a single node by ID.
   */
  getNode(id: string): GraphNode | undefined {
    this.ensureAvailable();
    const row = this.stmts.getNode!.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : undefined;
  }

  /**
   * Get all nodes for a file.
   */
  getNodesByFile(filePath: string): GraphNode[] {
    this.ensureAvailable();
    const rows = this.stmts.getNodesByFile!.all(filePath) as Record<string, unknown>[];
    return rows.map((row) => this.rowToNode(row));
  }

  /**
   * BFS traversal to find neighbors up to a given depth.
   *
   * @param startId - Starting node ID
   * @param maxDepth - Maximum traversal depth (1-5)
   * @param edgeKinds - Edge types to follow (empty = all)
   * @returns Array of neighbors with their connecting edges and depth
   */
  getNeighbors(
    startId: string,
    maxDepth: number = 2,
    edgeKinds?: EdgeType[]
  ): GraphNeighbor[] {
    this.ensureAvailable();

    const depth = Math.min(Math.max(maxDepth, 1), 5);
    const visited = new Set<string>([startId]);
    const result: GraphNeighbor[] = [];
    let frontier = [startId];

    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        // Get outgoing edges
        const outEdges = this.stmts.getOutEdges!.all(nodeId) as Record<string, unknown>[];
        // Get incoming edges
        const inEdges = this.stmts.getInEdges!.all(nodeId) as Record<string, unknown>[];

        const allEdges = [
          ...outEdges.map((e) => ({ ...this.rowToEdge(e), neighborId: e.target_id as string })),
          ...inEdges.map((e) => ({ ...this.rowToEdge(e), neighborId: e.source_id as string })),
        ];

        for (const edgeWithNeighbor of allEdges) {
          const { neighborId, ...edge } = edgeWithNeighbor;

          // Filter by edge kinds if specified
          if (edgeKinds && edgeKinds.length > 0 && !edgeKinds.includes(edge.edgeType)) {
            continue;
          }

          if (visited.has(neighborId)) continue;
          visited.add(neighborId);

          const node = this.getNode(neighborId);
          if (node) {
            result.push({ node, edge, depth: d });
            nextFrontier.push(neighborId);
          }
        }
      }

      frontier = nextFrontier;
    }

    return result;
  }

  /**
   * Get all stale nodes (file changed since last graph update).
   */
  getStaleNodes(): GraphNode[] {
    this.ensureAvailable();
    const rows = this.stmts.getStaleNodes!.all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToNode(row));
  }

  /**
   * Mark all nodes for a file as stale.
   */
  markFileStale(filePath: string): void {
    this.ensureAvailable();
    this.stmts.markStale!.run(filePath);
  }

  /**
   * Get the symbol index: mapping of symbol names to (chunkId, filePath) pairs.
   * Used for resolving raw edges to concrete chunk IDs.
   */
  getSymbolIndex(): Map<string, Array<{ id: string; filePath: string }>> {
    this.ensureAvailable();
    const rows = this.stmts.getSymbolIndex!.all() as Array<{
      id: string;
      symbol_name: string;
      file_path: string;
    }>;

    const index = new Map<string, Array<{ id: string; filePath: string }>>();
    for (const row of rows) {
      const existing = index.get(row.symbol_name) || [];
      existing.push({ id: row.id, filePath: row.file_path });
      index.set(row.symbol_name, existing);
    }

    return index;
  }

  /**
   * Get a metadata value.
   */
  getMeta(key: string): string | undefined {
    this.ensureAvailable();
    const row = this.stmts.getMeta!.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Set a metadata value.
   */
  setMeta(key: string, value: string): void {
    this.ensureAvailable();
    this.stmts.setMeta!.run(key, value);
  }

  /**
   * Get node and edge counts.
   */
  getCounts(): { nodes: number; edges: number } {
    this.ensureAvailable();
    const nodeRow = this.stmts.countNodes!.get() as { count: number };
    const edgeRow = this.stmts.countEdges!.get() as { count: number };
    return { nodes: nodeRow.count, edges: edgeRow.count };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('Error closing graph store', { error: message });
      }
      this.db = null;
      this.initialized = false;
      this.stmts = {};
    }
  }

  /**
   * Convert a database row to a GraphNode.
   */
  private rowToNode(row: Record<string, unknown>): GraphNode {
    return {
      id: row.id as string,
      filePath: row.file_path as string,
      symbolName: (row.symbol_name as string) || null,
      kind: (row.kind as NodeKind) || 'unknown',
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      updatedAt: row.updated_at as number,
      stale: (row.stale as number) === 1,
    };
  }

  /**
   * Convert a database row to a GraphEdge.
   */
  private rowToEdge(row: Record<string, unknown>): GraphEdge {
    return {
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      edgeType: row.edge_type as EdgeType,
      weight: row.weight as number,
      metadata: (row.metadata as string) || null,
    };
  }
}
