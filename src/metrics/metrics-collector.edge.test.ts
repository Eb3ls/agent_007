// ============================================================
// src/metrics/metrics-collector.edge.test.ts — Edge cases for MetricsCollector
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from './metrics-collector.js';

describe('MetricsCollector — edge cases', () => {

  // --- stop() without start() ---

  it('stop() without start() does not throw', () => {
    const mc = new MetricsCollector('bdi');
    assert.doesNotThrow(() => mc.stop());
  });

  it('snapshot() before start() returns sessionDurationMs = 0', () => {
    const mc = new MetricsCollector('bdi');
    const snap = mc.snapshot();
    assert.equal(snap.sessionDurationMs, 0);
  });

  it('stop() without start() still adds a score sample', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordScore(77);
    mc.stop();
    const snap = mc.snapshot();
    // stop() calls _takeSample(), so there should be at least one entry
    assert.ok(snap.scoreTimeline.length >= 1);
    assert.equal(snap.scoreTimeline[snap.scoreTimeline.length - 1]!.score, 77);
  });

  // --- stop() called twice ---

  it('stop() called twice does not throw and adds a second sample', () => {
    const mc = new MetricsCollector('bdi', 60_000);
    mc.start();
    mc.recordScore(10);
    mc.stop();
    mc.recordScore(20);
    assert.doesNotThrow(() => mc.stop());

    const snap = mc.snapshot();
    // start() + first stop() + second stop() = at least 3 samples
    assert.ok(snap.scoreTimeline.length >= 3);
    assert.equal(snap.scoreTimeline[snap.scoreTimeline.length - 1]!.score, 20);
  });

  it('calling stop() twice does not restart the interval timer', () => {
    // If stop() cleared the timer and is called again, clearInterval(null) should be safe
    const mc = new MetricsCollector('bdi');
    mc.start();
    mc.stop();
    // Second stop should clear a null timer (already cleared) without error
    assert.doesNotThrow(() => mc.stop());
  });

  // --- recordScore edge values ---

  it('recordScore(0) is tracked correctly', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordScore(0);
    assert.equal(mc.snapshot().finalScore, 0);
  });

  it('recordScore with negative value is stored without clamping', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordScore(-100);
    assert.equal(mc.snapshot().finalScore, -100);
  });

  it('recordScore updates overwrite the previous value', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordScore(50);
    mc.recordScore(75);
    mc.recordScore(30);
    assert.equal(mc.snapshot().finalScore, 30);
  });

  // --- recordPlannerCall edge values ---

  it('recordPlannerCall with latencyMs=0 produces avgLatencyMs=0', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordPlannerCall('bfs', 0, true);
    const snap = mc.snapshot();
    assert.equal(snap.plannerCalls['bfs']!.avgLatencyMs, 0);
    assert.equal(snap.plannerCalls['bfs']!.failures, 0);
  });

  it('recordPlannerCall with all failures computes correct failure count', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordPlannerCall('pddl', 100, false);
    mc.recordPlannerCall('pddl', 200, false);
    mc.recordPlannerCall('pddl', 300, false);
    const snap = mc.snapshot();
    assert.equal(snap.plannerCalls['pddl']!.count, 3);
    assert.equal(snap.plannerCalls['pddl']!.failures, 3);
    assert.equal(snap.plannerCalls['pddl']!.avgLatencyMs, 200);
  });

  it('plannerCalls for unknown planner is absent from snapshot', () => {
    const mc = new MetricsCollector('bdi');
    const snap = mc.snapshot();
    assert.equal(snap.plannerCalls['nonexistent'], undefined);
  });

  // --- recordLlmCall edge values ---

  it('recordLlmCall with tokensUsed=0 does not corrupt totals', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordLlmCall(100, 0, false);
    const snap = mc.snapshot();
    assert.ok(snap.llmCalls !== undefined);
    assert.equal(snap.llmCalls!.totalTokensUsed, 0);
    assert.equal(snap.llmCalls!.avgLatencyMs, 100);
  });

  it('recordLlmCall with latencyMs=0 computes avgLatencyMs=0', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordLlmCall(0, 500, false);
    assert.equal(mc.snapshot().llmCalls!.avgLatencyMs, 0);
  });

  it('multiple LLM calls correctly accumulate tokens and fallbacks', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordLlmCall(50,  100, false);
    mc.recordLlmCall(150, 200, true);
    mc.recordLlmCall(100, 300, true);
    const { llmCalls } = mc.snapshot();
    assert.ok(llmCalls !== undefined);
    assert.equal(llmCalls!.count, 3);
    assert.equal(llmCalls!.totalTokensUsed, 600);
    assert.equal(llmCalls!.fallbackCount, 2);
    // avg = (50+150+100)/3 = 100
    assert.ok(Math.abs(llmCalls!.avgLatencyMs - 100) < 1e-10);
  });

  // --- Multiple distinct penalty causes ---

  it('each unique penalty cause is counted separately', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordPenalty('collision');
    mc.recordPenalty('collision');
    mc.recordPenalty('timeout');
    mc.recordPenalty('out-of-bounds');
    const snap = mc.snapshot();
    assert.equal(snap.penaltiesReceived, 4);
    assert.equal(snap.penaltyCauses['collision'], 2);
    assert.equal(snap.penaltyCauses['timeout'], 1);
    assert.equal(snap.penaltyCauses['out-of-bounds'], 1);
  });

  // --- Role propagated to snapshot ---

  it('snapshot reflects the role passed to constructor', () => {
    const mc = new MetricsCollector('llm');
    assert.equal(mc.snapshot().role, 'llm');
  });

  // --- scoreTimeline integrity ---

  it('scoreTimeline entries are monotonically increasing in time', async () => {
    const mc = new MetricsCollector('bdi', 1); // 1ms interval to force multiple samples
    mc.start();
    // Give the interval a couple of ticks to fire
    await new Promise(r => setTimeout(r, 20));
    mc.stop();
    const { scoreTimeline } = mc.snapshot();
    for (let i = 1; i < scoreTimeline.length; i++) {
      assert.ok(
        scoreTimeline[i]!.t >= scoreTimeline[i - 1]!.t,
        `sample ${i} time must be >= sample ${i - 1}`,
      );
    }
  });

  it('snapshot() can be called multiple times without mutating internal state', () => {
    const mc = new MetricsCollector('bdi');
    mc.recordScore(42);
    mc.start();
    mc.stop();
    const snap1 = mc.snapshot();
    mc.recordScore(99);
    const snap2 = mc.snapshot();
    // snap1 must not be mutated retroactively
    assert.equal(snap1.finalScore, 42);
    assert.equal(snap2.finalScore, 99);
  });
});
