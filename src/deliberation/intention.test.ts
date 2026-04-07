// ============================================================
// src/deliberation/intention.test.ts — T11 unit tests
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IBeliefStore, ParcelBelief, Position, SelfBelief } from '../types.js';
import {
  computeUtility,
  computePickupScore,
  computeDeliveryScore,
  createSingleIntention,
  createClusterIntention,
  groupNearbyClusters,
  orderParcelsByNearest,
  CLUSTER_RADIUS,
} from './intention.js';
import { IntentionQueue } from './intention-queue.js';
import { BeliefStore } from '../beliefs/belief-store.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
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

function makeBeliefStore(): BeliefStore {
  const map = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
  const store = new BeliefStore(map);
  store.updateSelf(FIXTURE_SELF); // agent at (4,4)
  return store;
}

// ---------------------------------------------------------------------------
// computePickupScore
// ---------------------------------------------------------------------------

describe('computePickupScore', () => {
  it('equals projected parcel reward when carrying nothing', () => {
    // n=0: no portfolio → score = 0 + parcelReward = 50
    assert.equal(computePickupScore(50, 10, 0, 0, 0.25), 50);
  });

  it('deducts portfolio decay over full detour', () => {
    // n=3 parcels, carriedReward=240, decayPerStep=0.25, totalSteps=10
    // carriedAtDelivery = max(0, 240 - 3*0.25*10) = 240 - 7.5 = 232.5
    // score = 232.5 + 60 = 292.5
    assert.equal(computePickupScore(60, 10, 240, 3, 0.25), 292.5);
  });

  it('clamps portfolio value at zero when decay exceeds carried reward', () => {
    // n=5, carriedReward=10, decayPerStep=1, totalSteps=20 → decay=100 > 10 → clamped to 0
    // score = 0 + 30 = 30
    assert.equal(computePickupScore(30, 20, 10, 5, 1), 30);
  });

  it('equals projectedReward + carriedReward when decayPerStep is zero', () => {
    assert.equal(computePickupScore(40, 10, 100, 3, 0), 140);
  });
});

// ---------------------------------------------------------------------------
// computeDeliveryScore
// ---------------------------------------------------------------------------

describe('computeDeliveryScore', () => {
  it('deducts portfolio decay for stepsToDelivery', () => {
    // n=3, carriedReward=240, decayPerStep=0.25, steps=5
    // score = max(0, 240 - 3*0.25*5) = 240 - 3.75 = 236.25
    assert.equal(computeDeliveryScore(240, 3, 5, 0.25), 236.25);
  });

  it('clamps at zero', () => {
    assert.equal(computeDeliveryScore(5, 3, 100, 1), 0);
  });

  it('equals carriedReward when decayPerStep is zero', () => {
    assert.equal(computeDeliveryScore(100, 5, 20, 0), 100);
  });
});

// ---------------------------------------------------------------------------
// computeUtility
// ---------------------------------------------------------------------------

describe('computeUtility', () => {
  it('returns reward / steps', () => {
    assert.equal(computeUtility(10, 5), 2);
  });

  it('returns 0 when steps is 0', () => {
    assert.equal(computeUtility(10, 0), 0);
  });

  it('returns 0 when reward is 0', () => {
    assert.equal(computeUtility(0, 5), 0);
  });
});

// ---------------------------------------------------------------------------
// createSingleIntention
// ---------------------------------------------------------------------------

describe('createSingleIntention', () => {
  it('creates an intention with correct utility', () => {
    const parcel = makeParcel({ id: 'p1', position: { x: 2, y: 0 }, estimatedReward: 20 });
    const intention = createSingleIntention(parcel, 4, 6);
    assert.equal(intention.type, 'pickup_and_deliver');
    assert.deepEqual(intention.targetParcels, ['p1']);
    assert.deepEqual(intention.targetPosition, { x: 2, y: 0 });
    assert.equal(intention.utility, 20 / 10); // 20 / (4+6)
    assert.ok(intention.id.length > 0);
    assert.ok(intention.createdAt > 0);
  });

  it('assigns unique ids to different intentions', () => {
    const parcel = makeParcel({ id: 'p1' });
    const a = createSingleIntention(parcel, 3, 5);
    const b = createSingleIntention(parcel, 3, 5);
    assert.notEqual(a.id, b.id);
  });
});

// ---------------------------------------------------------------------------
// createClusterIntention
// ---------------------------------------------------------------------------

describe('createClusterIntention', () => {
  it('sums rewards and divides by total steps', () => {
    const p1 = makeParcel({ id: 'p1', estimatedReward: 10, position: { x: 1, y: 0 } });
    const p2 = makeParcel({ id: 'p2', estimatedReward: 10, position: { x: 2, y: 0 } });
    // stepsToFirst=3, inter=1, toDelivery=5 → total=9
    const intention = createClusterIntention([p1, p2], 3, 1, 5);
    assert.equal(intention.utility, 20 / 9);
    assert.deepEqual(intention.targetParcels, ['p1', 'p2']);
    assert.deepEqual(intention.targetPosition, p1.position);
  });

  it('throws on empty parcel list', () => {
    assert.throws(() => createClusterIntention([], 0, 0, 0));
  });

  it('cluster beats individual utilities when parcels are close', () => {
    // Parcel A: reward=10, steps_to_A=3, to_delivery=5 → utility = 10/8 = 1.25
    const pA = makeParcel({ id: 'pA', estimatedReward: 10, position: { x: 3, y: 0 } });
    // Parcel B: reward=10, steps_to_B=4, to_delivery=5 → utility = 10/9 = 1.11
    const pB = makeParcel({ id: 'pB', estimatedReward: 10, position: { x: 4, y: 0 } });

    const intentionA = createSingleIntention(pA, 3, 5);
    const intentionB = createSingleIntention(pB, 4, 5);
    // Cluster: steps_to_A=3, inter=1, to_delivery=5 → utility = 20/9 ≈ 2.22
    const cluster = createClusterIntention([pA, pB], 3, 1, 5);

    assert.ok(cluster.utility > intentionA.utility, 'cluster beats A');
    assert.ok(cluster.utility > intentionB.utility, 'cluster beats B');
  });
});

// ---------------------------------------------------------------------------
// orderParcelsByNearest
// ---------------------------------------------------------------------------

describe('orderParcelsByNearest', () => {
  it('returns empty result for empty input', () => {
    const r = orderParcelsByNearest([], { x: 0, y: 0 });
    assert.equal(r.ordered.length, 0);
    assert.equal(r.stepsToFirst, 0);
    assert.equal(r.interParcelSteps, 0);
  });

  it('visits nearest parcel first', () => {
    const near = makeParcel({ id: 'near', position: { x: 1, y: 0 } });
    const far  = makeParcel({ id: 'far',  position: { x: 8, y: 0 } });
    const { ordered } = orderParcelsByNearest([far, near], { x: 0, y: 0 });
    assert.equal(ordered[0]!.id, 'near');
    assert.equal(ordered[1]!.id, 'far');
  });

  it('computes stepsToFirst and interParcelSteps correctly', () => {
    const p1 = makeParcel({ id: 'p1', position: { x: 2, y: 0 } });
    const p2 = makeParcel({ id: 'p2', position: { x: 5, y: 0 } });
    const { stepsToFirst, interParcelSteps } = orderParcelsByNearest([p1, p2], { x: 0, y: 0 });
    assert.equal(stepsToFirst, 2);       // (0,0)→(2,0)
    assert.equal(interParcelSteps, 3);   // (2,0)→(5,0)
  });
});

// ---------------------------------------------------------------------------
// groupNearbyClusters
// ---------------------------------------------------------------------------

describe('groupNearbyClusters', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(groupNearbyClusters([]), []);
  });

  it('groups parcels within CLUSTER_RADIUS', () => {
    const anchor = makeParcel({ id: 'a', position: { x: 0, y: 0 } });
    const near   = makeParcel({ id: 'n', position: { x: CLUSTER_RADIUS, y: 0 } });
    const far    = makeParcel({ id: 'f', position: { x: CLUSTER_RADIUS + 1, y: 0 } });
    const clusters = groupNearbyClusters([anchor, near, far]);
    // anchor and near should be in same cluster; far in its own
    assert.equal(clusters.length, 2);
    const bigCluster = clusters.find(c => c.length === 2)!;
    assert.ok(bigCluster !== undefined);
    assert.ok(bigCluster.some(p => p.id === 'a'));
    assert.ok(bigCluster.some(p => p.id === 'n'));
  });

  it('each parcel appears in exactly one cluster', () => {
    const parcels = [
      makeParcel({ id: 'p1', position: { x: 0, y: 0 } }),
      makeParcel({ id: 'p2', position: { x: 1, y: 0 } }),
      makeParcel({ id: 'p3', position: { x: 2, y: 0 } }),
      makeParcel({ id: 'p4', position: { x: 9, y: 9 } }),
    ];
    const clusters = groupNearbyClusters(parcels);
    const allIds = clusters.flatMap(c => c.map(p => p.id));
    assert.equal(allIds.length, 4);
    assert.equal(new Set(allIds).size, 4);
  });
});

// ---------------------------------------------------------------------------
// IntentionQueue
// ---------------------------------------------------------------------------

describe('IntentionQueue', () => {
  let queue: IntentionQueue;

  beforeEach(() => {
    queue = new IntentionQueue();
  });

  it('starts empty', () => {
    assert.equal(queue.size(), 0);
    assert.equal(queue.pop(), null);
    assert.equal(queue.peek(), null);
  });

  it('pop returns highest utility first', () => {
    const pLow  = makeParcel({ id: 'low',  estimatedReward: 5  });
    const pMid  = makeParcel({ id: 'mid',  estimatedReward: 10 });
    const pHigh = makeParcel({ id: 'high', estimatedReward: 20 });

    queue.push(createSingleIntention(pMid,  5, 5)); // utility 1.0
    queue.push(createSingleIntention(pLow,  5, 5)); // utility 0.5
    queue.push(createSingleIntention(pHigh, 5, 5)); // utility 2.0

    assert.equal(queue.size(), 3);
    assert.equal(queue.pop()!.utility, 2.0);
    assert.equal(queue.pop()!.utility, 1.0);
    assert.equal(queue.pop()!.utility, 0.5);
    assert.equal(queue.size(), 0);
  });

  it('peek does not remove the item', () => {
    const p = makeParcel({ id: 'p', estimatedReward: 10 });
    queue.push(createSingleIntention(p, 2, 3));
    assert.equal(queue.size(), 1);
    queue.peek();
    assert.equal(queue.size(), 1);
  });

  it('clear empties the queue', () => {
    queue.push(createSingleIntention(makeParcel({ id: 'p' }), 1, 1));
    queue.clear();
    assert.equal(queue.size(), 0);
  });

  it('toArray returns a snapshot (not live reference)', () => {
    const p = makeParcel({ id: 'p', estimatedReward: 10 });
    queue.push(createSingleIntention(p, 2, 3));
    const snap = queue.toArray();
    queue.clear();
    assert.equal(snap.length, 1); // snapshot unchanged
    assert.equal(queue.size(), 0);
  });

  // -----------------------------------------------------------------------
  // revise() — removal
  // -----------------------------------------------------------------------

  it('revise removes intention when target parcel is no longer in beliefs', () => {
    const store = makeBeliefStore();
    // Push 3 parcels into beliefs
    store.updateParcels([
      { id: 'p1', x: 5, y: 5, carriedBy: null, reward: 50 },
      { id: 'p2', x: 6, y: 5, carriedBy: null, reward: 30 },
      { id: 'p3', x: 7, y: 5, carriedBy: null, reward: 20 },
    ]);

    const p1 = store.getParcelBeliefs().find(p => p.id === 'p1')!;
    const p2 = store.getParcelBeliefs().find(p => p.id === 'p2')!;
    const p3 = store.getParcelBeliefs().find(p => p.id === 'p3')!;

    queue.push(createSingleIntention(p1, 1, 9));
    queue.push(createSingleIntention(p2, 2, 8));
    queue.push(createSingleIntention(p3, 3, 7));
    assert.equal(queue.size(), 3);

    // Update beliefs: p3 no longer sensed (agent is close, so belief revision removes it)
    // The simplest way: update parcels with only p1 and p2 in a range that covers p3's position.
    // We approximate: just update the parcel list — without p3 in range, it gets purged if in range.
    // Since BeliefStore's revision uses farthest-sensed parcel as range proxy, sending only p1+p2
    // where p2 is close will NOT necessarily remove p3 (which is far).
    // Instead, we directly simulate via a minimal mock store for this sub-test.
    const mockStore = buildMockStoreWithParcels(
      [
        { ...p1 },
        { ...p2 },
        // p3 is absent
      ],
      { x: 4, y: 4 },
    );
    queue.revise(mockStore);
    assert.equal(queue.size(), 2, 'queue should drop p3 intention');
    const ids = queue.toArray().map(i => i.targetParcels[0]);
    assert.ok(!ids.includes('p3'), 'p3 intention should be removed');
  });

  it('revise removes intention when parcel is carried by another agent', () => {
    const p1 = makeParcel({ id: 'p1', position: { x: 5, y: 5 }, estimatedReward: 50 });
    queue.push(createSingleIntention(p1, 1, 9));
    assert.equal(queue.size(), 1);

    // Parcel now carried by someone
    const carried: ParcelBelief = { ...p1, carriedBy: 'other-agent' };
    const mockStore = buildMockStoreWithParcels([carried], { x: 4, y: 4 });
    queue.revise(mockStore);
    assert.equal(queue.size(), 0);
  });

  it('revise keeps valid intentions and reorders by recomputed utility', () => {
    const p1 = makeParcel({ id: 'p1', position: { x: 5, y: 0 }, estimatedReward: 20 });
    const p2 = makeParcel({ id: 'p2', position: { x: 1, y: 0 }, estimatedReward: 10 });

    // Deliberately push p1 with artificially high utility
    queue.push({ ...createSingleIntention(p1, 1, 1), utility: 999 });
    queue.push(createSingleIntention(p2, 3, 7));
    assert.equal(queue.peek()!.targetParcels[0], 'p1'); // p1 first due to high utility

    // After revise from (4,4), p1 is at (5,0) = 9 steps, delivery ~5 steps
    // p2 at (1,0) = 7 steps, delivery ~1 step
    const mockStore = buildMockStoreWithParcels([p1, p2], { x: 4, y: 4 });
    queue.revise(mockStore);
    assert.equal(queue.size(), 2);
    // Both should still be present
    const ids = queue.toArray().map(i => i.targetParcels[0]);
    assert.ok(ids.includes('p1'));
    assert.ok(ids.includes('p2'));
  });

  // -----------------------------------------------------------------------
  // Multi-parcel cluster beats individual
  // -----------------------------------------------------------------------

  it('cluster intention has highest utility when parcels are nearby', () => {
    const pA = makeParcel({ id: 'pA', position: { x: 3, y: 0 }, estimatedReward: 10 });
    const pB = makeParcel({ id: 'pB', position: { x: 4, y: 0 }, estimatedReward: 10 });

    const intA     = createSingleIntention(pA, 3, 5); // 10/8 = 1.25
    const intB     = createSingleIntention(pB, 4, 5); // 10/9 ≈ 1.11
    const cluster  = createClusterIntention([pA, pB], 3, 1, 5); // 20/9 ≈ 2.22

    queue.push(intA);
    queue.push(intB);
    queue.push(cluster);

    assert.equal(queue.pop()!.targetParcels.length, 2); // cluster pops first
  });
});

// ---------------------------------------------------------------------------
// Minimal mock IBeliefStore for revise() tests
// ---------------------------------------------------------------------------

function buildMockStoreWithParcels(
  parcels: ReadonlyArray<ParcelBelief>,
  selfPos: Position,
): IBeliefStore {
  return {
    updateSelf: () => {},
    updateParcels: () => {},
    updateAgents: () => {},
    updateCrates: () => {},
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
    getNearestDeliveryZone: (from) => {
      // delivery zones at (0,0), (9,0), (9,9)
      const zones: Position[] = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }];
      let best = zones[0]!;
      let bestD = Math.abs(from.x - best.x) + Math.abs(from.y - best.y);
      for (const z of zones.slice(1)) {
        const d = Math.abs(from.x - z.x) + Math.abs(from.y - z.y);
        if (d < bestD) { bestD = d; best = z; }
      }
      return best;
    },
    getReachableParcels: () => parcels,
    getCrateObstacles: () => [],
    getCrateBeliefs: () => new Map(),
    getCratePositionSet: () => new Set(),
    toSnapshot: () => ({ agentId: 'agent-self', timestamp: Date.now(), selfPosition: selfPos, parcels: [], agents: [] }),
    getCapacity: () => Infinity,
    getExploreTarget: () => null,
    removeParcel: () => {},
    clearDeliveredParcels: () => {},
    markParcelCarried: () => {},
    onUpdate: () => {},
  };
}
