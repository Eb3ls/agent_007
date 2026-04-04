// ============================================================
// src/deliberation/deliberator.edge.test.ts — Edge cases for Deliberator
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IBeliefStore, ParcelBelief, Position, SelfBelief } from '../types.js';
import { Deliberator, REPLAN_UTILITY_THRESHOLD } from './deliberator.js';
import { createSingleIntention } from './intention.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
} from '../testing/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors deliberator.test.ts)
// ---------------------------------------------------------------------------

function makeParcel(overrides: Partial<ParcelBelief> & { id: string }): ParcelBelief {
  return {
    position: { x: 0, y: 0 },
    carriedBy: null,
    reward: 10,
    estimatedReward: 10,
    lastSeen: Date.now(),
    confidence: 1,
    decayRatePerMs: 0,
    ...overrides,
  };
}

function mockStore(
  parcels: ReadonlyArray<ParcelBelief>,
  selfPos: Position = { x: 4, y: 4 },
  selfId = 'agent-self',
): IBeliefStore {
  const zones: Position[] = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }];

  function nearestDelivery(from: Position): Position {
    let best = zones[0]!;
    let bestD = Math.abs(from.x - best.x) + Math.abs(from.y - best.y);
    for (const z of zones.slice(1)) {
      const d = Math.abs(from.x - z.x) + Math.abs(from.y - z.y);
      if (d < bestD) { bestD = d; best = z; }
    }
    return best;
  }

  return {
    updateSelf: () => {},
    updateParcels: () => {},
    updateAgents: () => {},
    mergeRemoteBelief: () => {},
    getSelf: () => ({
      id: selfId,
      name: 'TestAgent',
      position: selfPos,
      score: 0,
      penalty: 0,
      carriedParcels: [],
    } satisfies SelfBelief),
    getParcelBeliefs: () => parcels,
    getAgentBeliefs: () => [],
    getMap: () => new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT),
    getNearestDeliveryZone: (from) => nearestDelivery(from),
    getReachableParcels: () => parcels.filter(p => p.carriedBy === null && p.confidence > 0),
    toSnapshot: () => ({
      agentId: selfId,
      timestamp: Date.now(),
      selfPosition: selfPos,
      parcels: [],
      agents: [],
    }),
    getCapacity: () => Infinity,
    getExploreTarget: () => null,
    removeParcel: () => {},
    clearDeliveredParcels: () => {},
    onUpdate: () => {},
  };
}

// ---------------------------------------------------------------------------
// evaluate() — edge cases
// ---------------------------------------------------------------------------

describe('Deliberator.evaluate — edge cases', () => {
  let deliberator: Deliberator;

  beforeEach(() => { deliberator = new Deliberator(); });

  it('returns empty array when all parcels have zero confidence', () => {
    const parcels = [
      makeParcel({ id: 'p1', confidence: 0, position: { x: 5, y: 4 } }),
      makeParcel({ id: 'p2', confidence: 0, position: { x: 6, y: 4 } }),
    ];
    const beliefs = mockStore(parcels);
    assert.deepEqual(deliberator.evaluate(beliefs).intentions, []);
  });

  it('returns a single intention for a single reachable parcel (no cluster)', () => {
    const p = makeParcel({ id: 'lone', position: { x: 5, y: 4 }, estimatedReward: 30 });
    const intentions = deliberator.evaluate(mockStore([p])).intentions;
    // Should be exactly 1 intention (no cluster for a single parcel)
    assert.equal(intentions.length, 1);
    assert.deepEqual(intentions[0]!.targetParcels, ['lone']);
  });

  it('parcel at agent position has stepsToParcel = 0', () => {
    const selfPos: Position = { x: 4, y: 4 };
    const p = makeParcel({ id: 'here', position: selfPos, estimatedReward: 20 });
    const intentions = deliberator.evaluate(mockStore([p], selfPos)).intentions;
    assert.ok(intentions.length > 0);
    const single = intentions.find(i => i.targetParcels.length === 1 && i.targetParcels[0] === 'here');
    assert.ok(single, 'single-parcel intention for parcel at agent position must exist');
    // stepsToParcel = 0, stepsToDelivery = 8 → total = 8
    assert.ok(single.utility > 0);
  });

  it('intentions are sorted strictly descending by utility (no ties broken randomly)', () => {
    const parcels = [
      makeParcel({ id: 'a', position: { x: 5, y: 4 }, estimatedReward: 100 }),
      makeParcel({ id: 'b', position: { x: 5, y: 4 }, estimatedReward: 50 }),
      makeParcel({ id: 'c', position: { x: 5, y: 4 }, estimatedReward: 10 }),
    ];
    const intentions = deliberator.evaluate(mockStore(parcels)).intentions;
    for (let i = 1; i < intentions.length; i++) {
      assert.ok(
        intentions[i - 1]!.utility >= intentions[i]!.utility,
        `index ${i - 1} utility must be >= index ${i}`,
      );
    }
  });

  it('excludes parcels carried by the agent itself from candidates', () => {
    const selfId = 'me';
    const carried = makeParcel({ id: 'mine', position: { x: 5, y: 4 }, carriedBy: selfId });
    const free     = makeParcel({ id: 'free', position: { x: 6, y: 4 }, estimatedReward: 15 });

    const beliefs = mockStore([carried, free], { x: 4, y: 4 }, selfId);
    const intentions = deliberator.evaluate(beliefs).intentions;
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(!ids.includes('mine'), 'self-carried parcel must not appear in candidates');
    assert.ok(ids.includes('free'));
  });
});

// ---------------------------------------------------------------------------
// shouldReplan() — edge cases
// ---------------------------------------------------------------------------

describe('Deliberator.shouldReplan — edge cases', () => {
  let deliberator: Deliberator;

  beforeEach(() => { deliberator = new Deliberator(); });

  it('does not replan when target parcel is carried by SELF', () => {
    const selfId = 'me';
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(p, 1, 5);
    // Parcel exists and is carried by self — the plan is still valid
    const carriedBySelf = { ...p, carriedBy: selfId };
    const beliefs = mockStore([carriedBySelf], { x: 4, y: 4 }, selfId);
    assert.equal(deliberator.shouldReplan(intention, beliefs, false), false);
  });

  it('replans when target parcel is carried by another agent', () => {
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(p, 1, 5);
    const stolen = { ...p, carriedBy: 'enemy' };
    assert.equal(deliberator.shouldReplan(intention, mockStore([stolen])), true);
  });

  it('returns false when no parcels exist at all (null beliefs match currentIntention=null path)', () => {
    assert.equal(deliberator.shouldReplan(null, mockStore([])), false);
  });

  it('returns false when planFailed=false and nothing changed', () => {
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(p, 1, 4); // utility = 20/5 = 4
    assert.equal(deliberator.shouldReplan(intention, mockStore([p]), false), false);
  });

  it('does NOT replan when new utility exactly equals threshold * currentUtility', () => {
    // Self at (4,4). Parcel 'cur' at (5,4): stepsToParcel=1, nearestDelivery=(9,0) at dist=8.
    // intention utility = 20 / (1+8) = 20/9.
    // REPLAN_UTILITY_THRESHOLD=1.3 → threshold * current = 1.3 * 20/9 = 26/9 ≈ 2.89.
    const current = makeParcel({ id: 'cur', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(current, 1, 8); // utility = 20/9

    // Place 'eq' at (0,9): stepsToParcel from (4,4)=9; nearestDelivery(0,9)=(0,0) dist=9 → total=18.
    // reward=52 → utility=52/18=26/9≈2.89 — exactly equals threshold*current → NOT strictly greater.
    const equalThreshold = makeParcel({ id: 'eq', position: { x: 0, y: 9 }, estimatedReward: 52 });

    const result = deliberator.shouldReplan(
      intention,
      mockStore([current, equalThreshold]),
      false,
    );
    assert.equal(result, false, 'exactly at threshold should not trigger replan');
  });

  it('DOES replan when new utility is strictly above threshold * currentUtility', () => {
    // Same setup: current at (5,4), utility=20/9, threshold=10/3.
    const current = makeParcel({ id: 'cur', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(current, 1, 8); // utility = 20/9

    // 'above' at (5,4) with reward=100: single utility=100/9≈11 >> 10/3≈3.33.
    // Cluster with current also >> threshold. Either way, triggers replan.
    const aboveThreshold = makeParcel({ id: 'above', position: { x: 5, y: 4 }, estimatedReward: 100 });

    const result = deliberator.shouldReplan(
      intention,
      mockStore([current, aboveThreshold]),
      false,
    );
    assert.equal(result, true, 'above threshold should trigger replan');
  });

  it('shouldReplan with current utility=0 triggers replan for any positive utility', () => {
    // An intention with utility=0 (reward=0)
    const zeroPar = makeParcel({ id: 'zero', position: { x: 5, y: 4 }, estimatedReward: 0 });
    const intention = createSingleIntention(zeroPar, 1, 4); // utility=0/5=0

    const positiveParcel = makeParcel({ id: 'pos', position: { x: 5, y: 4 }, estimatedReward: 1 });
    // REPLAN_UTILITY_THRESHOLD * 0 = 0; any positive utility > 0 → replan
    const result = deliberator.shouldReplan(
      intention,
      mockStore([zeroPar, positiveParcel]),
      false,
    );
    assert.equal(result, true, 'positive utility vs zero current utility must trigger replan');
  });

  it('exported REPLAN_UTILITY_THRESHOLD is strictly greater-than (not >=)', () => {
    // Confirm constant value
    assert.equal(REPLAN_UTILITY_THRESHOLD, 1.3);
  });
});

// ---------------------------------------------------------------------------
// shouldReplan — precomputedCandidates evita doppio evaluate()
// ---------------------------------------------------------------------------

describe('Deliberator — shouldReplan con precomputedCandidates', () => {
  it('con precomputedCandidates dà stesso risultato di senza', () => {
    const deliberator = new Deliberator();
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, reward: 20 });
    const store = mockStore([p]);
    const intention = createSingleIntention(p, 1, 9, 20);

    const withoutPre = deliberator.shouldReplan(intention, store, false, 500);
    const candidates = deliberator.evaluate(store, 500).intentions;
    const withPre = deliberator.shouldReplan(intention, store, false, 500, undefined, candidates);

    assert.strictEqual(withPre, withoutPre,
      'shouldReplan con precomputedCandidates deve dare stesso risultato');
  });

  it('con precomputedCandidates vuoti: nessun candidato migliore → no replan', () => {
    const deliberator = new Deliberator();
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, reward: 20 });
    const store = mockStore([p]);
    const intention = createSingleIntention(p, 1, 9, 20);

    // Array vuoto = nessun candidato migliore → no replan
    const result = deliberator.shouldReplan(intention, store, false, 500, undefined, []);
    assert.strictEqual(result, false,
      'nessun candidato migliore → shouldReplan deve ritornare false');
  });
});
