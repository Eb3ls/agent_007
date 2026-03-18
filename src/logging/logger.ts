import pino from 'pino';
import type { LogEvent, LogLevel } from '../types.js';
import type { RingBufferEntry } from './log-types.js';
import { LogRingBuffer } from './log-ring-buffer.js';

const ringBuffer = new LogRingBuffer(500);

const baseLogger = pino({
  level: 'debug',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export interface Logger {
  info(event: LogEvent): void;
  warn(event: LogEvent): void;
  error(event: LogEvent, err?: Error): void;
  debug(event: LogEvent): void;
}

export function createLogger(module: string, level?: LogLevel): Logger {
  const child = baseLogger.child({ module });
  if (level) child.level = level;

  const log = (pinoMethod: pino.LogFn, event: LogEvent, err?: Error): void => {
    ringBuffer.push({ ...event, module, ts: Date.now() });
    if (err) {
      pinoMethod.call(child, { event: event.kind, ...event, err }, event.kind);
    } else {
      pinoMethod.call(child, { event: event.kind, ...event }, event.kind);
    }
  };

  return {
    info:  (event) => log(child.info, event),
    warn:  (event) => log(child.warn, event),
    error: (event, err?) => log(child.error, event, err),
    debug: (event) => log(child.debug, event),
  };
}

// --- LLM Context ---

/**
 * Returns a compact JSON string suitable for pasting into an LLM prompt.
 */
export function getLlmContext(options: {
  lastNSeconds?: number;
  lastNEvents?: number;
  kinds?: ReadonlyArray<string>;
  summarizeMovement?: boolean;
}): string {
  let events = ringBuffer.query(options);
  if (options.summarizeMovement !== false) {
    events = summarizeMovements(events);
  }
  // Reset relative-time epoch for each context generation
  let epoch = 0;
  return JSON.stringify(events.map(e => compactify(e, (ts) => {
    if (epoch === 0) epoch = ts;
    return Math.round((ts - epoch) / 100) / 10;
  })));
}

// --- Movement Summarization ---

function isMovementEvent(entry: RingBufferEntry): boolean {
  return (
    (entry.kind === 'action_sent' || entry.kind === 'action_result') &&
    typeof entry.action === 'string' &&
    (entry.action as string).startsWith('move_')
  );
}

function summarizeMovements(events: RingBufferEntry[]): RingBufferEntry[] {
  const result: RingBufferEntry[] = [];
  let i = 0;

  while (i < events.length) {
    if (!isMovementEvent(events[i])) {
      result.push(events[i]);
      i++;
      continue;
    }

    // Collect consecutive movement events
    const moveRun: RingBufferEntry[] = [];
    while (i < events.length && isMovementEvent(events[i])) {
      moveRun.push(events[i]);
      i++;
    }

    // Summarize: count per direction, compute timing
    const dirCounts = new Map<string, number>();
    for (const m of moveRun) {
      const dir = (m.action as string).replace('move_', '')[0].toUpperCase();
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    const dirString = [...dirCounts.entries()]
      .map(([d, n]) => n > 1 ? `${d}×${n}` : d)
      .join(' ');

    const totalMs = moveRun[moveRun.length - 1].ts - moveRun[0].ts;
    const avgMs = moveRun.length > 1 ? Math.round(totalMs / (moveRun.length - 1)) : 0;

    result.push({
      kind: 'move_summary',
      directions: dirString,
      count: moveRun.length,
      totalMs,
      avgMs,
      ts: moveRun[0].ts,
      module: moveRun[0].module,
    });
  }

  return result;
}

// --- Compactify for LLM context ---

const KIND_ABBREV: Record<string, string> = {
  action_sent: 'mv',
  action_result: 'mv_r',
  move_summary: 'mv',
  parcel_sensed: 'ps',
  parcel_picked_up: 'pk',
  parcel_delivered: 'pd',
  parcel_expired: 'px',
  intention_set: 'int',
  intention_dropped: 'int_d',
  plan_generated: 'plan',
  plan_failed: 'plan_f',
  replan_triggered: 'replan',
  belief_update: 'bel',
  message_sent: 'msg_s',
  message_received: 'msg_r',
  llm_call: 'llm',
  llm_fallback: 'llm_fb',
  penalty: 'pen',
  score_update: 'sc',
  connection_lost: 'dc',
  connection_restored: 'rc',
  stagnation_detected: 'stag',
};

function compactify(
  entry: RingBufferEntry,
  relSec: (ts: number) => number,
): Record<string, unknown> {
  const k = KIND_ABBREV[entry.kind] ?? entry.kind;

  switch (entry.kind) {
    case 'action_sent':
      return { k, d: dirAbbrev(entry.action as string), t: relSec(entry.ts) };

    case 'action_result':
      return { k, d: dirAbbrev(entry.action as string), ok: entry.success ? 1 : 0, ms: entry.durationMs, t: relSec(entry.ts) };

    case 'move_summary':
      return { k, d: entry.directions, n: entry.count, dt: entry.totalMs, avg: entry.avgMs };

    case 'parcel_sensed': {
      const pos = entry.position as { x: number; y: number };
      return { k, p: entry.parcelId, x: pos.x, y: pos.y, r: entry.reward, t: relSec(entry.ts) };
    }

    case 'parcel_picked_up':
      return { k, p: entry.parcelId, t: relSec(entry.ts) };

    case 'parcel_delivered':
      return { k, p: entry.parcelId, r: entry.reward, t: relSec(entry.ts) };

    case 'score_update':
      return { k, s: entry.score };

    case 'plan_generated':
      return { k, planner: entry.plannerName, steps: entry.steps, ms: entry.timeMs };

    case 'plan_failed':
      return { k, planner: entry.plannerName, err: entry.error };

    case 'penalty':
      return { k, cause: entry.cause };

    case 'llm_call':
      return { k, ms: entry.latencyMs, tok: entry.tokensUsed };

    default: {
      // Generic fallback: abbreviate kind, keep other fields minus module/ts
      const { kind: _, module: _m, ts: _t, ...rest } = entry;
      return { k, ...rest };
    }
  }
}

function dirAbbrev(action: string): string {
  return action.replace('move_', '')[0].toUpperCase();
}
