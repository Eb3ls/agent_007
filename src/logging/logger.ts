import { stdout, stderr } from 'process';
import type { LogEvent, LogLevel } from '../types.js';
import type { RingBufferEntry } from './log-types.js';
import { LogRingBuffer } from './log-ring-buffer.js';

const ringBuffer = new LogRingBuffer(500);

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const isTTY = stdout.isTTY ?? false;
const C = {
  reset:  isTTY ? '\x1b[0m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red:    isTTY ? '\x1b[31m' : '',
};

export interface Logger {
  info(event: LogEvent): void;
  warn(event: LogEvent): void;
  error(event: LogEvent, err?: Error): void;
  debug(event: LogEvent): void;
}

export function createLogger(module: string, minLevel: LogLevel = 'debug'): Logger {
  const minRank = LEVEL_RANK[minLevel];

  function emit(level: LogLevel, event: LogEvent, err?: Error): void {
    ringBuffer.push({ ...event, module, ts: Date.now() });
    if (LEVEL_RANK[level] < minRank) return;
    writeLine(level, event, err);
  }

  return {
    info:  (event)       => emit('info',  event),
    warn:  (event)       => emit('warn',  event),
    error: (event, err?) => emit('error', event, err),
    debug: (event)       => emit('debug', event),
  };
}

// --- Output ---

function writeLine(level: LogLevel, event: LogEvent, err?: Error): void {
  const time = new Date().toTimeString().slice(0, 8);
  const lvl  = level.toUpperCase().padEnd(5);
  const kind = event.kind.padEnd(22);
  const body = formatExtras(event);
  const errSuffix = err ? ` — ${err.message}` : '';

  const color = level === 'warn' ? C.yellow : level === 'error' ? C.red : '';
  const line  = `${C.dim}${time}${C.reset} ${color}${lvl}${C.reset} ${kind} ${body}${errSuffix}\n`;

  (level === 'error' ? stderr : stdout).write(line);
}

function formatExtras(event: LogEvent): string {
  switch (event.kind) {
    case 'plan_failed':
      return `${event.plannerName} — ${event.error}`;
    case 'plan_generated':
      return `${event.plannerName} steps=${event.steps} ${event.timeMs}ms`;
    case 'replan_triggered':
      return `reason=${event.reason}`;
    case 'intention_set':
      return `${event.type} utility=${event.utility.toFixed(2)}`;
    case 'intention_dropped':
      return `reason=${event.reason}`;
    case 'score_update':
      return `score=${event.score}`;
    case 'stagnation_detected':
      return `idle=${event.secondsSinceLastScore}s`;
    case 'parcel_sensed':
      return `id=${event.parcelId.slice(0, 6)} pos=(${event.position.x},${event.position.y}) reward=${event.reward}`;
    case 'parcel_picked_up':
      return `id=${event.parcelId.slice(0, 6)}`;
    case 'parcel_delivered':
      return `id=${event.parcelId.slice(0, 6)} reward=${event.reward}`;
    case 'parcel_expired':
      return `id=${event.parcelId.slice(0, 6)}`;
    case 'action_sent':
      return `${event.action} (${event.position.x},${event.position.y})`;
    case 'action_result':
      return `${event.action} ${event.success ? 'ok' : 'FAIL'} ${event.durationMs}ms`;
    case 'belief_update':
      return `change=${event.changeType}`;
    case 'message_sent':
      return `${event.msgType} → ${event.to}`;
    case 'message_received':
      return `${event.msgType} ← ${event.from}`;
    case 'llm_call':
      return `${event.latencyMs}ms tokens=${event.tokensUsed}`;
    case 'llm_fallback':
      return `reason=${event.reason}`;
    case 'penalty':
      return `cause=${event.cause}`;
    case 'connection_lost':
    case 'connection_restored':
      return '';
  }
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
