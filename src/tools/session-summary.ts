/**
 * MCP tool: session_summary
 *
 * Returns the current state of an agent session: visited nodes,
 * frontier, stale node count, annotations, and reasoning log.
 *
 * @module tools/session-summary
 */

import { z } from 'zod';
import type { GraphStore } from '../graph/index.js';
import type { SessionManager, SessionSummary } from '../graph/session.js';

/**
 * Zod input schema for session_summary tool.
 */
export const SessionSummaryInputSchema = z.object({
  session_id: z.string().min(1).describe('Session ID to summarize'),
});

export type SessionSummaryInput = z.infer<typeof SessionSummaryInputSchema>;

/**
 * Output format for session_summary.
 */
export interface SessionSummaryOutput {
  session: SessionSummary;
  staleNodeCount: number;
  graphStats: {
    totalNodes: number;
    totalEdges: number;
    graphAvailable: boolean;
  };
}

/**
 * Session summary tool handler.
 */
export class SessionSummaryTool {
  private graphStore: GraphStore | null;
  private sessionManager: SessionManager;

  constructor(graphStore: GraphStore | null, sessionManager: SessionManager) {
    this.graphStore = graphStore;
    this.sessionManager = sessionManager;
  }

  /**
   * Execute session summary.
   */
  execute(input: z.input<typeof SessionSummaryInputSchema>): SessionSummaryOutput {
    const validated = SessionSummaryInputSchema.parse(input);

    const summary = this.sessionManager.getSummary(validated.session_id);

    let staleNodeCount = 0;
    let totalNodes = 0;
    let totalEdges = 0;
    const graphAvailable = this.graphStore?.isAvailable() ?? false;

    if (graphAvailable && this.graphStore) {
      const staleNodes = this.graphStore.getStaleNodes();
      staleNodeCount = staleNodes.length;
      const counts = this.graphStore.getCounts();
      totalNodes = counts.nodes;
      totalEdges = counts.edges;
    }

    return {
      session: summary,
      staleNodeCount,
      graphStats: {
        totalNodes,
        totalEdges,
        graphAvailable,
      },
    };
  }

  /**
   * Format results for display.
   */
  formatResults(output: SessionSummaryOutput): string {
    const s = output.session;
    let text = `Session: ${s.sessionId} (age: ${Math.round(s.ageMs / 1000)}s)\n`;
    text += `  Visited nodes: ${s.visitedCount}\n`;
    text += `  Frontier: ${s.frontierCount}\n`;
    text += `  Annotations: ${s.annotationCount}\n`;
    text += `  Reasoning entries: ${s.reasoningCount}\n`;

    if (output.graphStats.graphAvailable) {
      text += `\nGraph:\n`;
      text += `  Total nodes: ${output.graphStats.totalNodes}\n`;
      text += `  Total edges: ${output.graphStats.totalEdges}\n`;
      text += `  Stale nodes: ${output.staleNodeCount}\n`;
    } else {
      text += `\nGraph: not available\n`;
    }

    if (s.topFrontier.length > 0) {
      text += `\nTop frontier nodes:\n`;
      for (const f of s.topFrontier) {
        text += `  - ${f.nodeId} (priority: ${f.priority.toFixed(2)})\n`;
      }
    }

    if (s.recentReasoning.length > 0) {
      text += `\nRecent reasoning:\n`;
      for (const r of s.recentReasoning) {
        const time = new Date(r.timestamp).toISOString();
        text += `  [${time}] ${r.entry}\n`;
      }
    }

    return text;
  }
}
