// ============================================================
// src/deliberation/deliberator.test.ts — T12 unit tests
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentBelief, IBeliefStore, ParcelBelief, Position, SelfBelief } from '../types.js';
import { Deliberator, REPLAN_UTILITY_THRESHOLD } from './deliberator.js';
import { createSingleIntention } from './intention.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import { ParcelTracker } from '../beliefs/parcel-tracker.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
} from '../testing/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Minimal mock IBeliefStore.
 * selfPos defaults to (4,4); delivery zones at (0,0), (9,0), (9,9).
 */
function mockStore(
  parcels: ReadonlyArray<ParcelBelief>,
  selfPos: Position = { x: 4, y: 4 },
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
      id: 'agent-self',
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
      agentId: 'agent-self',
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
// evaluate()
// ---------------------------------------------------------------------------

describe('Deliberator.evaluate', () => {
  let deliberator: Deliberator;

  beforeEach(() => {
    deliberator = new Deliberator();
  });

  it('returns empty array when no reachable parcels and no explore target', () => {
    const beliefs = mockStore([]); // getExploreTarget returns null in default mock
    assert.deepEqual(deliberator.evaluate(beliefs), []);
  });

  it('returns explore intention when no reachable parcels but spawning tile exists', () => {
    const target: Position = { x: 1, y: 0 };
    const beliefs: IBeliefStore = {
      ...mockStore([]),
      getExploreTarget: () => target,
    };
    const results = deliberator.evaluate(beliefs);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.type, 'explore');
    assert.deepEqual(results[0]!.targetPosition, target);
    assert.equal(results[0]!.utility, 0.1);
    assert.deepEqual(results[0]!.targetParcels, []);
  });

  it('returns intentions sorted by utility descending', () => {
    // Agent at (4,4). Delivery zones at (0,0), (9,0), (9,9).
    // p1: reward=50, at (5,4) — 1 step to parcel, ~9 steps to delivery(0,0) → utility ≈ 50/10 = 5
    // p2: reward=10, at (4,8) — 4 steps to parcel, ~13 steps to delivery(9,9) → utility ≈ 10/17 ≈ 0.59
    // p3: reward=30, at (7,4) — 3 steps to parcel, ~12 steps to delivery(9,0) → utility = 30/15 = 2
    const p1 = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 50 });
    const p2 = makeParcel({ id: 'p2', position: { x: 4, y: 8 }, estimatedReward: 10 });
    const p3 = makeParcel({ id: 'p3', position: { x: 7, y: 4 }, estimatedReward: 30 });

    const intentions = deliberator.evaluate(mockStore([p1, p2, p3]));

    assert.ok(intentions.length >= 3, 'at least 3 single-parcel intentions');
    // Verify descending order
    for (let i = 1; i < intentions.length; i++) {
      assert.ok(
        intentions[i - 1]!.utility >= intentions[i]!.utility,
        `intention ${i - 1} utility (${intentions[i - 1]!.utility}) >= ${i} (${intentions[i]!.utility})`,
      );
    }
    // p1 should be first (highest utility)
    assert.equal(intentions[0]!.targetParcels[0], 'p1');
  });

  it('includes a cluster intention for nearby parcels', () => {
    // Two parcels 1 step apart → cluster radius satisfied
    const p1 = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const p2 = makeParcel({ id: 'p2', position: { x: 6, y: 4 }, estimatedReward: 20 });

    const intentions = deliberator.evaluate(mockStore([p1, p2]));

    const clusters = intentions.filter(i => i.targetParcels.length === 2);
    assert.ok(clusters.length >= 1, 'at least one cluster intention');
  });

  it('cluster intention beats individual intentions when parcels are adjacent', () => {
    // p1 at (5,4), p2 at (6,4) — 1 step apart, well within CLUSTER_RADIUS=3
    const p1 = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const p2 = makeParcel({ id: 'p2', position: { x: 6, y: 4 }, estimatedReward: 20 });

    const intentions = deliberator.evaluate(mockStore([p1, p2]));
    const best = intentions[0]!;

    assert.equal(best.targetParcels.length, 2, 'cluster intention should be best');
  });

  it('excludes carried parcels from candidates', () => {
    const carried = makeParcel({ id: 'c1', position: { x: 5, y: 4 }, carriedBy: 'other' });
    const free    = makeParcel({ id: 'f1', position: { x: 6, y: 4 }, estimatedReward: 10 });

    const intentions = deliberator.evaluate(mockStore([carried, free]));
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(!ids.includes('c1'), 'carried parcel should not appear');
    assert.ok(ids.includes('f1'));
  });

  it('returns empty when agent is at capacity (carried >= capacity)', () => {
    const p1 = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const p2 = makeParcel({ id: 'p2', position: { x: 6, y: 4 }, estimatedReward: 20 });

    // Mock: capacity=2, already carrying 2 parcels
    const selfParcel = makeParcel({ id: 'c1', position: { x: 4, y: 4 }, carriedBy: 'agent-self' });
    const store = mockStore([p1, p2]);
    const storeAtCapacity: IBeliefStore = {
      ...store,
      getCapacity: () => 2,
      getSelf: () => ({
        id: 'agent-self',
        name: 'TestAgent',
        position: { x: 4, y: 4 },
        score: 0,
        penalty: 0,
        carriedParcels: [selfParcel, selfParcel], // 2 carried = capacity
      }),
    };

    const intentions = deliberator.evaluate(storeAtCapacity);
    assert.equal(intentions.length, 0, 'no intentions when at capacity');
  });

  // -----------------------------------------------------------------------
  // Contesa filter — enemy closer to parcel → parcel excluded
  // -----------------------------------------------------------------------

  function makeAgent(overrides: Partial<AgentBelief> & { id: string }): AgentBelief {
    return {
      position: { x: 0, y: 0 },
      name: 'enemy',
      score: 0,
      lastSeen: Date.now(),
      confidence: 1,
      heading: null,
      isAlly: false,
      ...overrides,
    };
  }

  it('excludes parcel when an enemy agent is closer to it', () => {
    // Self at (4,4).
    // p_contested at (8,4) — 4 steps from self. Enemy at (7,4) — 1 step from p_contested → enemy wins.
    // p_safe at (5,4) — 1 step from self. No enemy close → kept.
    const contested = makeParcel({ id: 'contested', position: { x: 8, y: 4 }, estimatedReward: 50 });
    const safe = makeParcel({ id: 'safe', position: { x: 5, y: 4 }, estimatedReward: 10 });
    const enemy = makeAgent({ id: 'enemy1', position: { x: 7, y: 4 } });
    const store: IBeliefStore = { ...mockStore([contested, safe]), getAgentBeliefs: () => [enemy] };

    const intentions = deliberator.evaluate(store);
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(!ids.includes('contested'), 'contested parcel should be filtered when enemy is closer');
    assert.ok(ids.includes('safe'), 'safe parcel should be kept');
  });

  it('keeps parcel when self is closer than any enemy', () => {
    // Self at (4,4). Parcel at (5,4) — 1 step from self.
    // Enemy at (8,4) — 3 steps from parcel. Self wins → parcel kept.
    const safe = makeParcel({ id: 'safe', position: { x: 5, y: 4 }, estimatedReward: 30 });
    const enemy = makeAgent({ id: 'enemy1', position: { x: 8, y: 4 } });
    const store: IBeliefStore = { ...mockStore([safe]), getAgentBeliefs: () => [enemy] };

    const intentions = deliberator.evaluate(store);
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(ids.includes('safe'), 'safe parcel should be kept when self is closer');
  });

  it('keeps parcel when self and enemy are equidistant (tie favors self)', () => {
    // Self at (4,4). Parcel at (6,4) — 2 steps.
    // Enemy at (6,6) — 2 steps. Tie → parcel kept.
    const tied = makeParcel({ id: 'tied', position: { x: 6, y: 4 }, estimatedReward: 20 });
    const enemy = makeAgent({ id: 'enemy1', position: { x: 6, y: 6 } });
    const store: IBeliefStore = { ...mockStore([tied]), getAgentBeliefs: () => [enemy] };

    const intentions = deliberator.evaluate(store);
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(ids.includes('tied'), 'tied parcel should be kept (tie favors self)');
  });

  it('falls back to all reachable parcels when all are contested', () => {
    // Self at (4,4). All parcels have an enemy closer.
    const p1 = makeParcel({ id: 'p1', position: { x: 9, y: 4 }, estimatedReward: 20 });
    const p2 = makeParcel({ id: 'p2', position: { x: 9, y: 9 }, estimatedReward: 20 });
    const enemy = makeAgent({ id: 'enemy1', position: { x: 8, y: 4 } }); // closer to p1 and p2
    const store: IBeliefStore = { ...mockStore([p1, p2]), getAgentBeliefs: () => [enemy] };

    const intentions = deliberator.evaluate(store);
    // Should not return empty — fallback to all reachable
    assert.ok(intentions.length > 0, 'should not be empty when all parcels are contested');
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(ids.includes('p1') || ids.includes('p2'), 'fallback should include at least one parcel');
  });

  it('ignores ally agents in contesa filter', () => {
    // Self at (4,4). Parcel at (8,4) — 4 steps. Ally at (7,4) — 1 step.
    // Ally should NOT trigger the contesa filter.
    const p = makeParcel({ id: 'p1', position: { x: 8, y: 4 }, estimatedReward: 40 });
    const ally = makeAgent({ id: 'ally1', position: { x: 7, y: 4 }, isAlly: true });
    const store: IBeliefStore = { ...mockStore([p]), getAgentBeliefs: () => [ally] };

    const intentions = deliberator.evaluate(store);
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(ids.includes('p1'), 'parcel should not be filtered because of ally proximity');
  });

  it('caps cluster size to remaining capacity', () => {
    // 4 parcels clustered together, capacity=3, carrying 1 → remaining=2 → cluster capped at 2
    const parcels = [
      makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 10 }),
      makeParcel({ id: 'p2', position: { x: 6, y: 4 }, estimatedReward: 10 }),
      makeParcel({ id: 'p3', position: { x: 5, y: 5 }, estimatedReward: 10 }),
      makeParcel({ id: 'p4', position: { x: 6, y: 5 }, estimatedReward: 10 }),
    ];
    const carried = makeParcel({ id: 'c1', position: { x: 4, y: 4 }, carriedBy: 'agent-self' });
    const store = mockStore(parcels);
    const storePartialCapacity: IBeliefStore = {
      ...store,
      getCapacity: () => 3,
      getSelf: () => ({
        id: 'agent-self',
        name: 'TestAgent',
        position: { x: 4, y: 4 },
        score: 0,
        penalty: 0,
        carriedParcels: [carried], // 1 carried, 2 remaining
      }),
    };

    const intentions = deliberator.evaluate(storePartialCapacity);
    const clusterIntentions = intentions.filter(i => i.targetParcels.length > 1);
    for (const ci of clusterIntentions) {
      assert.ok(ci.targetParcels.length <= 2, `cluster size ${ci.targetParcels.length} exceeds remaining capacity 2`);
    }
  });
});

// ---------------------------------------------------------------------------
// shouldReplan()
// ---------------------------------------------------------------------------

describe('Deliberator.shouldReplan', () => {
  let deliberator: Deliberator;

  beforeEach(() => {
    deliberator = new Deliberator();
  });

  it('returns false when currentIntention is null', () => {
    assert.equal(deliberator.shouldReplan(null, mockStore([])), false);
  });

  it('returns true when planFailed is true', () => {
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(p, 1, 5);
    assert.equal(deliberator.shouldReplan(intention, mockStore([p]), true), true);
  });

  it('returns true when target parcel disappears from beliefs', () => {
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(p, 1, 5);
    // beliefs has no parcels
    assert.equal(deliberator.shouldReplan(intention, mockStore([])), true);
  });

  it('returns true when target parcel is picked up by another agent', () => {
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(p, 1, 5);
    const carried = { ...p, carriedBy: 'enemy-agent' };
    assert.equal(deliberator.shouldReplan(intention, mockStore([carried])), true);
  });

  it('returns true when a 2x-utility parcel appears', () => {
    // Current intention: utility = 20/(1+4) = 4
    const current = makeParcel({ id: 'cur', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(current, 1, 4);
    // New parcel: reward=100, 1 step away, 4 steps to delivery → utility = 100/5 = 20 (5x current)
    const better = makeParcel({ id: 'new', position: { x: 5, y: 4 }, estimatedReward: 100 });
    assert.equal(
      deliberator.shouldReplan(intention, mockStore([current, better])),
      true,
    );
  });

  it('returns false when a slightly better parcel appears (below threshold)', () => {
    // Self at (4,4). 'cur' at (5,4): stepsToParcel=1, nearestDelivery=(9,0) dist=8 → utility=20/9≈2.22
    const current = makeParcel({ id: 'cur', position: { x: 5, y: 4 }, estimatedReward: 20 });
    const intention = createSingleIntention(current, 1, 8);
    // 'sl' at (5,9) — dist from cur is 5 > CLUSTER_RADIUS=3, no cluster forms.
    // stepsToParcel from (4,4)=6; nearestDelivery(5,9)=(9,9) dist=4 → utility=22/10=2.2
    // 2.2 < 2.0 * (20/9) ≈ 4.44 → should NOT trigger replan
    const slightly = makeParcel({ id: 'sl', position: { x: 5, y: 9 }, estimatedReward: 22 });
    assert.equal(
      deliberator.shouldReplan(intention, mockStore([current, slightly])),
      false,
    );
  });

  it('returns false when beliefs change but current parcel still exists and nothing better', () => {
    const p1 = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 30 });
    const p2 = makeParcel({ id: 'p2', position: { x: 8, y: 4 }, estimatedReward: 5 });
    const intention = createSingleIntention(p1, 1, 4); // utility = 30/5 = 6
    // p2 utility = 5/(4+5) ≈ 0.56 — much worse than current
    assert.equal(
      deliberator.shouldReplan(intention, mockStore([p1, p2])),
      false,
    );
  });

  it('REPLAN_UTILITY_THRESHOLD is exported and is 1.3', () => {
    assert.equal(REPLAN_UTILITY_THRESHOLD, 1.3);
  });
});

// ---------------------------------------------------------------------------
// ParcelTracker integration — decay-aware utility
// ---------------------------------------------------------------------------

describe('Deliberator.evaluate — decay-aware utility via ParcelTracker', () => {
  it('prefers nearby low-reward parcel over far high-reward parcel when far parcel decays to near-zero by delivery', () => {
    // Agent at (4,4). Delivery zone at (0,0).
    // p_near: reward=20, position=(5,4) → 1 step to pickup, 9 steps to delivery = 10 total steps
    // p_far:  reward=50, position=(9,9) → 9+5=14 steps to pickup, 9+9=18 steps to delivery = 32 total steps
    //
    // With movementDurationMs=100ms and high decay on p_far:
    //   p_near delivery time = now + 10*100 = now+1000ms → projected reward ≈ 20 (no decay)
    //   p_far  delivery time = now + 32*100 = now+3200ms → projected reward ≈ 0 (decays away)
    //
    // Without tracker: p_far utility = 50/32 ≈ 1.56 > p_near utility = 20/10 = 2.0
    //   (p_near already wins here; use a higher reward for p_far to make it win without tracker)
    // Adjusted: p_far reward=100 → utility = 100/32 ≈ 3.125 > 20/10 = 2 (p_far wins without tracker)
    // With tracker + decay: p_far projected ≈ 0 → p_near wins

    const now = Date.now();
    const movementDurationMs = 100;
    // p_far decays at a rate that wipes it out over 3200ms
    const pFarDecayRate = 100 / 3200; // reward/ms — will be 0 at delivery time

    const tracker = new ParcelTracker();
    // Seed tracker with two observations to establish decay rate for p_far
    tracker.observe('p_far', 100, now - 3200);
    tracker.observe('p_far', 0.1,  now);        // effectively zero by now
    tracker.observe('p_near', 20, now - 100);
    tracker.observe('p_near', 20, now);          // no decay

    const pNear = makeParcel({ id: 'p_near', position: { x: 5, y: 4 }, reward: 20, estimatedReward: 20 });
    const pFar  = makeParcel({ id: 'p_far',  position: { x: 9, y: 9 }, reward: 100, estimatedReward: 100 });

    const deliberator = new Deliberator();
    const store = mockStore([pNear, pFar]);
    const intentions = deliberator.evaluate(store, movementDurationMs, tracker);

    assert.ok(intentions.length >= 2, 'should have at least 2 intentions');
    // With decay projection, p_near should rank first
    assert.equal(
      intentions[0]!.targetParcels[0],
      'p_near',
      `Expected p_near first but got ${intentions[0]!.targetParcels[0]} (utilities: ${intentions.map(i => i.utility.toFixed(3)).join(', ')})`,
    );
  });

  it('falls back to estimatedReward when no tracker provided (backward compat)', () => {
    const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, estimatedReward: 30 });
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(mockStore([p])); // no tracker
    assert.ok(intentions.length >= 1);
    // utility should be reward / steps = 30 / (1+4) = 6 ... just check it's non-zero
    assert.ok(intentions[0]!.utility > 0);
  });
});
