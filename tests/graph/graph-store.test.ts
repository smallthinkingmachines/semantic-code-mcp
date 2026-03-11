/**
 * Tests for GraphStore CRUD, BFS traversal, cascading deletes, and stale detection.
 * Uses in-memory SQLite (:memory:) for fast, isolated tests.
 */

import { GraphStore } from '../../src/graph/index.js';
import type { GraphNode, GraphEdge } from '../../src/graph/types.js';

function createTestNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'test_node_L1',
    filePath: '/test/file.ts',
    symbolName: 'testFunction',
    kind: 'function',
    startLine: 1,
    endLine: 10,
    updatedAt: Date.now(),
    stale: false,
    ...overrides,
  };
}

function createTestEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    sourceId: 'node_a_L1',
    targetId: 'node_b_L1',
    edgeType: 'calls',
    weight: 1.0,
    metadata: null,
    ...overrides,
  };
}

describe('GraphStore', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore(':memory:');
    expect(store.initialize()).toBe(true);
  });

  afterEach(() => {
    store.close();
  });

  describe('initialization', () => {
    it('should initialize successfully with in-memory database', () => {
      expect(store.isAvailable()).toBe(true);
    });

    it('should return false for invalid database path', () => {
      const badStore = new GraphStore('/nonexistent/path/to/db.sqlite');
      expect(badStore.initialize()).toBe(false);
      expect(badStore.isAvailable()).toBe(false);
      badStore.close();
    });

    it('should be idempotent', () => {
      expect(store.initialize()).toBe(true);
      expect(store.initialize()).toBe(true);
    });
  });

  describe('upsertNodes', () => {
    it('should insert new nodes', () => {
      const node = createTestNode();
      store.upsertNodes([node]);

      const retrieved = store.getNode('test_node_L1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('test_node_L1');
      expect(retrieved!.symbolName).toBe('testFunction');
      expect(retrieved!.kind).toBe('function');
      expect(retrieved!.stale).toBe(false);
    });

    it('should update existing nodes on conflict', () => {
      const node = createTestNode();
      store.upsertNodes([node]);

      const updated = createTestNode({ symbolName: 'renamedFunction', stale: true });
      store.upsertNodes([updated]);

      const retrieved = store.getNode('test_node_L1');
      expect(retrieved!.symbolName).toBe('renamedFunction');
      expect(retrieved!.stale).toBe(true);
    });

    it('should handle empty array', () => {
      expect(() => store.upsertNodes([])).not.toThrow();
    });

    it('should batch insert multiple nodes', () => {
      const nodes = [
        createTestNode({ id: 'a_L1' }),
        createTestNode({ id: 'b_L1' }),
        createTestNode({ id: 'c_L1' }),
      ];
      store.upsertNodes(nodes);

      const counts = store.getCounts();
      expect(counts.nodes).toBe(3);
    });
  });

  describe('upsertEdges', () => {
    it('should insert edges between existing nodes', () => {
      store.upsertNodes([
        createTestNode({ id: 'node_a_L1' }),
        createTestNode({ id: 'node_b_L1' }),
      ]);

      const edge = createTestEdge();
      store.upsertEdges([edge]);

      const counts = store.getCounts();
      expect(counts.edges).toBe(1);
    });

    it('should update edge weight on conflict', () => {
      store.upsertNodes([
        createTestNode({ id: 'node_a_L1' }),
        createTestNode({ id: 'node_b_L1' }),
      ]);

      store.upsertEdges([createTestEdge({ weight: 0.5 })]);
      store.upsertEdges([createTestEdge({ weight: 0.9 })]);

      // Should have 1 edge (upserted), not 2
      const counts = store.getCounts();
      expect(counts.edges).toBe(1);
    });

    it('should handle empty array', () => {
      expect(() => store.upsertEdges([])).not.toThrow();
    });
  });

  describe('deleteByFile', () => {
    it('should delete nodes and edges for a file', () => {
      store.upsertNodes([
        createTestNode({ id: 'a_L1', filePath: '/test/a.ts' }),
        createTestNode({ id: 'b_L1', filePath: '/test/a.ts' }),
        createTestNode({ id: 'c_L1', filePath: '/test/b.ts' }),
      ]);
      store.upsertEdges([
        createTestEdge({ sourceId: 'a_L1', targetId: 'c_L1' }),
      ]);

      store.deleteByFile('/test/a.ts');

      const counts = store.getCounts();
      expect(counts.nodes).toBe(1); // Only c_L1 remains
      expect(counts.edges).toBe(0); // Edge deleted since source was deleted
    });

    it('should handle non-existent file', () => {
      expect(() => store.deleteByFile('/nonexistent.ts')).not.toThrow();
    });
  });

  describe('getNeighbors (BFS)', () => {
    beforeEach(() => {
      // Create a graph: A -> B -> C -> D, A -> E
      store.upsertNodes([
        createTestNode({ id: 'A', symbolName: 'A' }),
        createTestNode({ id: 'B', symbolName: 'B' }),
        createTestNode({ id: 'C', symbolName: 'C' }),
        createTestNode({ id: 'D', symbolName: 'D' }),
        createTestNode({ id: 'E', symbolName: 'E' }),
      ]);
      store.upsertEdges([
        createTestEdge({ sourceId: 'A', targetId: 'B', edgeType: 'calls' }),
        createTestEdge({ sourceId: 'B', targetId: 'C', edgeType: 'calls' }),
        createTestEdge({ sourceId: 'C', targetId: 'D', edgeType: 'calls' }),
        createTestEdge({ sourceId: 'A', targetId: 'E', edgeType: 'imports' }),
      ]);
    });

    it('should return depth-1 neighbors', () => {
      const neighbors = store.getNeighbors('A', 1);
      expect(neighbors).toHaveLength(2); // B and E
      expect(neighbors.map((n) => n.node.id).sort()).toEqual(['B', 'E']);
      expect(neighbors.every((n) => n.depth === 1)).toBe(true);
    });

    it('should return depth-2 neighbors', () => {
      const neighbors = store.getNeighbors('A', 2);
      expect(neighbors).toHaveLength(3); // B, E (depth 1), C (depth 2)
      const ids = neighbors.map((n) => n.node.id).sort();
      expect(ids).toEqual(['B', 'C', 'E']);
    });

    it('should return depth-3 neighbors', () => {
      const neighbors = store.getNeighbors('A', 3);
      expect(neighbors).toHaveLength(4); // B, E, C, D
    });

    it('should not visit same node twice', () => {
      // Add a cycle: D -> A
      store.upsertEdges([
        createTestEdge({ sourceId: 'D', targetId: 'A', edgeType: 'calls' }),
      ]);

      const neighbors = store.getNeighbors('A', 5);
      const ids = neighbors.map((n) => n.node.id);
      // Should not include A itself, and no duplicates
      expect(ids).not.toContain('A');
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should filter by edge kinds', () => {
      const neighbors = store.getNeighbors('A', 1, ['calls']);
      expect(neighbors).toHaveLength(1); // Only B (calls), not E (imports)
      expect(neighbors[0]!.node.id).toBe('B');
    });

    it('should follow incoming edges too', () => {
      const neighbors = store.getNeighbors('C', 1);
      // C has incoming from B and outgoing to D
      expect(neighbors).toHaveLength(2);
      expect(neighbors.map((n) => n.node.id).sort()).toEqual(['B', 'D']);
    });

    it('should return empty for isolated nodes', () => {
      store.upsertNodes([createTestNode({ id: 'isolated' })]);
      const neighbors = store.getNeighbors('isolated', 3);
      expect(neighbors).toHaveLength(0);
    });

    it('should clamp depth between 1 and 5', () => {
      const n0 = store.getNeighbors('A', 0); // Should be clamped to 1
      expect(n0.length).toBe(2); // Same as depth 1

      // depth 10 should be clamped to 5
      const n10 = store.getNeighbors('A', 10);
      expect(n10.length).toBe(4); // All reachable nodes
    });
  });

  describe('stale detection', () => {
    it('should mark nodes as stale', () => {
      store.upsertNodes([
        createTestNode({ id: 'a_L1', filePath: '/test/a.ts' }),
        createTestNode({ id: 'b_L1', filePath: '/test/a.ts' }),
        createTestNode({ id: 'c_L1', filePath: '/test/b.ts' }),
      ]);

      store.markFileStale('/test/a.ts');

      const stale = store.getStaleNodes();
      expect(stale).toHaveLength(2);
      expect(stale.map((n) => n.id).sort()).toEqual(['a_L1', 'b_L1']);
    });

    it('should return empty when no stale nodes', () => {
      store.upsertNodes([createTestNode()]);
      expect(store.getStaleNodes()).toHaveLength(0);
    });
  });

  describe('getSymbolIndex', () => {
    it('should return symbol-to-node mapping', () => {
      store.upsertNodes([
        createTestNode({ id: 'a_L1', symbolName: 'foo', filePath: '/a.ts' }),
        createTestNode({ id: 'b_L1', symbolName: 'foo', filePath: '/b.ts' }),
        createTestNode({ id: 'c_L1', symbolName: 'bar', filePath: '/a.ts' }),
      ]);

      const index = store.getSymbolIndex();
      expect(index.get('foo')).toHaveLength(2);
      expect(index.get('bar')).toHaveLength(1);
    });

    it('should exclude nodes without symbol names', () => {
      store.upsertNodes([
        createTestNode({ id: 'a_L1', symbolName: null }),
      ]);

      const index = store.getSymbolIndex();
      expect(index.size).toBe(0);
    });
  });

  describe('metadata', () => {
    it('should set and get metadata', () => {
      store.setMeta('version', '1.0');
      expect(store.getMeta('version')).toBe('1.0');
    });

    it('should update existing metadata', () => {
      store.setMeta('version', '1.0');
      store.setMeta('version', '2.0');
      expect(store.getMeta('version')).toBe('2.0');
    });

    it('should return undefined for missing keys', () => {
      expect(store.getMeta('nonexistent')).toBeUndefined();
    });
  });

  describe('getCounts', () => {
    it('should return zero counts for empty store', () => {
      const counts = store.getCounts();
      expect(counts.nodes).toBe(0);
      expect(counts.edges).toBe(0);
    });
  });

  describe('close', () => {
    it('should close cleanly', () => {
      store.close();
      expect(store.isAvailable()).toBe(false);
    });

    it('should be idempotent', () => {
      store.close();
      expect(() => store.close()).not.toThrow();
    });
  });
});
