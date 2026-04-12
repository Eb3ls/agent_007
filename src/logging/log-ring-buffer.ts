import type { RingBufferEntry } from './log-types.js';

export interface RingBufferQueryOptions {
  lastNSeconds?: number;
  lastNEvents?: number;
  kinds?: ReadonlyArray<string>;
}

/**
 * Fixed-capacity circular buffer that stores the most recent log events.
 * Older entries are silently overwritten when capacity is exceeded.
 */
export class LogRingBuffer {
  private readonly buffer: Array<RingBufferEntry | undefined>;
  private head = 0;   // next write position
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(entry: RingBufferEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /**
   * Query the buffer with optional filters.
   * Returns events in chronological order (oldest first).
   */
  query(options: RingBufferQueryOptions = {}): RingBufferEntry[] {
    const { lastNSeconds, lastNEvents, kinds } = options;

    // Read all entries in chronological order
    const start = this.count < this.capacity ? 0 : this.head;
    const entries: RingBufferEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry) entries.push(entry);
    }

    let result = entries;

    // Filter by time window
    if (lastNSeconds !== undefined) {
      const cutoff = Date.now() - lastNSeconds * 1000;
      result = result.filter(e => e.ts >= cutoff);
    }

    // Filter by event kinds
    if (kinds && kinds.length > 0) {
      const kindSet = new Set(kinds);
      result = result.filter(e => kindSet.has(e.kind));
    }

    // Limit to last N events (after other filters)
    if (lastNEvents !== undefined && result.length > lastNEvents) {
      result = result.slice(result.length - lastNEvents);
    }

    return result;
  }

  get size(): number {
    return this.count;
  }
}
