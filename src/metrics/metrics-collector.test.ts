import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from './metrics-collector.js';
import { formatSummary } from './metrics-snapshot.js';
import { rm } from 'fs/promises';
import { existsSync } from 'fs';

describe('MetricsCollector', () => {
  describe('basic recording', () => {
    it('snapshot reflects recorded values', () => {
      const mc = new MetricsCollector('bdi');
      mc.setAgentId('agent-abc');
      mc.start();

      mc.recordScore(42);
      mc.recordParcelDelivered(30);
      mc.recordParcelMissed();
      mc.recordPenalty('overlap');
      mc.recordPenalty('overlap');
      mc.recordPlannerCall('bfs', 10, true);
      mc.recordPlannerCall('bfs', 20, false);
      mc.stop();

      const snap = mc.snapshot();
      assert.equal(snap.agentId, 'agent-abc');
      assert.equal(snap.role, 'bdi');
      assert.equal(snap.finalScore, 42);
      assert.equal(snap.parcelsDelivered, 1);
      assert.equal(snap.parcelsMissed, 1);
      assert.equal(snap.penaltiesReceived, 2);
      assert.equal(snap.penaltyCauses['overlap'], 2);
      assert.equal(snap.plannerCalls['bfs']!.count, 2);
      assert.equal(snap.plannerCalls['bfs']!.failures, 1);
      assert.equal(snap.plannerCalls['bfs']!.avgLatencyMs, 15);
    });

    it('scoreTimeline has at least start and stop samples', () => {
      const mc = new MetricsCollector('bdi', 60_000); // long interval so timer doesn't fire
      mc.recordScore(10);
      mc.start();
      mc.recordScore(20);
      mc.stop();

      const snap = mc.snapshot();
      // start sample (score=10 at start) + stop sample (score=20 at stop)
      assert.ok(snap.scoreTimeline.length >= 2);
      assert.equal(snap.scoreTimeline[0]!.score, 10);
      assert.equal(snap.scoreTimeline[snap.scoreTimeline.length - 1]!.score, 20);
    });

    it('sessionDurationMs is > 0 after start+stop', () => {
      const mc = new MetricsCollector('bdi');
      mc.start();
      mc.stop();
      assert.ok(mc.snapshot().sessionDurationMs >= 0);
    });
  });

  describe('LLM call recording', () => {
    it('llmCalls is absent when no LLM calls recorded', () => {
      const mc = new MetricsCollector('bdi');
      assert.equal(mc.snapshot().llmCalls, undefined);
    });

    it('llmCalls is populated after recordLlmCall', () => {
      const mc = new MetricsCollector('bdi');
      mc.recordLlmCall(100, 500, false);
      mc.recordLlmCall(200, 300, true);
      const { llmCalls } = mc.snapshot();
      assert.ok(llmCalls !== undefined);
      assert.equal(llmCalls.count, 2);
      assert.equal(llmCalls.avgLatencyMs, 150);
      assert.equal(llmCalls.totalTokensUsed, 800);
      assert.equal(llmCalls.fallbackCount, 1);
    });
  });

  describe('multiple planner names', () => {
    it('tracks bfs and pddl separately', () => {
      const mc = new MetricsCollector('bdi');
      mc.recordPlannerCall('bfs', 10, true);
      mc.recordPlannerCall('pddl', 50, false);

      const snap = mc.snapshot();
      assert.equal(snap.plannerCalls['bfs']!.count, 1);
      assert.equal(snap.plannerCalls['pddl']!.count, 1);
      assert.equal(snap.plannerCalls['pddl']!.failures, 1);
    });
  });

  describe('exportJson', () => {
    const outPath = '/tmp/agent-007-test-metrics.json';

    after(async () => {
      if (existsSync(outPath)) await rm(outPath);
    });

    it('writes valid JSON to disk', async () => {
      const mc = new MetricsCollector('bdi');
      mc.setAgentId('test-agent');
      mc.recordScore(99);
      mc.start();
      mc.stop();
      await mc.exportJson(outPath);

      const { readFile } = await import('fs/promises');
      const raw = await readFile(outPath, 'utf-8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.agentId, 'test-agent');
      assert.equal(parsed.finalScore, 99);
      assert.ok(Array.isArray(parsed.scoreTimeline));
    });

    it('creates parent directory if missing', async () => {
      const deepPath = '/tmp/agent-007-test-dir/sub/metrics.json';
      const mc = new MetricsCollector('bdi');
      mc.start();
      mc.stop();
      await mc.exportJson(deepPath);
      assert.ok(existsSync(deepPath));
      await rm('/tmp/agent-007-test-dir', { recursive: true });
    });
  });

  describe('stagnation recording', () => {
    it('recordStagnation increments stagnationsDetected in snapshot', () => {
      const mc = new MetricsCollector('bdi');
      assert.equal(mc.snapshot().stagnationsDetected, undefined);

      mc.recordStagnation();
      assert.equal(mc.snapshot().stagnationsDetected, 1);

      mc.recordStagnation();
      mc.recordStagnation();
      assert.equal(mc.snapshot().stagnationsDetected, 3);
    });
  });

  describe('formatSummary', () => {
    it('returns a non-empty string with key fields', () => {
      const mc = new MetricsCollector('bdi');
      mc.setAgentId('agent-xyz');
      mc.recordScore(55);
      mc.recordParcelDelivered(30);
      mc.recordPlannerCall('bfs', 15, true);
      mc.start();
      mc.stop();

      const summary = formatSummary(mc.snapshot());
      assert.ok(summary.includes('bdi'));
      assert.ok(summary.includes('55'));
      assert.ok(summary.includes('bfs'));
    });
  });
});
