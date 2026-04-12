// ============================================================
// src/beliefs/belief-store.crates.test.ts — Crate TTL unit tests
// Tests for CRATE_STALE_TTL_MS (30s) eviction logic in BeliefStore.
// ============================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BeliefStore } from './belief-store.js';
import { BeliefMapImpl } from './belief-map.js';
import type { Tile, TileType } from '../types.js';

// --- Helpers ---

function tile(x: number, y: number, type: TileType): Tile {
  return { x, y, type };
}

/**
 * Minimal 10x10 all-walkable map.
 * Self is positioned at (0,0), so crates at (9,y) are far away
 * (distance=9) — beyond the default effectiveRange of 5 when
 * observationDistance is 0.  With setObservationDistance(5) they
 * are also beyond the boundary (dist >= obsDistance).
 */
function makeMinimalMap(): BeliefMapImpl {
  const tiles: Tile[] = [];
  for (let x = 0; x < 10; x++) {
    for (let y = 0; y < 10; y++) {
      tiles.push(tile(x, y, 3));
    }
  }
  return new BeliefMapImpl(tiles, 10, 10);
}

/**
 * Tiny 3x3 walkable map used for in-range tests.
 * Self at (0,0); a crate at (1,0) is distance 1 — well within
 * any observation range.
 */
function makeSmallMap(): BeliefMapImpl {
  const tiles: Tile[] = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      tiles.push(tile(x, y, 3));
    }
  }
  return new BeliefMapImpl(tiles, 3, 3);
}

const SELF_AT_ORIGIN = { id: 'agent-self', name: 'T', x: 0, y: 0, score: 0, penalty: 0 };

// ============================================================
// Crate TTL tests
// ============================================================

describe('BeliefStore — crate TTL (30s)', () => {
  let store: BeliefStore;
  let originalDateNow: () => number;

  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    // Always restore real Date.now after each test.
    Date.now = originalDateNow;
  });

  // A1 — cassa rimossa dopo TTL
  it('A1: removes a crate after 30s TTL', () => {
    const baseTime = 1_000_000;
    Date.now = () => baseTime;

    store = new BeliefStore(makeMinimalMap());
    store.updateSelf(SELF_AT_ORIGIN);
    // Set observation distance so the crate at (9,0) is OUT of range.
    store.setObservationDistance(5);

    // Insert crate at (9,0) — distance 9 from origin, beyond obs range 5.
    store.updateCrates([{ id: 'c1', x: 9, y: 0 }]);
    assert.equal(store.getCrateBeliefs().size, 1, 'crate should be present after insertion');

    // Advance time by 31s (past the 30s TTL).
    Date.now = () => baseTime + 31_000;

    // Call updateCrates with empty list — crate is out of range so belief
    // revision does NOT remove it, but the TTL sweep should.
    store.updateCrates([]);
    assert.equal(store.getCrateBeliefs().size, 0, 'crate should be evicted after TTL');
  });

  // A2 — cassa NON rimossa se non è scaduta
  it('A2: keeps a crate if TTL has not expired (10s elapsed)', () => {
    const baseTime = 1_000_000;
    Date.now = () => baseTime;

    store = new BeliefStore(makeMinimalMap());
    store.updateSelf(SELF_AT_ORIGIN);
    store.setObservationDistance(5);

    store.updateCrates([{ id: 'c1', x: 9, y: 0 }]);

    // Advance only 10s — TTL is 30s, so should NOT be evicted.
    Date.now = () => baseTime + 10_000;
    store.updateCrates([]);

    assert.equal(store.getCrateBeliefs().size, 1, 'crate should still exist before TTL expires');
  });

  // A3 — cassa rimossa da disconferma in-range indipendentemente da TTL
  it('A3: removes a crate immediately when in observation range (belief revision, no TTL needed)', () => {
    const baseTime = 1_000_000;
    Date.now = () => baseTime;

    store = new BeliefStore(makeSmallMap());
    store.updateSelf(SELF_AT_ORIGIN);
    store.setObservationDistance(5);

    // Crate at (1,0): distance 1 from (0,0) — clearly in observation range.
    store.updateCrates([{ id: 'c1', x: 1, y: 0 }]);
    assert.equal(store.getCrateBeliefs().size, 1, 'crate should be present after insertion');

    // No time advance needed — belief revision fires immediately on empty sensing.
    store.updateCrates([]);
    assert.equal(store.getCrateBeliefs().size, 0, 'crate within obs range must be removed by belief revision');
  });

  // A4 — clearStaleBeliefs svuota le casse
  it('A4: clearStaleBeliefs removes all crate beliefs', () => {
    const baseTime = 1_000_000;
    Date.now = () => baseTime;

    store = new BeliefStore(makeMinimalMap());
    store.updateSelf(SELF_AT_ORIGIN);
    store.setObservationDistance(5);

    store.updateCrates([{ id: 'c1', x: 9, y: 0 }]);
    assert.equal(store.getCrateBeliefs().size, 1, 'crate should be present before clearStaleBeliefs');

    store.clearStaleBeliefs();
    assert.equal(store.getCrateBeliefs().size, 0, 'clearStaleBeliefs must remove all crate beliefs');
  });
});
