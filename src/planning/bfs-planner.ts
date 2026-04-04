// ============================================================
// src/planning/bfs-planner.ts — BFS/A* planner (T13)
// Generates Plans from PlanningRequests by pathfinding to parcels
// then to a delivery zone. Tries all permutations for ≤4 parcels;
// uses nearest-neighbour heuristic for ≥5.
// ============================================================

import { randomUUID } from 'crypto';
import type {
  ActionType,
  BeliefMap,
  IPlanner,
  ParcelBelief,
  Plan,
  PlanStep,
  PlanningRequest,
  PlanningResult,
  Position,
} from '../types.js';
import { manhattanDistance } from '../types.js';
import { findPath } from '../pathfinding/pathfinder.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a single step between adjacent positions to an ActionType. */
function posToAction(from: Position, to: Position): ActionType {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 1)  return 'move_right';
  if (dx === -1) return 'move_left';
  if (dy === 1)  return 'move_up';
  if (dy === -1) return 'move_down';
  throw new Error(`Invalid move: (${from.x},${from.y}) → (${to.x},${to.y})`);
}

/** Convert a Position[] path into PlanStep[] (excludes the start position). */
function pathToSteps(path: Position[]): PlanStep[] {
  const steps: PlanStep[] = [];
  for (let i = 1; i < path.length; i++) {
    steps.push({ action: posToAction(path[i - 1]!, path[i]!), expectedPosition: path[i]! });
  }
  return steps;
}

/**
 * Return the delivery zone with the smallest Manhattan distance from `from`.
 * When `avoidPositions` are provided, prefer zones not currently occupied
 * by dynamic obstacles (NPCs) — falls back to nearest overall if all are blocked.
 */
function nearestDelivery(
  from: Position,
  zones: ReadonlyArray<Position>,
  avoidPositions?: ReadonlyArray<Position>,
): Position | null {
  if (zones.length === 0) return null;

  // Sort all zones by Manhattan distance
  const sorted = [...zones].sort((a, b) => manhattanDistance(from, a) - manhattanDistance(from, b));

  if (avoidPositions && avoidPositions.length > 0) {
    // Prefer the closest zone that is NOT occupied by a dynamic obstacle
    const unblocked = sorted.find(z => !avoidPositions.some(o => o.x === z.x && o.y === z.y));
    if (unblocked) return unblocked;
  }

  return sorted[0]!; // fall back to nearest regardless
}

/**
 * Build a complete plan for a given parcel pickup order:
 *   move to parcel₁ → pickup → move to parcel₂ → pickup → … → move to delivery → putdown
 * Returns null if any path is unreachable.
 */
function buildPlanForOrder(
  startPos: Position,
  order: ReadonlyArray<ParcelBelief>,
  deliveryZones: ReadonlyArray<Position>,
  map: BeliefMap,
  avoidPositions?: ReadonlyArray<Position>,
): { steps: PlanStep[]; totalSteps: number } | null {
  const steps: PlanStep[] = [];
  let current = startPos;

  for (const parcel of order) {
    // Skip immediately if the parcel tile is occupied by an agent obstacle
    if (avoidPositions?.some(p => p.x === parcel.position.x && p.y === parcel.position.y)) {
      return null;
    }
    const path = findPath(current, parcel.position, map, avoidPositions);
    if (!path) return null;
    steps.push(...pathToSteps(path));
    steps.push({ action: 'pickup', expectedPosition: parcel.position });
    current = parcel.position;
  }

  const delivery = nearestDelivery(current, deliveryZones, avoidPositions);
  if (!delivery) return null;

  const path = findPath(current, delivery, map, avoidPositions);
  if (!path) return null;
  steps.push(...pathToSteps(path));
  steps.push({ action: 'putdown', expectedPosition: delivery });

  return { steps, totalSteps: steps.length };
}

/** Generate all permutations of an array. */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [[...arr]];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i]!, ...perm]);
    }
  }
  return result;
}

/** Order parcels greedily from `start` using nearest-neighbour. */
function nearestNeighborOrder(start: Position, parcels: ParcelBelief[]): ParcelBelief[] {
  const remaining = [...parcels];
  const ordered: ParcelBelief[] = [];
  let current = start;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = manhattanDistance(current, remaining[0]!.position);
    for (let i = 1; i < remaining.length; i++) {
      const d = manhattanDistance(current, remaining[i]!.position);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0]!;
    ordered.push(next);
    current = next.position;
  }

  return ordered;
}

// ---------------------------------------------------------------------------
// BfsPlanner
// ---------------------------------------------------------------------------

export class BfsPlanner implements IPlanner {
  readonly name = 'bfs';

  private _aborted = false;

  abort(): void {
    this._aborted = true;
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    const startTime = Date.now();

    const { currentPosition, targetParcels, deliveryZones, beliefMap, constraints } = request;
    const avoidPositions = constraints?.avoidPositions;
    const timeoutMs      = constraints?.timeoutMs ?? Infinity;
    const maxPlanLength  = constraints?.maxPlanLength ?? Infinity;
    const deadline       = startTime + timeoutMs;

    // fail() resets the abort flag so the planner is reusable after an abort
    const fail = (error: string): PlanningResult => {
      this._aborted = false;
      return {
        success: false,
        plan: null,
        metadata: { plannerName: this.name, computeTimeMs: Date.now() - startTime, stepsGenerated: 0 },
        error,
      };
    };

    if (this._aborted)             return fail('Aborted');
    if (targetParcels.length === 0) return fail('No target parcels');

    let bestSteps: PlanStep[] | null = null;

    if (targetParcels.length <= 4) {
      // Try all permutations; keep the shortest valid plan
      for (const perm of permutations([...targetParcels])) {
        if (this._aborted)           return fail('Aborted');
        if (Date.now() > deadline)   return fail('Timeout');

        const result = buildPlanForOrder(currentPosition, perm, deliveryZones, beliefMap, avoidPositions);
        if (result && (bestSteps === null || result.totalSteps < bestSteps.length)) {
          bestSteps = result.steps;
        }
      }
    } else {
      // Nearest-neighbour heuristic for 5+ parcels
      if (this._aborted)          return fail('Aborted');
      if (Date.now() > deadline)  return fail('Timeout');

      const ordered = nearestNeighborOrder(currentPosition, [...targetParcels]);
      const result  = buildPlanForOrder(currentPosition, ordered, deliveryZones, beliefMap, avoidPositions);
      if (result) bestSteps = result.steps;
    }

    // Fallback: retry without dynamic obstacles — agents move, so a plan ignoring
    // their current position may still be executable by the time it reaches them.
    if (!bestSteps && avoidPositions && avoidPositions.length > 0) {
      if (targetParcels.length <= 4) {
        for (const perm of permutations([...targetParcels])) {
          if (this._aborted) return fail('Aborted');
          const result = buildPlanForOrder(currentPosition, perm, deliveryZones, beliefMap);
          if (result && (bestSteps === null || result.totalSteps < bestSteps.length)) {
            bestSteps = result.steps;
          }
        }
      } else {
        const ordered = nearestNeighborOrder(currentPosition, [...targetParcels]);
        const result = buildPlanForOrder(currentPosition, ordered, deliveryZones, beliefMap);
        if (result) bestSteps = result.steps;
      }
    }

    if (!bestSteps)                          return fail('No path found');
    if (bestSteps.length > maxPlanLength)    return fail(`Plan length ${bestSteps.length} exceeds maxPlanLength`);

    const estimatedReward = targetParcels.reduce((sum, p) => sum + p.estimatedReward, 0);

    const plan: Plan = {
      id:              randomUUID(),
      intentionId:     '',   // caller (BDI Agent) sets this
      steps:           bestSteps,
      estimatedReward,
      createdAt:       Date.now(),
    };

    this._aborted = false;
    return {
      success: true,
      plan,
      metadata: {
        plannerName:   this.name,
        computeTimeMs: Date.now() - startTime,
        stepsGenerated: bestSteps.length,
      },
    };
  }
}
