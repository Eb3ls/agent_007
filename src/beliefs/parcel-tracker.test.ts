// ============================================================
// src/beliefs/parcel-tracker.test.ts — ParcelTracker unit tests (T08)
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ParcelTracker } from './parcel-tracker.js';

describe('ParcelTracker', () => {
  let tracker: ParcelTracker;

  beforeEach(() => {
    tracker = new ParcelTracker();
  });

  // --- observe & getDecayRate ---

  it('returns 0 decay rate before any observations', () => {
    assert.strictEqual(tracker.getDecayRate('p1'), 0);
  });

  it('returns 0 decay rate after a single observation', () => {
    tracker.observe('p1', 50, 0);
    assert.strictEqual(tracker.getDecayRate('p1'), 0);
  });

  it('computes decay rate from two observations', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000);
    // (50 - 45) / 1000 = 0.005
    assert.strictEqual(tracker.getDecayRate('p1'), 0.005);
  });

  it('does not update decay rate when reward increases (pickup artifact)', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 80, 1000); // reward went up — ignore
    assert.strictEqual(tracker.getDecayRate('p1'), 0);
  });

  it('retains previous decay rate when subsequent reward does not decrease', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000); // rate = 0.005
    tracker.observe('p1', 45, 2000); // reward unchanged — rate stays
    assert.strictEqual(tracker.getDecayRate('p1'), 0.005);
  });

  it('updates decay rate from each new observation pair', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000); // rate = 0.005
    tracker.observe('p1', 38, 2000); // (45-38)/1000 = 0.007
    assert.strictEqual(tracker.getDecayRate('p1'), 0.007);
  });

  it('ignores zero-duration intervals', () => {
    tracker.observe('p1', 50, 1000);
    tracker.observe('p1', 45, 1000); // dt=0 — skip
    assert.strictEqual(tracker.getDecayRate('p1'), 0);
  });

  // --- getGlobalAverageDecayRate ---

  it('returns 0 global average with no tracked parcels', () => {
    assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0);
  });

  it('returns 0 global average when no parcel has a measured rate', () => {
    tracker.observe('p1', 50, 0);
    assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0);
  });

  it('global average equals single parcel rate', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000);
    assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0.005);
  });

  it('global average is mean of multiple parcel rates', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000); // rate = 0.005

    tracker.observe('p2', 100, 0);
    tracker.observe('p2', 85, 1000); // rate = 0.015

    const avg = tracker.getGlobalAverageDecayRate();
    // (0.005 + 0.015) / 2 = 0.01
    assert.ok(Math.abs(avg - 0.01) < 1e-10, `expected 0.01, got ${avg}`);
  });

  it('excludes parcels with zero rate from global average', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000); // rate = 0.005
    tracker.observe('p2', 30, 0);    // only one obs — rate = 0

    assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0.005);
  });

  // --- estimateRewardAt ---

  it('returns 0 for unknown parcel', () => {
    assert.strictEqual(tracker.estimateRewardAt('unknown', 5000), 0);
  });

  it('returns last reward when future timestamp equals last observation', () => {
    tracker.observe('p1', 50, 1000);
    assert.strictEqual(tracker.estimateRewardAt('p1', 1000), 50);
  });

  it('returns last reward when future timestamp is before last observation', () => {
    tracker.observe('p1', 50, 1000);
    assert.strictEqual(tracker.estimateRewardAt('p1', 500), 50);
  });

  it('estimates future reward using per-parcel decay rate', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000); // rate = 0.005
    // estimate at t=2000: 45 - 0.005 * (2000-1000) = 45 - 5 = 40
    assert.strictEqual(tracker.estimateRewardAt('p1', 2000), 40);
  });

  it('falls back to global average decay when per-parcel rate is 0', () => {
    // p2 has known rate, p1 does not
    tracker.observe('p2', 100, 0);
    tracker.observe('p2', 90, 1000); // rate = 0.01

    tracker.observe('p1', 50, 0); // no rate yet
    // estimate at t=1000: 50 - 0.01 * 1000 = 40
    assert.strictEqual(tracker.estimateRewardAt('p1', 1000), 40);
  });

  it('clamps estimated reward to 0', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000); // rate = 0.005
    // at t=100000: 45 - 0.005 * 99000 = 45 - 495 → clamped to 0
    assert.strictEqual(tracker.estimateRewardAt('p1', 100000), 0);
  });

  // --- forget ---

  it('forget removes all parcel state', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000);
    tracker.forget('p1');

    assert.strictEqual(tracker.getDecayRate('p1'), 0);
    assert.strictEqual(tracker.estimateRewardAt('p1', 2000), 0);
  });

  it('forget is a no-op for unknown parcels', () => {
    assert.doesNotThrow(() => tracker.forget('nonexistent'));
  });

  it('forgotten parcel excluded from global average', () => {
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 45, 1000); // rate = 0.005
    tracker.observe('p2', 100, 0);
    tracker.observe('p2', 80, 1000); // rate = 0.02

    tracker.forget('p2');
    assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0.005);
  });

  // --- spawn tracking ---

  it('getSpawnFrequency returns 0 for untracked position', () => {
    assert.strictEqual(tracker.getSpawnFrequency({ x: 3, y: 3 }), 0);
  });

  it('getSpawnFrequency returns 0 with only one spawn', () => {
    tracker.recordSpawn({ x: 3, y: 3 }, 0);
    assert.strictEqual(tracker.getSpawnFrequency({ x: 3, y: 3 }), 0);
  });

  it('computes spawn frequency from multiple spawns', () => {
    tracker.recordSpawn({ x: 3, y: 3 }, 0);
    tracker.recordSpawn({ x: 3, y: 3 }, 1000);
    tracker.recordSpawn({ x: 3, y: 3 }, 2000);
    // 3 spawns over 2000ms = 3/2000 spawns/ms
    assert.strictEqual(tracker.getSpawnFrequency({ x: 3, y: 3 }), 3 / 2000);
  });

  it('spawn tracking is per-tile (different positions independent)', () => {
    tracker.recordSpawn({ x: 1, y: 1 }, 0);
    tracker.recordSpawn({ x: 1, y: 1 }, 1000);

    tracker.recordSpawn({ x: 5, y: 5 }, 0);

    assert.strictEqual(tracker.getSpawnFrequency({ x: 1, y: 1 }), 2 / 1000);
    assert.strictEqual(tracker.getSpawnFrequency({ x: 5, y: 5 }), 0);
  });
});

// --- setBaseDecayRate ---

describe('ParcelTracker — setBaseDecayRate', () => {
  it('getGlobalAverageDecayRate returns base rate when no empirical observations', () => {
    const tracker = new ParcelTracker();
    tracker.setBaseDecayRate(0.005);
    assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0.005);
  });

  it('estimateRewardAt uses base decay rate as fallback for new parcel (single observation)', () => {
    const tracker = new ParcelTracker();
    tracker.setBaseDecayRate(0.01); // 1 reward unit per 100ms
    tracker.observe('p1', 50, 0);
    // 1000ms later: 50 - 0.01*1000 = 40
    assert.strictEqual(tracker.estimateRewardAt('p1', 1000), 40);
  });

  it('empirical rate takes precedence over base rate once measured', () => {
    const tracker = new ParcelTracker();
    tracker.setBaseDecayRate(0.001); // slow base rate
    tracker.observe('p1', 50, 0);
    tracker.observe('p1', 40, 1000); // empirical: (50-40)/1000 = 0.01
    // Global avg now uses empirical, not base
    assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0.01);
    assert.strictEqual(tracker.getDecayRate('p1'), 0.01);
  });
});
