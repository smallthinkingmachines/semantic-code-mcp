/**
 * Edge resolver: resolves raw symbol-based edges to concrete chunk ID edges.
 *
 * Takes RawEdge entries (symbol names) and resolves them against the symbol
 * index to produce GraphEdge entries with concrete source/target chunk IDs.
 *
 * @module graph/extractor
 */

import type { RawEdge, GraphEdge } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('graph-extractor');

/**
 * Resolve raw edges (symbol names) to concrete graph edges (chunk IDs).
 *
 * Resolution strategy:
 * - Same-file matches get weight 1.0
 * - Cross-file matches get weight 0.8
 * - Ambiguous matches (multiple candidates) use the same-file candidate if available
 * - Unresolvable edges are dropped
 *
 * @param rawEdges - Edges with symbol names from AST extraction
 * @param symbolIndex - Map of symbol names to chunk ID/file path pairs
 * @returns Resolved graph edges
 */
export function resolveEdges(
  rawEdges: RawEdge[],
  symbolIndex: Map<string, Array<{ id: string; filePath: string }>>
): GraphEdge[] {
  const resolved: GraphEdge[] = [];
  let droppedCount = 0;

  for (const raw of rawEdges) {
    const candidates = symbolIndex.get(raw.targetSymbol);

    if (!candidates || candidates.length === 0) {
      droppedCount++;
      continue;
    }

    // Prefer same-file matches
    const sameFile = candidates.find((c) => c.filePath === raw.sourceFilePath);
    if (sameFile) {
      // Don't create self-referencing edges
      if (sameFile.id !== raw.sourceChunkId) {
        resolved.push({
          sourceId: raw.sourceChunkId,
          targetId: sameFile.id,
          edgeType: raw.edgeType,
          weight: 1.0,
          metadata: raw.modulePath || null,
        });
      }
      continue;
    }

    // Cross-file: use first candidate (or could pick best match)
    const target = candidates[0]!;
    if (target.id !== raw.sourceChunkId) {
      resolved.push({
        sourceId: raw.sourceChunkId,
        targetId: target.id,
        edgeType: raw.edgeType,
        weight: 0.8,
        metadata: raw.modulePath || raw.targetSymbol,
      });
    }
  }

  if (droppedCount > 0) {
    log.debug('Edge resolution complete', {
      total: rawEdges.length,
      resolved: resolved.length,
      dropped: droppedCount,
    });
  }

  return resolved;
}
