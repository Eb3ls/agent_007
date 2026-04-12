// ============================================================
// src/deliberation/stagnation-monitor.ts — Standalone stagnation detector
// Emits a callback when no score increase is observed within timeoutMs.
// Replaces the inline stagnation check in bdi-agent/llm-agent (Problem 6 CODEBASE).
// ============================================================

export interface StagnationMonitorOptions {
  /** How many ms without a score increase before declaring stagnation. */
  timeoutMs: number;
  /** How often to poll (default: 1000ms). Should be <= timeoutMs. */
  checkIntervalMs?: number;
  /** Called when stagnation is detected; receives ms elapsed since last score increase. */
  onStagnation: (elapsedMs: number) => void;
}

/**
 * Tracks score progress and fires onStagnation when no increase is seen
 * for longer than timeoutMs. After firing, resets its internal clock to
 * avoid repeated callbacks on every subsequent check interval.
 *
 * R22: stagnation leads to penalty accumulation if the agent keeps retrying
 * the same blocked path; detecting it early allows the agent to replan.
 */
export class StagnationMonitor {
  private readonly timeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly onStagnation: (elapsedMs: number) => void;
  private lastScoreIncreasedAt = Date.now();
  private lastScore = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: StagnationMonitorOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.checkIntervalMs = opts.checkIntervalMs ?? 1_000;
    this.onStagnation = opts.onStagnation;
  }

  /** Call whenever a new score value is received (e.g. from the 'you' event). */
  notifyScore(score: number): void {
    if (score > this.lastScore) {
      this.lastScore = score;
      this.lastScoreIncreasedAt = Date.now();
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.lastScoreIncreasedAt = Date.now(); // reset clock on start
    this.timer = setInterval(() => {
      const elapsed = Date.now() - this.lastScoreIncreasedAt;
      if (elapsed >= this.timeoutMs) {
        this.onStagnation(elapsed);
        // Reset to avoid firing every check interval after a single stagnation event
        this.lastScoreIncreasedAt = Date.now();
      }
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
