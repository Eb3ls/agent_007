// ============================================================
// src/deliberation/deliberator.ts — Deliberator: intention selection & replan trigger (T12)
// ============================================================

import type { IBeliefStore, Intention } from '../types.js';
import { manhattanDistance } from '../types.js';
import type { ParcelTracker } from '../beliefs/parcel-tracker.js';
import {
  createClusterIntention,
  createExploreIntention,
  createSingleIntention,
  groupNearbyClusters,
  orderParcelsByNearest,
} from './intention.js';

/**
 * A candidate must have at least this multiple of the current intention's
 * utility to justify abandoning the current plan and replanning.
 */
export const REPLAN_UTILITY_THRESHOLD = 1.5;

export class Deliberator {
  /**
   * Generate and score all candidate intentions from current beliefs.
   *
   * One intention is created per reachable parcel (single) plus one per
   * multi-parcel cluster. Step counts are approximated via Manhattan distance
   * so this method is cheap enough to call on every sensing update.
   *
   * When `tracker` and `movementDurationMs` are provided, parcel rewards are
   * projected to their estimated value at delivery time, accounting for decay.
   *
   * Returns intentions sorted by utility descending.
   */
  evaluate(beliefs: IBeliefStore, movementDurationMs = 500, tracker?: ParcelTracker): Intention[] {
    const allReachable = beliefs.getReachableParcels();
    // R15: filter out parcels with reward <= 0 before generating intentions.
    // Expired parcels remain in the belief set as obstacles/noise but must not be pursued.
    const reachable = allReachable.filter(p => p.reward > 0);
    if (reachable.length === 0) {
      // No parcels visible — explore toward nearest unvisited spawning tile.
      const selfPos = beliefs.getSelf().position;
      const target = beliefs.getExploreTarget(selfPos);
      if (!target) return [];
      return [createExploreIntention(target)];
    }

    const capacity = beliefs.getCapacity();
    const carried = beliefs.getSelf().carriedParcels.length;
    // Remaining space the agent can pick up; if full, no pickup intentions make sense.
    const remaining = capacity - carried;
    if (remaining <= 0) return [];

    const selfPos = beliefs.getSelf().position;
    const intentions: Intention[] = [];
    const now = Date.now();

    // --- Single-parcel intentions ---
    for (const parcel of reachable) {
      const stepsToParcel = manhattanDistance(selfPos, parcel.position);
      const delivery = beliefs.getNearestDeliveryZone(parcel.position);
      const stepsToDelivery = delivery ? manhattanDistance(parcel.position, delivery) : 0;
      const projectedReward = tracker
        ? tracker.estimateRewardAt(parcel.id, now + (stepsToParcel + stepsToDelivery) * movementDurationMs)
        : parcel.estimatedReward;
      intentions.push(createSingleIntention(parcel, stepsToParcel, stepsToDelivery, projectedReward));
    }

    // --- Multi-parcel cluster intentions ---
    const clusters = groupNearbyClusters(reachable);
    for (const cluster of clusters) {
      // Cap cluster size to remaining carry capacity
      const capped = remaining < cluster.length ? cluster.slice(0, remaining) : cluster;
      if (capped.length < 2) continue; // single-parcel clusters already covered above

      const { ordered, stepsToFirst, interParcelSteps } = orderParcelsByNearest(capped, selfPos);
      const lastPos = ordered[ordered.length - 1]!.position;
      const delivery = beliefs.getNearestDeliveryZone(lastPos);
      const stepsToDelivery = delivery ? manhattanDistance(lastPos, delivery) : 0;

      // Project each parcel's reward to the estimated delivery time (same for all in cluster).
      const projectedRewards = tracker
        ? ordered.map(p =>
            tracker.estimateRewardAt(
              p.id,
              now + (stepsToFirst + interParcelSteps + stepsToDelivery) * movementDurationMs,
            ),
          )
        : undefined;

      intentions.push(
        createClusterIntention(ordered, stepsToFirst, interParcelSteps, stepsToDelivery, projectedRewards),
      );
    }

    intentions.sort((a, b) => b.utility - a.utility);
    return intentions;
  }

  /**
   * Decide whether the agent should abandon its current intention and replan.
   *
   * Returns true if:
   *   - `planFailed` is true
   *   - any target parcel in `currentIntention` is gone or being carried
   *   - a new candidate has utility > REPLAN_UTILITY_THRESHOLD * currentIntention.utility
   */
  shouldReplan(
    currentIntention: Intention | null,
    beliefs: IBeliefStore,
    planFailed = false,
    movementDurationMs = 500,
    tracker?: ParcelTracker,
  ): boolean {
    if (currentIntention === null) return false;
    if (planFailed) return true;

    const selfId = beliefs.getSelf().id;
    const parcelMap = new Map(beliefs.getParcelBeliefs().map(p => [p.id, p]));

    // Check if any target parcel is gone or being carried by ANOTHER agent
    // (if WE are carrying it, the plan is still valid — we're delivering it)
    for (const id of currentIntention.targetParcels) {
      const p = parcelMap.get(id);
      if (!p) return true; // parcel disappeared
      if (p.carriedBy !== null && p.carriedBy !== selfId) return true; // stolen
    }

    // Check if a significantly better option exists
    const best = this.evaluate(beliefs, movementDurationMs, tracker)[0];
    if (best && best.utility > REPLAN_UTILITY_THRESHOLD * currentIntention.utility) {
      return true;
    }

    return false;
  }
}
