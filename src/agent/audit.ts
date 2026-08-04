/**
 * Append-only audit trail for every step the agent takes.
 *
 *  - Durable: each AgentEvent is appended as one JSON line to data/audit.jsonl.
 *  - Queryable: the last RING_MAX events are kept in memory (getRecent()).
 *  - Live: subscribe(cb) feeds the SSE endpoint in src/agent/index.ts.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentEvent } from "../types.js";

const RING_MAX = 500;

/** JSON.stringify that survives bigints (serialized as decimal strings). */
export function stringifyEvent(event: AgentEvent): string {
  return JSON.stringify(event, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export class AuditLog {
  private readonly filePath: string;
  private readonly ring: AgentEvent[] = [];
  private readonly subscribers = new Set<(event: AgentEvent) => void>();

  constructor(filePath = "data/audit.jsonl") {
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** Append to the JSONL file, the in-memory ring, and notify subscribers. */
  append(event: AgentEvent): void {
    try {
      appendFileSync(this.filePath, stringifyEvent(event) + "\n", "utf8");
    } catch (err) {
      // Never let audit I/O take the agent down — the ring/SSE still get the event.
      console.error(`audit: failed to append to ${this.filePath}:`, err);
    }
    this.ring.push(event);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch (err) {
        console.error("audit: subscriber threw:", err);
      }
    }
  }

  /** Register a live listener (used by the SSE endpoint). Returns an unsubscribe fn. */
  subscribe(cb: (event: AgentEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Most recent events (up to `limit`, capped at the ring size of 500), oldest first. */
  getRecent(limit = RING_MAX): AgentEvent[] {
    return this.ring.slice(-Math.max(0, limit));
  }
}
