/**
 * Tests for SessionManager: visit tracking, frontier, TTL, serialize/deserialize.
 */

import { SessionManager } from '../../src/graph/session.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(60_000); // 1 minute TTL for tests
  });

  afterEach(() => {
    manager.close();
  });

  describe('getSession', () => {
    it('should create a new session on first access', () => {
      const session = manager.getSession('test-session');
      expect(session.id).toBe('test-session');
      expect(session.visitedNodes.size).toBe(0);
      expect(session.frontier.size).toBe(0);
      expect(session.reasoningLog).toHaveLength(0);
    });

    it('should return existing session on subsequent access', () => {
      manager.visitNode('test-session', 'node1');
      const session = manager.getSession('test-session');
      expect(session.visitedNodes.has('node1')).toBe(true);
    });
  });

  describe('visitNode', () => {
    it('should track visited nodes', () => {
      manager.visitNode('s1', 'nodeA');
      manager.visitNode('s1', 'nodeB');

      const summary = manager.getSummary('s1');
      expect(summary.visitedCount).toBe(2);
    });

    it('should remove visited nodes from frontier', () => {
      manager.addToFrontier('s1', 'nodeA', 1.0);
      expect(manager.getSummary('s1').frontierCount).toBe(1);

      manager.visitNode('s1', 'nodeA');
      expect(manager.getSummary('s1').frontierCount).toBe(0);
    });

    it('should cap visited nodes at 10K', () => {
      for (let i = 0; i < 10_001; i++) {
        manager.visitNode('s1', `node${i}`);
      }
      const summary = manager.getSummary('s1');
      expect(summary.visitedCount).toBe(10_000);
    });
  });

  describe('addToFrontier', () => {
    it('should add nodes to frontier with priority', () => {
      manager.addToFrontier('s1', 'nodeA', 0.5);
      manager.addToFrontier('s1', 'nodeB', 0.8);

      const summary = manager.getSummary('s1');
      expect(summary.frontierCount).toBe(2);
      expect(summary.topFrontier[0]!.nodeId).toBe('nodeB'); // Higher priority first
    });

    it('should update priority if higher', () => {
      manager.addToFrontier('s1', 'nodeA', 0.5);
      manager.addToFrontier('s1', 'nodeA', 0.9); // Higher

      const summary = manager.getSummary('s1');
      expect(summary.topFrontier[0]!.priority).toBe(0.9);
    });

    it('should not downgrade priority', () => {
      manager.addToFrontier('s1', 'nodeA', 0.9);
      manager.addToFrontier('s1', 'nodeA', 0.3); // Lower

      const summary = manager.getSummary('s1');
      expect(summary.topFrontier[0]!.priority).toBe(0.9);
    });

    it('should not add already-visited nodes', () => {
      manager.visitNode('s1', 'nodeA');
      manager.addToFrontier('s1', 'nodeA', 1.0);

      const summary = manager.getSummary('s1');
      expect(summary.frontierCount).toBe(0);
    });
  });

  describe('addReasoning', () => {
    it('should add reasoning log entries', () => {
      manager.addReasoning('s1', 'Found main entry point');
      manager.addReasoning('s1', 'Exploring auth module');

      const summary = manager.getSummary('s1');
      expect(summary.reasoningCount).toBe(2);
      expect(summary.recentReasoning).toHaveLength(2);
    });

    it('should cap reasoning entries at 1K', () => {
      for (let i = 0; i < 1001; i++) {
        manager.addReasoning('s1', `Entry ${i}`);
      }
      const summary = manager.getSummary('s1');
      expect(summary.reasoningCount).toBe(1000);
    });
  });

  describe('annotate', () => {
    it('should set and get annotations', () => {
      manager.annotate('s1', 'nodeA', 'This handles auth');
      const annotation = manager.getAnnotation('s1', 'nodeA');
      expect(annotation).toBe('This handles auth');
    });

    it('should return undefined for missing annotations', () => {
      expect(manager.getAnnotation('s1', 'nonexistent')).toBeUndefined();
    });
  });

  describe('getSummary', () => {
    it('should return complete summary', () => {
      manager.visitNode('s1', 'nodeA');
      manager.addToFrontier('s1', 'nodeB', 0.5);
      manager.annotate('s1', 'nodeA', 'test');
      manager.addReasoning('s1', 'reasoning');

      const summary = manager.getSummary('s1');
      expect(summary.sessionId).toBe('s1');
      expect(summary.visitedCount).toBe(1);
      expect(summary.frontierCount).toBe(1);
      expect(summary.annotationCount).toBe(1);
      expect(summary.reasoningCount).toBe(1);
      expect(summary.ageMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('serialize/deserialize', () => {
    it('should round-trip session state', () => {
      manager.visitNode('s1', 'nodeA');
      manager.visitNode('s1', 'nodeB');
      manager.addToFrontier('s1', 'nodeC', 0.5);
      manager.annotate('s1', 'nodeA', 'important');
      manager.addReasoning('s1', 'test reasoning');

      const serialized = manager.serialize('s1');
      expect(serialized).toBeDefined();

      // Create new manager and restore
      const newManager = new SessionManager();
      newManager.deserialize(serialized!);

      const summary = newManager.getSummary('s1');
      expect(summary.visitedCount).toBe(2);
      expect(summary.frontierCount).toBe(1);
      expect(summary.annotationCount).toBe(1);
      expect(summary.reasoningCount).toBe(1);

      newManager.close();
    });

    it('should return undefined for non-existent session', () => {
      expect(manager.serialize('nonexistent')).toBeUndefined();
    });
  });

  describe('TTL cleanup', () => {
    it('should remove expired sessions', () => {
      // Create manager with very short TTL
      const shortManager = new SessionManager(1); // 1ms TTL
      shortManager.visitNode('s1', 'node');

      // Wait for expiry
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const removed = shortManager.cleanup();
          expect(removed).toBe(1);
          expect(shortManager.getActiveSessions()).toHaveLength(0);
          shortManager.close();
          resolve();
        }, 10);
      });
    });

    it('should not remove active sessions', () => {
      manager.visitNode('s1', 'node');
      const removed = manager.cleanup();
      expect(removed).toBe(0);
    });
  });

  describe('deleteSession', () => {
    it('should delete a specific session', () => {
      manager.visitNode('s1', 'node');
      expect(manager.deleteSession('s1')).toBe(true);
      expect(manager.getActiveSessions()).toHaveLength(0);
    });

    it('should return false for non-existent session', () => {
      expect(manager.deleteSession('nonexistent')).toBe(false);
    });
  });

  describe('getActiveSessions', () => {
    it('should list all active sessions', () => {
      manager.visitNode('s1', 'node');
      manager.visitNode('s2', 'node');
      expect(manager.getActiveSessions().sort()).toEqual(['s1', 's2']);
    });
  });
});
