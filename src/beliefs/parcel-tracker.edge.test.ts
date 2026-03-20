// ============================================================
// src/beliefs/parcel-tracker.edge.test.ts — Edge cases for ParcelTracker
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ParcelTracker } from './parcel-tracker.js';

describe('ParcelTracker — edge cases', () => {
  let tracker: ParcelTracker;

  beforeEach(() => {
    tracker = new ParcelTracker();
  });

  // --- forget() + observe() re-initialization ---

  it('forget() then observe() reinitializes state as a fresh first observation', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000); // rate = 0.005
    tracker.forget('p1');

    // After forget, first observe should reset decay rate to 0
    tracker.observe('p1', 60, 2000);
    assert.strictEqual(tracker.getDecayRate('p1'), 0, 'decay rate must be 0 after re-first observe');
    assert.strictEqual(tracker.estimateRewardAt('p1', 2000), 60);
  });

  it('forget() then observe() twice computes fresh decay rate', () => {
    tracker.observe('p1', 100, 0);
    tracker.observe('p1', 80, 1000);  // old rate = 0.02
    tracker.forget('p1');

    tracker.observe('p1', 50, 5000);
    tracker.observe('p1', 40, 6000); // new rate = (50-40)/1000 = 0.01
    assert.strictEqual(tracker.getDecayRate('p1'), 0.01);
  });

  // --- Backwards / zero timestamps ---

  it('does not update decay rate when dt is negative (backwards timestamp)', () => {
    tracker.observe('p1', 50, 2000);
    // Observe with an earlier timestamp — should not update decay
    tracker.observe('p1', 40, 1000); // dt = -1000 < 0
    assert.strictEqual(tracker.getDecayRate('p1'), 0, 'backwards timestamps must not update decay');
    // But lastReward should still update
    assert.strictEqual(tracker.estimateRewardAt('p1', 1000), 40);
  });

  // --- Zero reward observation ---

  it('computes decay correctly when second reward is exactly 0', () => {
    tracker.observe('p1', 10, 0);
    tracker.observe('p1', 0, 500); // rate = 10/500 = 0.02
    assert.strictEqual(tracker.getDecayRate('p1'), 0.02);
  });

  it('clamps estimate to 0 even when decay rate is 0 and no global average', () => {
    tracker.observe('p1', 5, 0);
    // No decay rate known, no global average → rate = 0
    // Estimate at any future time should just return last reward
    assert.strictEqual(tracker.estimateRewardAt('p1', 999999), 5);
  });

  // --- Global average with zero-rate parcels only ---

  it('global average falls back to 0 when all observed parcels have rate=0', () => {
    tracker.observe('p1', 10, 0);   // single obs — rate = 0
    tracker.observe('p2', 20, 100); // single obs — rate = 0
    assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0);
  });

  // --- estimateRewardAt with past timestamp ---

  it('estimateRewardAt returns lastReward for timestamps before lastTimestamp', () => {
    tracker.observe('p1', 30, 5000);
    tracker.observe('p1', 25, 6000); // rate = 0.005, lastTimestamp = 6000
    // Asking for a time before last observation
    assert.strictEqual(tracker.estimateRewardAt('p1', 3000), 25);
  });

  it('estimateRewardAt returns lastReward when dt == 0', () => {
    tracker.observe('p1', 42, 1000);
    assert.strictEqual(tracker.estimateRewardAt('p1', 1000), 42);
  });

  // --- Spawn tracking edge cases ---

  it('getSpawnFrequency returns 0 when two spawns share the same timestamp (dt=0)', () => {
    tracker.recordSpawn({ x: 5, y: 5 }, 1000);
    tracker.recordSpawn({ x: 5, y: 5 }, 1000); // same timestamp, dt=0
    assert.strictEqual(tracker.getSpawnFrequency({ x: 5, y: 5 }), 0);
  });

  it('third spawn updates lastTimestamp and frequency', () => {
    tracker.recordSpawn({ x: 2, y: 3 }, 0);
    tracker.recordSpawn({ x: 2, y: 3 }, 1000);
    tracker.recordSpawn({ x: 2, y: 3 }, 3000);
    // count=3, first=0, last=3000 → 3/3000
    const freq = tracker.getSpawnFrequency({ x: 2, y: 3 });
    assert.ok(Math.abs(freq - 3 / 3000) < 1e-12, `expected ${3 / 3000}, got ${freq}`);
  });

  it('spawn tracking is independent per coordinate pair', () => {
    // Tiles that could collide if key was naive (e.g. "1,23" vs "12,3")
    tracker.recordSpawn({ x: 1, y: 23 }, 0);
    tracker.recordSpawn({ x: 1, y: 23 }, 500);

    tracker.recordSpawn({ x: 12, y: 3 }, 0);
    tracker.recordSpawn({ x: 12, y: 3 }, 200);

    assert.strictEqual(tracker.getSpawnFrequency({ x: 1, y: 23 }), 2 / 500);
    assert.strictEqual(tracker.getSpawnFrequency({ x: 12, y: 3 }), 2 / 200);
  });

  // --- Reward stays same between two observations ---

  it('does not update decay rate when reward is unchanged between observations', () => {
    tracker.observe('p1', 30, 0);
    tracker.observe('p1', 30, 1000); // no change — reward did not decrease
    assert.strictEqual(tracker.getDecayRate('p1'), 0);
  });

  // --- Global average excludes zero-rate from forgotten parcels ---

  it('forgetting a parcel with non-zero rate updates global average immediately', () => {
    tracker.observe('p1', 100, 0);
    tracker.observe('p1', 80, 1000); // rate=0.02
    tracker.observe('p2', 50, 0);
    tracker.observe('p2', 40, 500);  // rate=0.02

    const avgBefore = tracker.getGlobalAverageDecayRate();
    assert.ok(Math.abs(avgBefore - 0.02) < 1e-12);

    tracker.forget('p1');

    // After forget, only p2 contributes
    const avgAfter = tracker.getGlobalAverageDecayRate();
    assert.ok(Math.abs(avgAfter - 0.02) < 1e-12, 'rate unchanged when both were equal');
  });

  // --- Large timestamp values ---

  it('handles large timestamps without overflow', () => {
    const bigT = Number.MAX_SAFE_INTEGER - 2;
    tracker.observe('p1', 100, bigT);
    tracker.observe('p1', 50, bigT + 1);
    // dt = 1, drop = 50, rate = 50
    assert.strictEqual(tracker.getDecayRate('p1'), 50);
    // Estimate 1ms later: 50 - 50*1 = 0
    assert.strictEqual(tracker.estimateRewardAt('p1', bigT + 2), 0);
  });
});
