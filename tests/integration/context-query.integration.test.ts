/**
 * Integration test: end-to-end context_query with search + graph expansion.
 *
 * Note: This test requires tree-sitter and embedding models to be available.
 * It will be skipped in environments where these are not set up.
 */

import { GraphStore } from '../../src/graph/index.js';
import { SessionManager } from '../../src/graph/session.js';
import type { GraphConfig } from '../../src/graph/config.js';
import type { GraphNode, GraphEdge } from '../../src/graph/types.js';

describe('Context Query Integration', () => {
  let graphStore: GraphStore;
  let sessionManager: SessionManager;

  beforeEach(() => {
    graphStore = new GraphStore(':memory:');
    graphStore.initialize();
    sessionManager = new SessionManager(60_000);
  });

  afterEach(() => {
    sessionManager.close();
    graphStore.close();
  });

  it('should return graph neighbors for nodes', () => {
    // Set up graph with known relationships
    const nodes: GraphNode[] = [
      {
        id: 'auth_ts_L1',
        filePath: '/project/src/auth.ts',
        symbolName: 'authenticate',
        kind: 'function',
        startLine: 1,
        endLine: 20,
        updatedAt: Date.now(),
        stale: false,
      },
      {
        id: 'db_ts_L1',
        filePath: '/project/src/db.ts',
        symbolName: 'queryUser',
        kind: 'function',
        startLine: 1,
        endLine: 15,
        updatedAt: Date.now(),
        stale: false,
      },
      {
        id: 'api_ts_L1',
        filePath: '/project/src/api.ts',
        symbolName: 'handleLogin',
        kind: 'function',
        startLine: 1,
        endLine: 30,
        updatedAt: Date.now(),
        stale: false,
      },
    ];

    const edges: GraphEdge[] = [
      {
        sourceId: 'auth_ts_L1',
        targetId: 'db_ts_L1',
        edgeType: 'calls',
        weight: 1.0,
        metadata: null,
      },
      {
        sourceId: 'api_ts_L1',
        targetId: 'auth_ts_L1',
        edgeType: 'calls',
        weight: 0.8,
        metadata: null,
      },
    ];

    graphStore.upsertNodes(nodes);
    graphStore.upsertEdges(edges);

    // Query neighbors of authenticate
    const neighbors = graphStore.getNeighbors('auth_ts_L1', 1);
    expect(neighbors).toHaveLength(2); // queryUser and handleLogin
    expect(neighbors.map((n) => n.node.symbolName).sort()).toEqual([
      'handleLogin',
      'queryUser',
    ]);
  });

  it('should track session state during exploration', () => {
    const nodes: GraphNode[] = [
      {
        id: 'a_L1',
        filePath: '/a.ts',
        symbolName: 'a',
        kind: 'function',
        startLine: 1,
        endLine: 10,
        updatedAt: Date.now(),
        stale: false,
      },
      {
        id: 'b_L1',
        filePath: '/b.ts',
        symbolName: 'b',
        kind: 'function',
        startLine: 1,
        endLine: 10,
        updatedAt: Date.now(),
        stale: false,
      },
    ];

    graphStore.upsertNodes(nodes);
    graphStore.upsertEdges([
      {
        sourceId: 'a_L1',
        targetId: 'b_L1',
        edgeType: 'calls',
        weight: 1.0,
        metadata: null,
      },
    ]);

    // Simulate agent workflow
    sessionManager.visitNode('session1', 'a_L1');

    const neighbors = graphStore.getNeighbors('a_L1', 1);
    for (const n of neighbors) {
      sessionManager.addToFrontier('session1', n.node.id, n.edge.weight);
    }

    const summary = sessionManager.getSummary('session1');
    expect(summary.visitedCount).toBe(1);
    expect(summary.frontierCount).toBe(1);
    expect(summary.topFrontier[0]!.nodeId).toBe('b_L1');
  });

  it('should detect stale nodes after file changes', () => {
    graphStore.upsertNodes([
      {
        id: 'old_L1',
        filePath: '/changed.ts',
        symbolName: 'oldFn',
        kind: 'function',
        startLine: 1,
        endLine: 10,
        updatedAt: Date.now(),
        stale: false,
      },
    ]);

    graphStore.markFileStale('/changed.ts');
    const stale = graphStore.getStaleNodes();
    expect(stale).toHaveLength(1);
    expect(stale[0]!.id).toBe('old_L1');
  });
});
