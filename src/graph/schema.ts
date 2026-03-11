/**
 * SQLite DDL for the context graph database.
 *
 * Three tables:
 * - `graph_nodes` — code chunk nodes with metadata
 * - `graph_edges` — relationships between nodes
 * - `graph_meta` — key-value store for graph metadata
 *
 * @module graph/schema
 */

export const GRAPH_SCHEMA = `
-- Graph nodes representing code chunks
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  symbol_name TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON graph_nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_symbol_name ON graph_nodes(symbol_name);
CREATE INDEX IF NOT EXISTS idx_nodes_stale ON graph_nodes(stale) WHERE stale = 1;

-- Graph edges representing relationships
CREATE TABLE IF NOT EXISTS graph_edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  metadata TEXT,
  PRIMARY KEY (source_id, target_id, edge_type),
  FOREIGN KEY (source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(edge_type);

-- Graph metadata key-value store
CREATE TABLE IF NOT EXISTS graph_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
