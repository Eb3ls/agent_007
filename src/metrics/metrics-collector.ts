// ============================================================
// src/metrics/metrics-collector.ts — Metrics Collector (T19)
// Collects agent runtime metrics and exports a snapshot on shutdown.
// ============================================================

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { AgentRole, MetricsSnapshot } from '../types.js';

interface PlannerAccum {
  count: number;
  totalLatencyMs: number;
  failures: number;
}

export class MetricsCollector {
  private startedAt = 0;
  private agentId = '';
  private readonly role: AgentRole;
  private readonly sampleIntervalMs: number;

  private currentScore = 0;
  private scoreTimeline: Array<{ t: number; score: number }> = [];
  private parcelsDelivered = 0;
  private parcelsMissed = 0;
  private penaltiesReceived = 0;
  private penaltyCauses: Record<string, number> = {};

  private plannerAccum: Record<string, PlannerAccum> = {};
  private llmAccum = { count: 0, totalLatencyMs: 0, totalTokens: 0, fallbackCount: 0 };
  private hasLlmCalls = false;
  private stagnationsDetected = 0;

  private sampleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(role: AgentRole, sampleIntervalMs = 5_000) {
    this.role = role;
    this.sampleIntervalMs = sampleIntervalMs;
  }

  setAgentId(id: string): void {
    this.agentId = id;
  }

  start(): void {
    this.startedAt = Date.now();
    this._takeSample();
    this.sampleTimer = setInterval(() => this._takeSample(), this.sampleIntervalMs);
    this.sampleTimer.unref();
  }

  stop(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this._takeSample();
  }

  recordScore(score: number): void {
    this.currentScore = score;
  }

  recordParcelDelivered(_reward: number): void {
    this.parcelsDelivered++;
  }

  recordParcelMissed(): void {
    this.parcelsMissed++;
  }

  recordPenalty(cause: string): void {
    this.penaltiesReceived++;
    this.penaltyCauses[cause] = (this.penaltyCauses[cause] ?? 0) + 1;
  }

  recordPlannerCall(plannerName: string, latencyMs: number, success: boolean): void {
    if (!this.plannerAccum[plannerName]) {
      this.plannerAccum[plannerName] = { count: 0, totalLatencyMs: 0, failures: 0 };
    }
    const acc = this.plannerAccum[plannerName]!;
    acc.count++;
    acc.totalLatencyMs += latencyMs;
    if (!success) acc.failures++;
  }

  recordStagnation(): void {
    this.stagnationsDetected++;
  }

  recordLlmCall(latencyMs: number, tokensUsed: number, wasFallback: boolean): void {
    this.hasLlmCalls = true;
    this.llmAccum.count++;
    this.llmAccum.totalLatencyMs += latencyMs;
    this.llmAccum.totalTokens += tokensUsed;
    if (wasFallback) this.llmAccum.fallbackCount++;
  }

  snapshot(): MetricsSnapshot {
    const now = Date.now();

    const plannerCalls: MetricsSnapshot['plannerCalls'] = {};
    for (const [name, acc] of Object.entries(this.plannerAccum)) {
      plannerCalls[name] = {
        count: acc.count,
        avgLatencyMs: acc.count > 0 ? acc.totalLatencyMs / acc.count : 0,
        failures: acc.failures,
      };
    }

    return {
      agentId:           this.agentId,
      role:              this.role,
      sessionStartedAt:  this.startedAt,
      sessionDurationMs: this.startedAt > 0 ? now - this.startedAt : 0,
      finalScore:        this.currentScore,
      scoreTimeline:     [...this.scoreTimeline],
      parcelsDelivered:  this.parcelsDelivered,
      parcelsMissed:     this.parcelsMissed,
      penaltiesReceived: this.penaltiesReceived,
      penaltyCauses:     { ...this.penaltyCauses },
      plannerCalls,
      ...(this.hasLlmCalls ? {
        llmCalls: {
          count:           this.llmAccum.count,
          avgLatencyMs:    this.llmAccum.count > 0
            ? this.llmAccum.totalLatencyMs / this.llmAccum.count
            : 0,
          totalTokensUsed: this.llmAccum.totalTokens,
          fallbackCount:   this.llmAccum.fallbackCount,
        },
      } : {}),
      ...(this.stagnationsDetected > 0 ? { stagnationsDetected: this.stagnationsDetected } : {}),
    };
  }

  async exportJson(filePath: string): Promise<void> {
    const snap = this.snapshot();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(snap, null, 2), 'utf-8');
  }

  private _takeSample(): void {
    this.scoreTimeline.push({ t: Date.now(), score: this.currentScore });
  }
}
