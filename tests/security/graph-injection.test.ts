/**
 * Security tests: SQL injection in chunk IDs and session IDs.
 */

import { GraphStore } from '../../src/graph/index.js';
import { SessionManager } from '../../src/graph/session.js';

describe('Graph SQL Injection Prevention', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore(':memory:');
    store.initialize();
  });

  afterEach(() => {
    store.close();
  });

  it('should safely handle special characters in node IDs via parameterized queries', () => {
    // better-sqlite3 uses parameterized queries, so these should not cause injection
    // but they should still work correctly (insert/retrieve)
    const node = {
      id: 'safe_id_L1',
      filePath: '/test/file.ts',
      symbolName: "test'; DROP TABLE graph_nodes;--",
      kind: 'function' as const,
      startLine: 1,
      endLine: 10,
      updatedAt: Date.now(),
      stale: false,
    };

    // Should not throw
    store.upsertNodes([node]);
    const retrieved = store.getNode('safe_id_L1');
    expect(retrieved).toBeDefined();
    // The malicious symbolName should be stored as-is (it's data, not SQL)
    expect(retrieved!.symbolName).toBe("test'; DROP TABLE graph_nodes;--");

    // Tables should still exist
    const counts = store.getCounts();
    expect(counts.nodes).toBe(1);
  });

  it('should safely handle special characters in file paths', () => {
    const node = {
      id: 'path_test_L1',
      filePath: "/test/'; DROP TABLE graph_nodes;--/file.ts",
      symbolName: 'test',
      kind: 'function' as const,
      startLine: 1,
      endLine: 10,
      updatedAt: Date.now(),
      stale: false,
    };

    store.upsertNodes([node]);

    // Delete by malicious path should not inject
    store.deleteByFile("/test/'; DROP TABLE graph_nodes;--/file.ts");
    const counts = store.getCounts();
    expect(counts.nodes).toBe(0);
  });

  it('should safely handle special characters in edge metadata', () => {
    store.upsertNodes([
      {
        id: 'a_L1',
        filePath: '/a.ts',
        symbolName: 'a',
        kind: 'function' as const,
        startLine: 1,
        endLine: 5,
        updatedAt: Date.now(),
        stale: false,
      },
      {
        id: 'b_L1',
        filePath: '/b.ts',
        symbolName: 'b',
        kind: 'function' as const,
        startLine: 1,
        endLine: 5,
        updatedAt: Date.now(),
        stale: false,
      },
    ]);

    store.upsertEdges([
      {
        sourceId: 'a_L1',
        targetId: 'b_L1',
        edgeType: 'calls',
        weight: 1.0,
        metadata: "'; DELETE FROM graph_edges;--",
      },
    ]);

    // Edge should be stored, tables intact
    const counts = store.getCounts();
    expect(counts.edges).toBe(1);
  });

  it('should safely handle special characters in metadata keys', () => {
    store.setMeta("'; DROP TABLE graph_meta;--", 'test');
    // Table should still work
    expect(store.getMeta("'; DROP TABLE graph_meta;--")).toBe('test');
  });
});

describe('Session ID Injection Prevention', () => {
  it('should safely handle special characters in session IDs', () => {
    const manager = new SessionManager();
    const maliciousId = "session'; DROP TABLE sessions;--";

    // Should not throw
    manager.visitNode(maliciousId, 'node1');
    const summary = manager.getSummary(maliciousId);
    expect(summary.visitedCount).toBe(1);

    manager.close();
  });

  it('should safely handle special characters in node annotations', () => {
    const manager = new SessionManager();

    manager.annotate('s1', 'node1', '<script>alert("xss")</script>');
    const annotation = manager.getAnnotation('s1', 'node1');
    expect(annotation).toBe('<script>alert("xss")</script>');

    manager.close();
  });
});
