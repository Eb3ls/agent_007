// ============================================================
// src/planning/bfs-planner.test.ts — T13 unit tests
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ParcelBelief, PlanStep, Position } from '../types.js';
import { BfsPlanner } from './bfs-planner.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_DELIVERY_ZONES,
} from '../testing/fixtures.js';
import { findPath } from '../pathfinding/pathfinder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixtureMap = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);

function makeParcel(id: string, pos: Position, reward = 10): ParcelBelief {
  return {
    id,
    position: pos,
    carriedBy: null,
    reward,
    estimatedReward: reward,
    lastSeen: Date.now(),
    confidence: 1,
    decayRatePerMs: 0,
  };
}

/** Count pickup and putdown steps in a step list. */
function countAction(steps: ReadonlyArray<PlanStep>, action: string): number {
  return steps.filter(s => s.action === action).length;
}

/** Verify every consecutive pair of move steps is a valid 1-tile move. */
function assertValidMoves(steps: ReadonlyArray<PlanStep>, startPos: Position): void {
  let pos = startPos;
  for (const step of steps) {
    if (step.action === 'pickup' || step.action === 'putdown') {
      assert.deepEqual(step.expectedPosition, pos, `${step.action} at wrong position`);
      continue;
    }
    const dx = step.expectedPosition.x - pos.x;
    const dy = step.expectedPosition.y - pos.y;
    assert.equal(Math.abs(dx) + Math.abs(dy), 1, `move step is not 1 tile`);
    assert.ok(
      fixtureMap.isWalkable(step.expectedPosition.x, step.expectedPosition.y),
      `move step lands on non-walkable tile (${step.expectedPosition.x},${step.expectedPosition.y})`,
    );
    pos = step.expectedPosition;
  }
}

// ---------------------------------------------------------------------------
// BfsPlanner — single parcel
// ---------------------------------------------------------------------------

describe('BfsPlanner — single parcel', () => {
  let planner: BfsPlanner;

  beforeEach(() => { planner = new BfsPlanner(); });

  it('name is "bfs"', () => {
    assert.equal(planner.name, 'bfs');
  });

  it('returns a valid plan: move to parcel, pickup, move to delivery, putdown', async () => {
    // Agent at (0,1), parcel at (0,5), delivery zone at (0,0)
    // Column x=0 is wall-free. Path (0,1)→(0,5): 4 moves. Path (0,5)→(0,0): 5 moves.
    const startPos: Position = { x: 0, y: 1 };
    const parcel = makeParcel('p1', { x: 0, y: 5 }, 50);

    const result = await planner.plan({
      currentPosition: startPos,
      carriedParcels: [],
      targetParcels: [parcel],
      deliveryZones: [{ x: 0, y: 0 }],
      beliefMap: fixtureMap,
    });

    assert.ok(result.success, result.error);
    assert.ok(result.plan !== null);
    assert.equal(result.metadata.plannerName, 'bfs');

    const steps = result.plan!.steps;

    // Structure: exactly 1 pickup and 1 putdown
    assert.equal(countAction(steps, 'pickup'), 1);
    assert.equal(countAction(steps, 'putdown'), 1);

    // Pickup comes before putdown
    const pickIdx = steps.findIndex(s => s.action === 'pickup');
    const putIdx  = steps.findIndex(s => s.action === 'putdown');
    assert.ok(pickIdx < putIdx, 'pickup must precede putdown');

    // Pickup happens at parcel position
    assert.deepEqual(steps[pickIdx]!.expectedPosition, parcel.position);

    // All moves are valid 1-tile steps to walkable tiles
    assertValidMoves(steps, startPos);
  });

  it('total steps = path_to_parcel + 1(pickup) + path_to_delivery + 1(putdown)', async () => {
    const startPos: Position = { x: 0, y: 1 };
    const parcelPos: Position = { x: 0, y: 5 };
    const deliveryPos: Position = { x: 0, y: 0 };
    const parcel = makeParcel('p1', parcelPos, 50);

    const result = await planner.plan({
      currentPosition: startPos,
      carriedParcels: [],
      targetParcels: [parcel],
      deliveryZones: [deliveryPos],
      beliefMap: fixtureMap,
    });

    assert.ok(result.success);
    const steps = result.plan!.steps;

    const pathToParcel   = findPath(startPos, parcelPos, fixtureMap)!;
    const pathToDelivery = findPath(parcelPos, deliveryPos, fixtureMap)!;
    const expected = (pathToParcel.length - 1) + 1 + (pathToDelivery.length - 1) + 1;

    assert.equal(steps.length, expected,
      `expected ${expected} steps, got ${steps.length}`);
  });

  it('returns { success: false } when no path to parcel', async () => {
    // Surround (5,5) with non-walkable tiles — simulate by targeting a wall
    const parcel = makeParcel('p1', { x: 2, y: 2 }, 10); // (2,2) is a wall in fixture

    const result = await planner.plan({
      currentPosition: { x: 0, y: 0 },
      carriedParcels: [],
      targetParcels: [parcel],
      deliveryZones: [{ x: 0, y: 0 }],
      beliefMap: fixtureMap,
    });

    assert.equal(result.success, false);
    assert.equal(result.plan, null);
  });

  it('returns { success: false } for empty target parcels', async () => {
    const result = await planner.plan({
      currentPosition: { x: 0, y: 1 },
      carriedParcels: [],
      targetParcels: [],
      deliveryZones: [{ x: 0, y: 0 }],
      beliefMap: fixtureMap,
    });

    assert.equal(result.success, false);
  });

  it('returns { success: false } when no delivery zones', async () => {
    const parcel = makeParcel('p1', { x: 0, y: 5 }, 10);
    const result = await planner.plan({
      currentPosition: { x: 0, y: 1 },
      carriedParcels: [],
      targetParcels: [parcel],
      deliveryZones: [],
      beliefMap: fixtureMap,
    });

    assert.equal(result.success, false);
  });

  it('plan includes estimated reward from target parcels', async () => {
    const parcel = makeParcel('p1', { x: 0, y: 5 }, 77);
    const result = await planner.plan({
      currentPosition: { x: 0, y: 1 },
      carriedParcels: [],
      targetParcels: [parcel],
      deliveryZones: [{ x: 0, y: 0 }],
      beliefMap: fixtureMap,
    });

    assert.ok(result.success);
    assert.equal(result.plan!.estimatedReward, 77);
  });

  it('respects maxPlanLength constraint', async () => {
    const parcel = makeParcel('p1', { x: 9, y: 9 }, 10); // far from (0,1)
    const result = await planner.plan({
      currentPosition: { x: 0, y: 1 },
      carriedParcels: [],
      targetParcels: [parcel],
      deliveryZones: FIXTURE_DELIVERY_ZONES as Position[],
      beliefMap: fixtureMap,
      constraints: { maxPlanLength: 3 }, // too short for any valid plan
    });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('maxPlanLength'));
  });
});

// ---------------------------------------------------------------------------
// BfsPlanner — permutation optimisation (≤4 parcels)
// ---------------------------------------------------------------------------

describe('BfsPlanner — permutation optimisation', () => {
  let planner: BfsPlanner;

  beforeEach(() => { planner = new BfsPlanner(); });

  it('with 3 parcels returns a valid plan', async () => {
    // Three open-column parcels around the agent
    const startPos: Position = { x: 5, y: 5 };
    const p1 = makeParcel('p1', { x: 1, y: 5 }, 10);
    const p2 = makeParcel('p2', { x: 5, y: 1 }, 10);
    const p3 = makeParcel('p3', { x: 5, y: 8 }, 10);

    const result = await planner.plan({
      currentPosition: startPos,
      carriedParcels: [],
      targetParcels: [p1, p2, p3],
      deliveryZones: FIXTURE_DELIVERY_ZONES as Position[],
      beliefMap: fixtureMap,
    });

    assert.ok(result.success, result.error);
    const steps = result.plan!.steps;
    assert.equal(countAction(steps, 'pickup'), 3);
    assert.equal(countAction(steps, 'putdown'), 1);
    assertValidMoves(steps, startPos);
  });

  it('selects shorter permutation over longer one', async () => {
    // Start at (1,1). p_near at (1,5) (4 steps), p_far at (8,5) (11 steps from start).
    // Nearest delivery to p_near is (0,0) → 6 steps; nearest delivery to p_far is (9,0) → 6 steps.
    // Best order: p_near → p_far vs p_far → p_near
    //   p_near→p_far: 4 + 1 + 7 + 1 + 6 + 1 = 20
    //   p_far→p_near: 11 + 1 + 7 + 1 + 6 + 1 = 27
    // Planner should pick p_near first.
    const startPos: Position = { x: 1, y: 1 };
    const p_near = makeParcel('near', { x: 1, y: 5 }, 10);
    const p_far  = makeParcel('far',  { x: 8, y: 5 }, 10);

    const result = await planner.plan({
      currentPosition: startPos,
      carriedParcels: [],
      targetParcels: [p_far, p_near], // intentionally un-ordered input
      deliveryZones: FIXTURE_DELIVERY_ZONES as Position[],
      beliefMap: fixtureMap,
    });

    assert.ok(result.success, result.error);

    // Optimal plan visits p_near before p_far
    const steps = result.plan!.steps;
    const pickups = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.action === 'pickup');

    assert.equal(pickups.length, 2);
    // First pickup should be at p_near's position
    assert.deepEqual(pickups[0]!.s.expectedPosition, p_near.position,
      'planner should pick up the near parcel first');
  });
});

// ---------------------------------------------------------------------------
// BfsPlanner — nearest-neighbour heuristic (5+ parcels)
// ---------------------------------------------------------------------------

describe('BfsPlanner — nearest-neighbour heuristic', () => {
  let planner: BfsPlanner;

  beforeEach(() => { planner = new BfsPlanner(); });

  it('handles 5 parcels without error', async () => {
    const startPos: Position = { x: 0, y: 5 };
    const parcels = [
      makeParcel('p1', { x: 0, y: 8 }, 10),
      makeParcel('p2', { x: 0, y: 4 }, 10),
      makeParcel('p3', { x: 0, y: 1 }, 10),
      makeParcel('p4', { x: 1, y: 5 }, 10),
      makeParcel('p5', { x: 4, y: 5 }, 10),
    ];

    const result = await planner.plan({
      currentPosition: startPos,
      carriedParcels: [],
      targetParcels: parcels,
      deliveryZones: FIXTURE_DELIVERY_ZONES as Position[],
      beliefMap: fixtureMap,
    });

    assert.ok(result.success, result.error);
    assert.equal(countAction(result.plan!.steps, 'pickup'), 5);
    assert.equal(countAction(result.plan!.steps, 'putdown'), 1);
    assertValidMoves(result.plan!.steps, startPos);
  });
});

// ---------------------------------------------------------------------------
// BfsPlanner — timeout and abort
// ---------------------------------------------------------------------------

describe('BfsPlanner — timeout & abort', () => {
  let planner: BfsPlanner;

  beforeEach(() => { planner = new BfsPlanner(); });

  it('returns { success: false } when timeoutMs expires', async () => {
    const parcels = Array.from({ length: 4 }, (_, i) =>
      makeParcel(`p${i}`, { x: i, y: 1 }, 10),
    );

    const result = await planner.plan({
      currentPosition: { x: 0, y: 0 },
      carriedParcels: [],
      targetParcels: parcels,
      deliveryZones: [{ x: 0, y: 0 }],
      beliefMap: fixtureMap,
      constraints: { timeoutMs: -1 }, // deadline already in the past
    });

    assert.equal(result.success, false);
    assert.ok(result.error?.toLowerCase().includes('timeout'));
  });

  it('returns { success: false } when aborted before plan call', async () => {
    const parcel = makeParcel('p1', { x: 0, y: 5 }, 10);
    planner.abort();

    const result = await planner.plan({
      currentPosition: { x: 0, y: 1 },
      carriedParcels: [],
      targetParcels: [parcel],
      deliveryZones: [{ x: 0, y: 0 }],
      beliefMap: fixtureMap,
    });

    assert.equal(result.success, false);
    assert.ok(result.error?.toLowerCase().includes('abort'));
  });
});
