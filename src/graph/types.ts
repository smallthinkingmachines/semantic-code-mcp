/**
 * Type definitions for the context graph.
 *
 * The context graph captures structural relationships between code chunks
 * (calls, imports, inheritance) and tracks agent reasoning state.
 *
 * @module graph/types
 */

import type { CodeChunk } from '../chunker/index.js';

/** Types of edges in the context graph */
export type EdgeType =
  | 'calls'
  | 'imports'
  | 'extends'
  | 'implements'
  | 'exports'
  | 'agent_linked';

/** Kinds of nodes in the graph */
export type NodeKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'module'
  | 'variable'
  | 'enum'
  | 'unknown';

/**
 * A node in the context graph, representing a code chunk.
 */
export interface GraphNode {
  /** Chunk ID (matches CodeChunk.id) */
  id: string;
  /** Source file path */
  filePath: string;
  /** Symbol name (function/class/method name) */
  symbolName: string | null;
  /** Kind of code entity */
  kind: NodeKind;
  /** Start line in source file (1-indexed) */
  startLine: number;
  /** End line in source file (1-indexed) */
  endLine: number;
  /** When the node was last updated (epoch ms) */
  updatedAt: number;
  /** Whether this node is stale (file changed since last graph update) */
  stale: boolean;
}

/**
 * An edge in the context graph, representing a relationship between chunks.
 */
export interface GraphEdge {
  /** Source chunk ID */
  sourceId: string;
  /** Target chunk ID */
  targetId: string;
  /** Type of relationship */
  edgeType: EdgeType;
  /** Confidence weight (0.0 - 1.0) */
  weight: number;
  /** Additional metadata (e.g., import path, called function name) */
  metadata: string | null;
}

/**
 * A raw edge extracted from AST before symbol resolution.
 * Contains the symbol name rather than the resolved chunk ID.
 */
export interface RawEdge {
  /** Chunk ID of the source node */
  sourceChunkId: string;
  /** File path of the source */
  sourceFilePath: string;
  /** Target symbol name (to be resolved to a chunk ID) */
  targetSymbol: string;
  /** Type of relationship */
  edgeType: EdgeType;
  /** Optional module path for imports */
  modulePath?: string;
}

/**
 * Result of chunking with edge extraction.
 */
export interface ChunkResult {
  /** The code chunks */
  chunks: CodeChunk[];
  /** Raw edges extracted from AST (before resolution) */
  rawEdges: RawEdge[];
}

/**
 * A graph neighbor returned by BFS traversal.
 */
export interface GraphNeighbor {
  /** The neighbor node */
  node: GraphNode;
  /** The edge connecting to this neighbor */
  edge: GraphEdge;
  /** BFS depth from the starting node */
  depth: number;
}
