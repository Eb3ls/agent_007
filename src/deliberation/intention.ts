// ============================================================
// src/deliberation/intention.ts — Intention creation & utility scoring (T11)
// ============================================================

import { randomUUID } from 'crypto';
import type { Intention, ParcelBelief, Position } from '../types.js';
import { manhattanDistance } from '../types.js';
import { posKey } from '../pathfinding/distance-map.js';

/** Max Manhattan distance between parcels to be grouped in a cluster. */
export const CLUSTER_RADIUS = 3;

/**
 * Core utility formula: reward divided by total steps required.
 * Higher = better.
 */
export function computeUtility(totalReward: number, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  return totalReward / totalSteps;
}

/**
 * Portfolio-aware score for a pickup detour.
 *
 * Returns the total portfolio value (carried + new parcel) at delivery time,
 * accounting for the decay all carried parcels suffer during the detour.
 *
 * @param projectedParcelReward  Projected reward of the new parcel at delivery.
 * @param stepsTotal             Total steps: stepsToParcel + stepsToDelivery.
 * @param carriedReward          Sum of current rewards of all carried parcels.
 * @param numCarried             Number of carried parcels.
 * @param decayPerStep           decayRate * movementDurationMs (reward lost per step per parcel).
 */
export function computePickupScore(
  projectedParcelReward: number,
  stepsTotal: number,
  carriedReward: number,
  numCarried: number,
  decayPerStep: number,
): number {
  const carriedAtDelivery = Math.max(0, carriedReward - numCarried * decayPerStep * stepsTotal);
  return carriedAtDelivery + projectedParcelReward;
}

/**
 * Portfolio-aware score for delivering now (no further pickup).
 *
 * Returns the total carried reward at delivery time after accounting for
 * the decay all parcels suffer on the way to the delivery zone.
 *
 * @param carriedReward    Sum of current rewards of all carried parcels.
 * @param numCarried       Number of carried parcels.
 * @param stepsToDelivery  Steps from current position to nearest delivery zone.
 * @param decayPerStep     decayRate * movementDurationMs (reward lost per step per parcel).
 */
export function computeDeliveryScore(
  carriedReward: number,
  numCarried: number,
  stepsToDelivery: number,
  decayPerStep: number,
): number {
  return Math.max(0, carriedReward - numCarried * decayPerStep * stepsToDelivery);
}

/**
 * Create an intention to pick up a single parcel and deliver it.
 *
 * @param projectedReward  Expected reward at delivery time (after decay).
 *                         Defaults to parcel.estimatedReward when not provided.
 */
export function createSingleIntention(
  parcel: ParcelBelief,
  stepsToParcel: number,
  stepsToDelivery: number,
  projectedReward = parcel.estimatedReward,
): Intention {
  const utility = computeUtility(projectedReward, stepsToParcel + stepsToDelivery);
  return {
    id: randomUUID(),
    type: 'pickup_and_deliver',
    targetParcels: [parcel.id],
    targetPosition: parcel.position,
    utility,
    createdAt: Date.now(),
  };
}

/**
 * Create an intention to pick up multiple parcels (in the given order) and deliver them.
 *
 * @param parcels          Parcels in pickup order (nearest-first is recommended).
 * @param stepsToFirst     Path steps from agent to parcels[0].
 * @param interParcelSteps Sum of steps between consecutive parcel positions.
 * @param stepsToDelivery  Steps from last parcel to delivery zone.
 * @param projectedRewards Expected rewards at delivery time (after decay), one per parcel.
 *                         Defaults to each parcel's estimatedReward when not provided.
 */
export function createClusterIntention(
  parcels: ReadonlyArray<ParcelBelief>,
  stepsToFirst: number,
  interParcelSteps: number,
  stepsToDelivery: number,
  projectedRewards?: ReadonlyArray<number>,
): Intention {
  if (parcels.length === 0) throw new Error('Cannot create cluster intention with no parcels');
  const totalReward = projectedRewards
    ? projectedRewards.reduce((sum, r) => sum + r, 0)
    : parcels.reduce((sum, p) => sum + p.estimatedReward, 0);
  const totalSteps = stepsToFirst + interParcelSteps + stepsToDelivery;
  return {
    id: randomUUID(),
    type: 'pickup_and_deliver',
    targetParcels: parcels.map(p => p.id),
    targetPosition: parcels[0]!.position,
    utility: computeUtility(totalReward, totalSteps),
    createdAt: Date.now(),
  };
}

/**
 * Create an explore intention targeting the given spawning tile.
 * Utility is intentionally low (0.1) so any visible parcel supersedes it.
 */
export function createExploreIntention(target: Position): Intention {
  return {
    id: randomUUID(),
    type: 'explore',
    targetParcels: [],
    targetPosition: target,
    utility: 0.1,
    createdAt: Date.now(),
  };
}

/**
 * Sort parcels in nearest-neighbour order starting from `from`.
 * Returns the ordered list and the total inter-parcel steps.
 *
 * When `distanceMap` and `mapWidth` are provided, `stepsToFirst` is computed
 * using the exact BFS distance from the agent to the first parcel.
 * Inter-parcel distances always use Manhattan (BFS from each parcel would be O(N×W×H)).
 */
export function orderParcelsByNearest(
  parcels: ReadonlyArray<ParcelBelief>,
  from: Position,
  distanceMap?: Map<number, number>,
  mapWidth?: number,
): { ordered: ParcelBelief[]; interParcelSteps: number; stepsToFirst: number } {
  if (parcels.length === 0) return { ordered: [], interParcelSteps: 0, stepsToFirst: 0 };
  const remaining = [...parcels];
  const ordered: ParcelBelief[] = [];
  let current = from;
  let interParcelSteps = 0;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = manhattanDistance(current, remaining[0]!.position);
    for (let i = 1; i < remaining.length; i++) {
      const d = manhattanDistance(current, remaining[i]!.position);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0]!;
    if (ordered.length > 0) interParcelSteps += manhattanDistance(current, next.position);
    ordered.push(next);
    current = next.position;
  }

  const first = ordered[0]!;
  const stepsToFirst = (distanceMap !== undefined && mapWidth !== undefined)
    ? (distanceMap.get(posKey(first.position.x, first.position.y, mapWidth)) ?? manhattanDistance(from, first.position))
    : manhattanDistance(from, first.position);
  return { ordered, interParcelSteps, stepsToFirst };
}

/**
 * Group parcels into clusters where every parcel is within `maxRadius`
 * Manhattan distance of the cluster anchor.
 * Single-parcel clusters are included.
 */
export function groupNearbyClusters(
  parcels: ReadonlyArray<ParcelBelief>,
  maxRadius: number = CLUSTER_RADIUS,
): ReadonlyArray<ReadonlyArray<ParcelBelief>> {
  if (parcels.length === 0) return [];
  const assigned = new Set<string>();
  const clusters: Array<ReadonlyArray<ParcelBelief>> = [];

  for (const anchor of parcels) {
    if (assigned.has(anchor.id)) continue;
    const cluster: ParcelBelief[] = [anchor];
    assigned.add(anchor.id);
    for (const other of parcels) {
      if (assigned.has(other.id)) continue;
      if (manhattanDistance(anchor.position, other.position) <= maxRadius) {
        cluster.push(other);
        assigned.add(other.id);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}
