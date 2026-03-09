/**
 * MCP tool: context_query
 *
 * Runs semantic search then expands each result's graph neighborhood.
 * Returns code results enriched with structural context (callers, callees,
 * imports, inheritance) and updates session state.
 *
 * @module tools/context-query
 */

import { z } from 'zod';
import type { GraphStore } from '../graph/index.js';
import type { SessionManager } from '../graph/session.js';
import type { GraphConfig } from '../graph/config.js';
import type { GraphNeighbor, EdgeType } from '../graph/types.js';
import type { SemanticSearchTool, SemanticSearchOutput } from './semantic-search.js';

/**
 * Zod input schema for context_query tool.
 */
export const ContextQueryInputSchema = z.object({
  query: z.string().min(1).describe('Natural language query describing what you are looking for'),
  path: z.string().optional().describe('Optional directory path to scope the search'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of search results (default: 10)'),
  file_pattern: z.string().optional().describe('Optional glob pattern to filter files'),
  depth: z.number().int().min(1).max(3).default(1).describe('Graph traversal depth for neighbors (1-3, default: 1)'),
  edge_kinds: z
    .array(z.enum(['calls', 'imports', 'extends', 'implements', 'exports', 'agent_linked']))
    .optional()
    .describe('Edge types to follow (default: all)'),
  session_id: z.string().optional().describe('Session ID for tracking visited nodes and frontier'),
});

export type ContextQueryInput = z.infer<typeof ContextQueryInputSchema>;

/**
 * Output format for context_query.
 */
export interface ContextQueryOutput {
  results: Array<{
    file: string;
    startLine: number;
    endLine: number;
    name: string | null;
    nodeType: string;
    score: number;
    content: string;
    signature: string | null;
    neighbors: Array<{
      id: string;
      file: string;
      symbolName: string | null;
      kind: string;
      edgeType: string;
      direction: 'outgoing' | 'incoming';
      depth: number;
      weight: number;
    }>;
  }>;
  totalResults: number;
  query: string;
  graphStats: {
    totalNeighbors: number;
    graphAvailable: boolean;
  };
  session?: {
    visitedCount: number;
    frontierCount: number;
  };
}

/**
 * Context query tool handler.
 */
export class ContextQueryTool {
  private searchTool: SemanticSearchTool;
  private graphStore: GraphStore | null;
  private sessionManager: SessionManager;
  private graphConfig: GraphConfig;

  constructor(
    searchTool: SemanticSearchTool,
    graphStore: GraphStore | null,
    sessionManager: SessionManager,
    graphConfig: GraphConfig
  ) {
    this.searchTool = searchTool;
    this.graphStore = graphStore;
    this.sessionManager = sessionManager;
    this.graphConfig = graphConfig;
  }

  /**
   * Execute context query: semantic search + graph expansion.
   */
  async execute(
    input: z.input<typeof ContextQueryInputSchema>,
    onProgress?: (message: string) => void
  ): Promise<ContextQueryOutput> {
    const validated = ContextQueryInputSchema.parse(input);

    // Run semantic search first
    const searchResult: SemanticSearchOutput = await this.searchTool.execute(
      {
        query: validated.query,
        path: validated.path,
        limit: validated.limit,
        file_pattern: validated.file_pattern,
      },
      onProgress
    );

    const depth = validated.depth;
    const edgeKinds = validated.edge_kinds as EdgeType[] | undefined;
    let totalNeighbors = 0;

    // Build enriched results
    const results = searchResult.results.map((r) => {
      // Generate the chunk ID to look up in graph
      const chunkId = this.filePathToChunkId(r.file, r.startLine);
      let neighbors: ContextQueryOutput['results'][0]['neighbors'] = [];

      if (this.graphStore?.isAvailable() && chunkId) {
        const graphNeighbors = this.graphStore.getNeighbors(
          chunkId,
          depth,
          edgeKinds || this.graphConfig.edgeKinds
        );
        neighbors = this.formatNeighbors(graphNeighbors, chunkId);
        totalNeighbors += neighbors.length;

        // Update session if provided
        if (validated.session_id) {
          this.sessionManager.visitNode(validated.session_id, chunkId);
          // Add neighbors to frontier
          for (const n of graphNeighbors) {
            this.sessionManager.addToFrontier(
              validated.session_id,
              n.node.id,
              n.edge.weight / n.depth // Priority decreases with depth
            );
          }
        }
      }

      return {
        file: r.file,
        startLine: r.startLine,
        endLine: r.endLine,
        name: r.name,
        nodeType: r.nodeType,
        score: r.score,
        content: r.content,
        signature: r.signature,
        neighbors,
      };
    });

    // Session info
    let session: ContextQueryOutput['session'];
    if (validated.session_id) {
      const summary = this.sessionManager.getSummary(validated.session_id);
      session = {
        visitedCount: summary.visitedCount,
        frontierCount: summary.frontierCount,
      };
    }

    return {
      results,
      totalResults: searchResult.totalResults,
      query: validated.query,
      graphStats: {
        totalNeighbors,
        graphAvailable: this.graphStore?.isAvailable() ?? false,
      },
      session,
    };
  }

  /**
   * Format results for display.
   */
  formatResults(output: ContextQueryOutput): string {
    if (output.results.length === 0) {
      return `No results found for query: "${output.query}"`;
    }

    let formatted = `Found ${output.totalResults} results for: "${output.query}"`;
    if (output.graphStats.graphAvailable) {
      formatted += ` (${output.graphStats.totalNeighbors} graph neighbors)`;
    }
    formatted += '\n\n';

    for (let i = 0; i < output.results.length; i++) {
      const r = output.results[i];
      if (!r) continue;

      const name = r.name || 'anonymous';
      const location = `${r.file}:${r.startLine}-${r.endLine}`;
      const scoreStr = (r.score * 100).toFixed(0);

      formatted += `${i + 1}. [${scoreStr}%] ${name} (${r.nodeType})\n`;
      formatted += `   Location: ${location}\n`;

      if (r.signature) {
        const sig = r.signature.length > 80 ? r.signature.slice(0, 77) + '...' : r.signature;
        formatted += `   Signature: ${sig}\n`;
      }

      // Show snippet
      const snippet = r.content.split('\n').slice(0, 5).join('\n');
      formatted += `   ---\n`;
      formatted += snippet.split('\n').map((line) => `   ${line}`).join('\n');
      formatted += '\n';

      // Show neighbors
      if (r.neighbors.length > 0) {
        formatted += `   Graph neighbors (${r.neighbors.length}):\n`;
        for (const n of r.neighbors.slice(0, 5)) {
          const dir = n.direction === 'outgoing' ? '->' : '<-';
          formatted += `     ${dir} ${n.edgeType}: ${n.symbolName || n.id} (${n.kind}) in ${n.file}\n`;
        }
        if (r.neighbors.length > 5) {
          formatted += `     ... and ${r.neighbors.length - 5} more\n`;
        }
      }
      formatted += '\n';
    }

    return formatted;
  }

  /**
   * Convert file path + line to chunk ID format.
   * Mirrors generateChunkId from chunker/index.ts.
   */
  private filePathToChunkId(filePath: string, startLine: number): string {
    const normalized = filePath
      .replace(/[\\/]/g, '_')
      .replace(/\./g, '_')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${normalized}_L${startLine}`;
  }

  /**
   * Format graph neighbors for output.
   */
  private formatNeighbors(
    neighbors: GraphNeighbor[],
    sourceId: string
  ): ContextQueryOutput['results'][0]['neighbors'] {
    return neighbors.map((n) => ({
      id: n.node.id,
      file: n.node.filePath,
      symbolName: n.node.symbolName,
      kind: n.node.kind,
      edgeType: n.edge.edgeType,
      direction: n.edge.sourceId === sourceId ? 'outgoing' as const : 'incoming' as const,
      depth: n.depth,
      weight: n.edge.weight,
    }));
  }
}
