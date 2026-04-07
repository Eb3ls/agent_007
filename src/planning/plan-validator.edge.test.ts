// ============================================================
// src/planning/plan-validator.edge.test.ts — Edge cases for PlanValidator
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IBeliefStore, ParcelBelief, Plan, PlanStep, Position, SelfBelief } from '../types.js';
import { PlanValidator } from './plan-validator.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_DELIVERY_ZONES,
} from '../testing/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixtureMap = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);

function makeParcel(id: string, pos: Position, carriedBy: string | null = null): ParcelBelief {
  return { id, position: pos, carriedBy, reward: 10, estimatedReward: 10, lastSeen: Date.now(), confidence: 1, decayRatePerMs: 0 };
}

function mockBeliefs(parcels: ReadonlyArray<ParcelBelief>, selfPos: Position): IBeliefStore {
  const zones = FIXTURE_DELIVERY_ZONES as Position[];
  return {
    updateSelf: () => {},
    updateParcels: () => {},
    updateAgents: () => {},
    updateCrates: () => {},
    mergeRemoteBelief: () => {},
    getSelf: () => ({
      id: 'agent-self', name: 'TestAgent', position: selfPos,
      score: 0, penalty: 0, carriedParcels: [],
    } satisfies SelfBelief),
    getParcelBeliefs: () => parcels,
    getAgentBeliefs: () => [],
    getMap: () => fixtureMap,
    getNearestDeliveryZone: () => zones[0]!,
    getReachableParcels: () => parcels.filter(p => p.carriedBy === null),
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

function makePlan(steps: PlanStep[]): Plan {
  return { id: 'test-plan', intentionId: '', steps, estimatedReward: 10, createdAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlanValidator — edge cases', () => {
  let validator: PlanValidator;

  beforeEach(() => { validator = new PlanValidator(); });

  // --- Multiple pickup steps ---

  it('validates a plan with two pickup steps (both parcels present)', () => {
    const p1pos: Position = { x: 4, y: 4 };
    const p2pos: Position = { x: 5, y: 4 };
    const beliefs = mockBeliefs(
      [makeParcel('p1', p1pos), makeParcel('p2', p2pos)],
      p1pos,
    );
    const plan = makePlan([
      { action: 'pickup', expectedPosition: p1pos },  // agent at p1pos
      { action: 'move_right', expectedPosition: p2pos },
      { action: 'pickup', expectedPosition: p2pos },
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.ok(vr.valid, vr.reason);
  });

  it('fails when second pickup has no parcel', () => {
    const p1pos: Position = { x: 4, y: 4 };
    const p2pos: Position = { x: 5, y: 4 };
    // Only p1 present, not p2
    const beliefs = mockBeliefs([makeParcel('p1', p1pos)], p1pos);
    const plan = makePlan([
      { action: 'pickup', expectedPosition: p1pos },
      { action: 'move_right', expectedPosition: p2pos },
      { action: 'pickup', expectedPosition: p2pos }, // no parcel here
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.equal(vr.valid, false);
    assert.ok(vr.reason?.includes('no longer exists'), vr.reason);
  });

  // --- Putdown at wrong position (agent not there) ---

  it('fails when putdown step expectedPosition != agent current position', () => {
    const agentPos: Position = { x: 0, y: 0 };
    const wrongPos: Position = { x: 9, y: 0 }; // delivery zone but agent is not there
    const beliefs = mockBeliefs([], agentPos);
    const plan = makePlan([
      { action: 'putdown', expectedPosition: wrongPos },
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.equal(vr.valid, false);
    assert.ok(vr.reason?.includes('wrong position'), vr.reason);
  });

  // --- Sequence: move to delivery, putdown (happy path) ---

  it('accepts move-to-delivery then putdown', () => {
    // Agent at (1,0), delivery at (0,0)
    const agentPos: Position = { x: 1, y: 0 };
    const deliveryPos: Position = { x: 0, y: 0 };
    const beliefs = mockBeliefs([], agentPos);
    const plan = makePlan([
      { action: 'move_left', expectedPosition: deliveryPos },
      { action: 'putdown', expectedPosition: deliveryPos },
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.ok(vr.valid, vr.reason);
  });

  // --- Plan with only pickup/putdown at same position (no moves) ---

  it('accepts pickup followed immediately by putdown at delivery zone', () => {
    // Agent at delivery zone (0,0) with a parcel there
    const pos: Position = { x: 0, y: 0 };
    const beliefs = mockBeliefs([makeParcel('p1', pos)], pos);
    const plan = makePlan([
      { action: 'pickup', expectedPosition: pos },
      { action: 'putdown', expectedPosition: pos },
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.ok(vr.valid, vr.reason);
  });

  // --- Non-adjacent move (teleport) in the middle of plan ---

  it('fails when a mid-plan move step is not from adjacent tile', () => {
    // Agent at (0,0), first move to (0,1) is valid, second move skips to (0,5)
    const beliefs = mockBeliefs([], { x: 0, y: 0 });
    const plan = makePlan([
      { action: 'move_up', expectedPosition: { x: 0, y: 1 } },   // valid
      { action: 'move_up', expectedPosition: { x: 0, y: 5 } },   // teleport! dist=4
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.equal(vr.valid, false);
    assert.ok(vr.reason?.includes('wrong position'), vr.reason);
  });

  // --- Pickup step after move leaves agent at parcel position ---

  it('accepts pickup step after move that places agent at parcel', () => {
    const agentStart: Position = { x: 0, y: 0 };
    const parcelPos: Position = { x: 0, y: 1 };
    const beliefs = mockBeliefs([makeParcel('p1', parcelPos)], agentStart);
    const plan = makePlan([
      { action: 'move_up', expectedPosition: parcelPos },
      { action: 'pickup', expectedPosition: parcelPos },
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.ok(vr.valid, vr.reason);
  });

  // --- Carried-by-self parcel treated as missing in pickup validation ---

  it('fails when target parcel is carried by self (treated as unavailable)', () => {
    const pos: Position = { x: 4, y: 4 };
    // carriedBy = 'agent-self' → not null → not in parcelAtPos map
    const beliefs = mockBeliefs([makeParcel('p1', pos, 'agent-self')], pos);
    const plan = makePlan([
      { action: 'pickup', expectedPosition: pos },
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.equal(vr.valid, false);
    assert.ok(vr.reason?.includes('no longer exists'), vr.reason);
  });

  // --- Move step back to previous position (valid as long as walkable) ---

  it('accepts a plan that moves right then immediately back left', () => {
    const start: Position = { x: 4, y: 4 };
    const right: Position = { x: 5, y: 4 };
    const beliefs = mockBeliefs([], start);
    const plan = makePlan([
      { action: 'move_right', expectedPosition: right },
      { action: 'move_left',  expectedPosition: start },
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.ok(vr.valid, vr.reason);
  });

  // --- Wall diagonal: non-walkable tile caught regardless of step index ---

  it('fails when step at index >0 moves into a wall', () => {
    // Agent at (1,1): move up to (1,2) OK; then move right to (2,2) which is a wall
    const beliefs = mockBeliefs([], { x: 1, y: 1 });
    const plan = makePlan([
      { action: 'move_up',    expectedPosition: { x: 1, y: 2 } }, // walkable
      { action: 'move_right', expectedPosition: { x: 2, y: 2 } }, // WALL
    ]);
    const vr = validator.validate(plan, beliefs);
    assert.equal(vr.valid, false);
    assert.ok(vr.reason?.includes('non-walkable'), vr.reason);
  });
});
