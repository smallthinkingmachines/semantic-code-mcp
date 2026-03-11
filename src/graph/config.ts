/**
 * Configuration for the context graph feature.
 *
 * Reads from environment variables with sensible defaults.
 * The graph feature is opt-in via SEMANTIC_CODE_GRAPH_ENABLED.
 *
 * @module graph/config
 */

import type { EdgeType } from './types.js';

/**
 * Configuration for the graph store and session manager.
 */
export interface GraphConfig {
  /** Whether the graph feature is enabled */
  enabled: boolean;
  /** Maximum BFS traversal depth for neighbor queries */
  maxDepth: number;
  /** Session TTL in milliseconds (default: 1 hour) */
  sessionTtl: number;
  /** Which edge types to include in queries (default: all) */
  edgeKinds: EdgeType[];
  /** Path to the SQLite database file (derived from index dir) */
  dbPath?: string;
}

/** All valid edge types */
const ALL_EDGE_KINDS: EdgeType[] = [
  'calls',
  'imports',
  'extends',
  'implements',
  'exports',
  'agent_linked',
];

/**
 * Load graph configuration from environment variables.
 *
 * Environment variables:
 * - `SEMANTIC_CODE_GRAPH_ENABLED` or `SEMANTIC_CODE_GRAPH` — "true"/"1" to enable
 * - `SEMANTIC_CODE_GRAPH_DEPTH` — max BFS depth (1-5, default: 2)
 * - `SEMANTIC_CODE_SESSION_TTL` — session TTL in seconds (default: 3600)
 * - `SEMANTIC_CODE_EDGE_KINDS` — comma-separated edge types (default: all)
 */
export function loadGraphConfig(): GraphConfig {
  const enabled =
    process.env.SEMANTIC_CODE_GRAPH_ENABLED === 'true' ||
    process.env.SEMANTIC_CODE_GRAPH_ENABLED === '1' ||
    process.env.SEMANTIC_CODE_GRAPH === 'true' ||
    process.env.SEMANTIC_CODE_GRAPH === '1';

  const depthStr = process.env.SEMANTIC_CODE_GRAPH_DEPTH;
  let maxDepth = 2;
  if (depthStr) {
    const parsed = parseInt(depthStr, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 5) {
      maxDepth = parsed;
    }
  }

  const ttlStr = process.env.SEMANTIC_CODE_SESSION_TTL;
  let sessionTtl = 3600 * 1000; // 1 hour in ms
  if (ttlStr) {
    const parsed = parseInt(ttlStr, 10);
    if (!isNaN(parsed) && parsed > 0) {
      sessionTtl = parsed * 1000; // Convert seconds to ms
    }
  }

  let edgeKinds: EdgeType[] = [...ALL_EDGE_KINDS];
  const kindsStr = process.env.SEMANTIC_CODE_EDGE_KINDS;
  if (kindsStr) {
    const parsed = kindsStr
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is EdgeType => ALL_EDGE_KINDS.includes(s as EdgeType));
    if (parsed.length > 0) {
      edgeKinds = parsed;
    }
  }

  return { enabled, maxDepth, sessionTtl, edgeKinds };
}
