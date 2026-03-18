export { LogEvent, LogLevel } from '../types.js';

/** A LogEvent augmented with metadata for the ring buffer. */
export interface RingBufferEntry {
  readonly kind: string;
  readonly module: string;
  readonly ts: number;
  readonly [key: string]: unknown;
}
