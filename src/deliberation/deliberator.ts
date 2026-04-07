// ============================================================
// src/deliberation/deliberator.ts — Deliberator: intention selection & replan trigger (T12)
// ============================================================

import type { EvalCandidate, EvaluationResult, IBeliefStore, Intention } from '../types.js';
import { manhattanDistance } from '../types.js';
import type { ParcelTracker } from '../beliefs/parcel-tracker.js';
import { posKey } from '../pathfinding/distance-map.js';
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
export const REPLAN_UTILITY_THRESHOLD = 1.3;

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
   * Returns an EvaluationResult with sorted intentions and metadata for L1 logging.
   */
  evaluate(
    beliefs: IBeliefStore,
    movementDurationMs = 500,
    tracker?: ParcelTracker,
    distanceMap?: Map<number, number>,
    deliveryDistMap?: Map<number, number>,
  ): EvaluationResult {
    const allReachable = beliefs.getReachableParcels();
    // R15: filter out parcels with reward <= 0 before generating intentions.
    // Expired parcels remain in the belief set as obstacles/noise but must not be pursued.
    const reachable = allReachable.filter(p => p.reward > 0);

    const mapWidth = beliefs.getMap().width;
    // When a distance map is available, use exact BFS step counts from the agent's position.
    // Falls back to Manhattan when the tile is unreachable (should not happen for reachable parcels).
    const exactDist = (pos: { x: number; y: number }): number =>
      distanceMap?.get(posKey(pos.x, pos.y, mapWidth)) ?? manhattanDistance(selfPos, pos);

    const selfPos = beliefs.getSelf().position;

    if (reachable.length === 0) {
      // No parcels visible — explore toward nearest unvisited spawning tile.
      const target = beliefs.getExploreTarget(selfPos);
      if (!target) return { intentions: [], reachable: 0, contestaDrop: 0, candidates: [] };
      const exploreIntent = createExploreIntention(target);
      const exploreCandidate: EvalCandidate = {
        type: 'explore', tp: [], u: exploreIntent.utility,
        steps: exactDist(target), projR: 0,
      };
      return { intentions: [exploreIntent], reachable: 0, contestaDrop: 0, candidates: [exploreCandidate] };
    }

    const capacity = beliefs.getCapacity();
    const carried = beliefs.getSelf().carriedParcels.length;
    // Remaining space the agent can pick up; if full, no pickup intentions make sense.
    const remaining = capacity - carried;
    if (remaining <= 0) return { intentions: [], reachable: reachable.length, contestaDrop: 0, candidates: [] };

    const intentions: Intention[] = [];
    const now = Date.now();

    // --- Contesa filter: remove parcels where an enemy agent is strictly closer ---
    // Agent distance uses exact BFS (we know our obstacles). Enemy distance stays Manhattan
    // (we don't know their obstacles, so we can't be more accurate than that).
    // Falls back to all reachable parcels if every parcel is contested (avoid paralysis).
    const enemies = beliefs.getAgentBeliefs().filter(a => !a.isAlly);
    const uncontested = reachable.filter(parcel => {
      const mySteps = exactDist(parcel.position);
      return enemies.every(enemy => manhattanDistance(enemy.position, parcel.position) >= mySteps);
    });
    const contestaDrop = reachable.length - uncontested.length;
    const candidates = uncontested.length > 0 ? uncontested : reachable;

    // Build EvalCandidate list for logging (single + cluster)
    const evalCandidates: EvalCandidate[] = [];

    // --- Single-parcel intentions ---
    for (const parcel of candidates) {
      const stepsToParcel = exactDist(parcel.position);
      const delivery = beliefs.getNearestDeliveryZone(parcel.position);
      // stepsToDelivery: Manhattan from parcel to delivery zone (a reverse BFS would be needed
      // for exact values; Manhattan is an acceptable proxy here since delivery zones are accessible).
      const stepsToDelivery = delivery
        ? (deliveryDistMap?.get(posKey(parcel.position.x, parcel.position.y, mapWidth))
            ?? manhattanDistance(parcel.position, delivery))
        : 0;
      const projectedReward = tracker
        ? tracker.estimateRewardAt(parcel.id, now + (stepsToParcel + stepsToDelivery) * movementDurationMs)
        : parcel.estimatedReward;
      const intent = createSingleIntention(parcel, stepsToParcel, stepsToDelivery, projectedReward);
      intentions.push(intent);
      evalCandidates.push({
        type: 'pickup', tp: [parcel.id],
        u: intent.utility, steps: stepsToParcel + stepsToDelivery, projR: projectedReward,
      });
    }

    // --- Multi-parcel cluster intentions ---
    const clusters = groupNearbyClusters(candidates);
    for (const cluster of clusters) {
      // Cap cluster size to remaining carry capacity
      const capped = remaining < cluster.length ? cluster.slice(0, remaining) : cluster;
      if (capped.length < 2) continue; // single-parcel clusters already covered above

      const { ordered, stepsToFirst, interParcelSteps } = orderParcelsByNearest(capped, selfPos, distanceMap, mapWidth);
      const lastPos = ordered[ordered.length - 1]!.position;
      const delivery = beliefs.getNearestDeliveryZone(lastPos);
      const stepsToDelivery = delivery
        ? (deliveryDistMap?.get(posKey(lastPos.x, lastPos.y, mapWidth))
            ?? manhattanDistance(lastPos, delivery))
        : 0;

      // Project each parcel's reward to the estimated delivery time (same for all in cluster).
      const projectedRewards = tracker
        ? ordered.map(p =>
            tracker.estimateRewardAt(
              p.id,
              now + (stepsToFirst + interParcelSteps + stepsToDelivery) * movementDurationMs,
            ),
          )
        : undefined;

      const intent = createClusterIntention(ordered, stepsToFirst, interParcelSteps, stepsToDelivery, projectedRewards);
      intentions.push(intent);
      const totalProjR = projectedRewards ? projectedRewards.reduce((s, r) => s + r, 0) : ordered.reduce((s, p) => s + p.estimatedReward, 0);
      evalCandidates.push({
        type: 'cluster', tp: ordered.map(p => p.id),
        u: intent.utility, steps: stepsToFirst + interParcelSteps + stepsToDelivery, projR: totalProjR,
      });
    }

    // Drop intentions whose projected reward is already 0 at delivery time — not worth pursuing.
    // If all are zero, fall back to explore so the agent seeks fresh parcels instead of
    // wasting steps on parcels that will have fully decayed before delivery.
    const positive = intentions.filter(i => i.utility > 0);
    if (positive.length === 0) {
      const target = beliefs.getExploreTarget(selfPos);
      if (!target) return { intentions: [], reachable: reachable.length, contestaDrop, candidates: evalCandidates };
      const exploreIntent = createExploreIntention(target);
      const exploreCandidate: EvalCandidate = {
        type: 'explore', tp: [], u: exploreIntent.utility,
        steps: manhattanDistance(selfPos, target), projR: 0,
      };
      return { intentions: [exploreIntent], reachable: reachable.length, contestaDrop, candidates: [...evalCandidates, exploreCandidate] };
    }
    // Stable sort: primary key is utility desc, tiebreak by targetParcels id string.
    // Without the tiebreak, equal-utility intentions swap order each cycle → oscillation.
    positive.sort((a, b) => {
      const du = b.utility - a.utility;
      if (du !== 0) return du;
      return a.targetParcels.join(',') < b.targetParcels.join(',') ? -1 : 1;
    });
    return { intentions: positive, reachable: reachable.length, contestaDrop, candidates: evalCandidates };
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
    precomputedCandidates?: readonly Intention[],
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
    const candidates = precomputedCandidates ?? this.evaluate(beliefs, movementDurationMs, tracker).intentions;
    const best = candidates[0];
    const currentRefreshed = candidates.find(
      c => c.targetParcels.join(',') === currentIntention.targetParcels.join(','),
    );
    if (!currentRefreshed) {
      // Target is absent from candidates. Three sub-cases:
      // (a) No candidates at all → nothing better → keep current intention.
      if (!best) return false;
      // (b) We are carrying the target parcel ourselves (delivery plan) → keep going.
      const targetIsCarriedBySelf = currentIntention.targetParcels.some(id => {
        const p = parcelMap.get(id);
        return p?.carriedBy === selfId;
      });
      if (targetIsCarriedBySelf) return false;
      // (c) Target was filtered (claimed by ally, decayed to 0, became contested) and
      //     a real candidate exists → replan rather than comparing against a utility
      //     value that was never updated and will suppress replanning indefinitely.
      return true;
    }
    if (best && best.utility > REPLAN_UTILITY_THRESHOLD * currentRefreshed.utility) {
      return true;
    }

    return false;
  }
}
