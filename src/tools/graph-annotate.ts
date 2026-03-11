/**
 * MCP tool: graph_annotate
 *
 * Allows agents to write notes on graph nodes and create
 * agent_linked edges between chunks.
 *
 * @module tools/graph-annotate
 */

import { z } from 'zod';
import type { GraphStore } from '../graph/index.js';
import type { SessionManager } from '../graph/session.js';
import type { GraphEdge } from '../graph/types.js';

/**
 * Zod input schema for graph_annotate tool.
 */
export const GraphAnnotateInputSchema = z.object({
  session_id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'Session ID contains invalid characters').describe('Session ID for the annotation'),
  node_id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'Node ID contains invalid characters').describe('Chunk ID to annotate'),
  note: z.string().optional().describe('Note to attach to the node'),
  link_to: z
    .array(z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Link target ID contains invalid characters'))
    .optional()
    .describe('Array of chunk IDs to create agent_linked edges to'),
  reasoning: z.string().optional().describe('Reasoning log entry about why this annotation matters'),
});

export type GraphAnnotateInput = z.infer<typeof GraphAnnotateInputSchema>;

/**
 * Output format for graph_annotate.
 */
export interface GraphAnnotateOutput {
  annotated: boolean;
  nodeId: string;
  note: string | null;
  linksCreated: number;
  sessionVisitedCount: number;
}

/**
 * Graph annotate tool handler.
 */
export class GraphAnnotateTool {
  private graphStore: GraphStore | null;
  private sessionManager: SessionManager;

  constructor(graphStore: GraphStore | null, sessionManager: SessionManager) {
    this.graphStore = graphStore;
    this.sessionManager = sessionManager;
  }

  /**
   * Execute graph annotation.
   */
  execute(input: z.input<typeof GraphAnnotateInputSchema>): GraphAnnotateOutput {
    const validated = GraphAnnotateInputSchema.parse(input);

    // Record visit
    this.sessionManager.visitNode(validated.session_id, validated.node_id);

    // Set annotation
    if (validated.note) {
      this.sessionManager.annotate(validated.session_id, validated.node_id, validated.note);
    }

    // Add reasoning
    if (validated.reasoning) {
      this.sessionManager.addReasoning(validated.session_id, validated.reasoning);
    }

    // Create agent_linked edges
    let linksCreated = 0;
    if (validated.link_to && this.graphStore?.isAvailable()) {
      const edges: GraphEdge[] = validated.link_to
        .filter((targetId) => targetId !== validated.node_id)
        .map((targetId) => ({
          sourceId: validated.node_id,
          targetId,
          edgeType: 'agent_linked' as const,
          weight: 1.0,
          metadata: validated.note || null,
        }));

      if (edges.length > 0) {
        this.graphStore.upsertEdges(edges);
        linksCreated = edges.length;
      }
    }

    const summary = this.sessionManager.getSummary(validated.session_id);

    return {
      annotated: true,
      nodeId: validated.node_id,
      note: validated.note || null,
      linksCreated,
      sessionVisitedCount: summary.visitedCount,
    };
  }

  /**
   * Format results for display.
   */
  formatResults(output: GraphAnnotateOutput): string {
    let text = `Annotated node: ${output.nodeId}`;
    if (output.note) {
      text += `\nNote: ${output.note}`;
    }
    if (output.linksCreated > 0) {
      text += `\nCreated ${output.linksCreated} agent_linked edge(s)`;
    }
    text += `\nSession visited nodes: ${output.sessionVisitedCount}`;
    return text;
  }
}
