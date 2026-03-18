// ============================================================
// src/client/event-buffer.ts — Buffers sensing events before agent init
// ============================================================

import type {
  Tile,
  RawSelfSensing,
  RawParcelSensing,
  RawAgentSensing,
  InterAgentMessage,
} from '../types.js';

export type BufferedEvent =
  | { kind: 'map'; tiles: ReadonlyArray<Tile>; width: number; height: number }
  | { kind: 'you'; self: RawSelfSensing }
  | { kind: 'parcels'; parcels: ReadonlyArray<RawParcelSensing> }
  | { kind: 'agents'; agents: ReadonlyArray<RawAgentSensing> }
  | { kind: 'message'; from: string; msg: InterAgentMessage };

/**
 * Buffers sensing events received before the agent's init() completes.
 * After init, the agent calls drain() to replay all buffered events
 * through the registered callbacks, then switches to pass-through mode.
 */
export class EventBuffer {
  private buffer: BufferedEvent[] = [];
  private drained = false;

  push(event: BufferedEvent): void {
    if (this.drained) return;
    this.buffer.push(event);
  }

  /**
   * Drain all buffered events through the provided handler.
   * After draining, the buffer is cleared and future push() calls are no-ops.
   */
  drain(handler: (event: BufferedEvent) => void): void {
    for (const event of this.buffer) {
      handler(event);
    }
    this.buffer = [];
    this.drained = true;
  }

  isDrained(): boolean {
    return this.drained;
  }

  size(): number {
    return this.buffer.length;
  }
}
