/**
 * Session memory for agent reasoning state.
 *
 * Tracks which nodes an agent has visited, maintains a frontier of
 * interesting nodes to explore, stores reasoning notes, and manages
 * per-node annotations. Sessions are TTL-based with periodic cleanup.
 *
 * @module graph/session
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('session');

/** Maximum visited nodes per session */
const MAX_VISITED_NODES = 10_000;
/** Maximum reasoning log entries per session */
const MAX_REASONING_ENTRIES = 1_000;
/** Cleanup interval for expired sessions */
const CLEANUP_INTERVAL_MS = 60_000; // 60 seconds

/**
 * State for a single agent session.
 */
export interface SessionState {
  /** Session identifier */
  id: string;
  /** Set of visited node IDs */
  visitedNodes: Set<string>;
  /** Frontier: node IDs the agent should explore next, with priority scores */
  frontier: Map<string, number>;
  /** Chronological reasoning log */
  reasoningLog: Array<{ timestamp: number; entry: string }>;
  /** Per-node annotations */
  annotations: Map<string, string>;
  /** When the session was created */
  createdAt: number;
  /** When the session was last accessed */
  lastAccessedAt: number;
}

/**
 * Serialized session state for transport.
 */
export interface SerializedSession {
  id: string;
  visitedNodes: string[];
  frontier: Array<{ nodeId: string; priority: number }>;
  reasoningLog: Array<{ timestamp: number; entry: string }>;
  annotations: Array<{ nodeId: string; note: string }>;
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * Session summary statistics.
 */
export interface SessionSummary {
  sessionId: string;
  visitedCount: number;
  frontierCount: number;
  annotationCount: number;
  reasoningCount: number;
  topFrontier: Array<{ nodeId: string; priority: number }>;
  recentReasoning: Array<{ timestamp: number; entry: string }>;
  ageMs: number;
}

/**
 * Manages agent sessions with TTL-based cleanup.
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number = 3600_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Start the periodic cleanup timer.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if the timer is running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the cleanup timer.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get or create a session.
   */
  getSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        visitedNodes: new Set(),
        frontier: new Map(),
        reasoningLog: [],
        annotations: new Map(),
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
      log.debug('Created new session', { sessionId });
    } else {
      session.lastAccessedAt = Date.now();
    }
    return session;
  }

  /**
   * Record that the agent visited a node.
   */
  visitNode(sessionId: string, nodeId: string): void {
    const session = this.getSession(sessionId);

    // Always remove from frontier when visiting, even if cap is reached
    session.frontier.delete(nodeId);

    if (session.visitedNodes.size >= MAX_VISITED_NODES) {
      log.warn('Session visited nodes cap reached', { sessionId, cap: MAX_VISITED_NODES });
      return;
    }

    session.visitedNodes.add(nodeId);
  }

  /**
   * Add a node to the frontier with a priority score.
   */
  addToFrontier(sessionId: string, nodeId: string, priority: number = 1.0): void {
    const session = this.getSession(sessionId);

    // Don't add already-visited nodes to frontier
    if (session.visitedNodes.has(nodeId)) return;

    // Update priority if higher
    const existing = session.frontier.get(nodeId);
    if (existing === undefined || priority > existing) {
      session.frontier.set(nodeId, priority);
    }
  }

  /**
   * Add a reasoning log entry.
   */
  addReasoning(sessionId: string, entry: string): void {
    const session = this.getSession(sessionId);

    if (session.reasoningLog.length >= MAX_REASONING_ENTRIES) {
      // Remove oldest entry
      session.reasoningLog.shift();
    }

    session.reasoningLog.push({ timestamp: Date.now(), entry });
  }

  /**
   * Set an annotation on a node.
   */
  annotate(sessionId: string, nodeId: string, note: string): void {
    const session = this.getSession(sessionId);
    session.annotations.set(nodeId, note);
  }

  /**
   * Get annotation for a node.
   */
  getAnnotation(sessionId: string, nodeId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session?.annotations.get(nodeId);
  }

  /**
   * Get a session summary.
   */
  getSummary(sessionId: string): SessionSummary {
    const session = this.getSession(sessionId);

    // Top frontier: sorted by priority descending, top 10
    const topFrontier = [...session.frontier.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([nodeId, priority]) => ({ nodeId, priority }));

    // Recent reasoning: last 10 entries
    const recentReasoning = session.reasoningLog.slice(-10);

    return {
      sessionId,
      visitedCount: session.visitedNodes.size,
      frontierCount: session.frontier.size,
      annotationCount: session.annotations.size,
      reasoningCount: session.reasoningLog.length,
      topFrontier,
      recentReasoning,
      ageMs: Date.now() - session.createdAt,
    };
  }

  /**
   * Serialize a session for transport.
   */
  serialize(sessionId: string): SerializedSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    return {
      id: session.id,
      visitedNodes: [...session.visitedNodes],
      frontier: [...session.frontier.entries()].map(([nodeId, priority]) => ({
        nodeId,
        priority,
      })),
      reasoningLog: [...session.reasoningLog],
      annotations: [...session.annotations.entries()].map(([nodeId, note]) => ({
        nodeId,
        note,
      })),
      createdAt: session.createdAt,
      lastAccessedAt: session.lastAccessedAt,
    };
  }

  /**
   * Restore a session from serialized state.
   */
  deserialize(data: SerializedSession): void {
    const session: SessionState = {
      id: data.id,
      visitedNodes: new Set(data.visitedNodes),
      frontier: new Map(data.frontier.map((f) => [f.nodeId, f.priority])),
      reasoningLog: [...data.reasoningLog],
      annotations: new Map(data.annotations.map((a) => [a.nodeId, a.note])),
      createdAt: data.createdAt,
      lastAccessedAt: Date.now(),
    };
    this.sessions.set(data.id, session);
  }

  /**
   * Remove expired sessions.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, session] of this.sessions) {
      if (now - session.lastAccessedAt > this.ttlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      log.debug('Cleaned up expired sessions', { removed });
    }

    return removed;
  }

  /**
   * Delete a specific session.
   */
  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Get all active session IDs.
   */
  getActiveSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Shut down the session manager.
   */
  close(): void {
    this.stopCleanup();
    this.sessions.clear();
  }
}
