// ============================================================
// src/beliefs/parcel-belief-updater.ts — Parcel belief updates
// Handles updates to parcel beliefs with decay tracking and staleness
// ============================================================

import type { BeliefMap, ParcelBelief, Position, RawParcelSensing } from '../types.js';
import { manhattanDistance } from '../types.js';
import { ParcelTracker } from './parcel-tracker.js';

/** Parcels not seen for longer than this are marked stale (confidence drops). */
const STALE_THRESHOLD_MS = 5_000;

export type ParcelBeliefUpdateResult = {
  parcels: Map<string, ParcelBelief>;
  changed: boolean;
};

export class ParcelBeliefUpdater {
  constructor(
    private map: BeliefMap,
    private parcelTracker: ParcelTracker,
  ) {}

  /**
   * Update parcel beliefs from raw sensing data with belief revision.
   * @param rawParcels Current sensed parcels
   * @param currentParcels Previous parcel beliefs
   * @param selfPos Agent's current position for observation distance calculation
   * @param observationDistance Server's PARCELS_OBSERVATION_DISTANCE (0 = unknown)
   * @returns Update result with new parcels map and changed flag
   */
  update(
    rawParcels: ReadonlyArray<RawParcelSensing>,
    currentParcels: Map<string, ParcelBelief>,
    selfPos: Position,
    observationDistance: number,
  ): ParcelBeliefUpdateResult {
    const now = Date.now();
    const sensedIds = new Set<string>();
    const parcels = new Map(currentParcels);

    // Update sensed parcels
    for (const raw of rawParcels) {
      sensedIds.add(raw.id);
      this.parcelTracker.observe(raw.id, raw.reward, now);
      const existing = parcels.get(raw.id);

      // Estimate decay rate from consecutive observations
      let decayRate = existing?.decayRatePerMs ?? 0;
      if (existing && raw.reward < existing.reward && existing.reward > 0) {
        const dt = now - existing.lastSeen;
        if (dt > 0) {
          decayRate = (existing.reward - raw.reward) / dt;
        }
      }

      parcels.set(raw.id, {
        id: raw.id,
        position: { x: raw.x, y: raw.y },
        carriedBy: raw.carriedBy,
        reward: raw.reward,
        estimatedReward: raw.reward,
        lastSeen: now,
        confidence: 1.0,
        decayRatePerMs: decayRate,
      });
    }

    // Belief revision: remove parcels that should be visible but aren't sensed.
    // Use PARCELS_OBSERVATION_DISTANCE when known; otherwise fall back to a
    // heuristic based on the farthest sensed parcel distance.
    let effectiveRange: number;
    if (observationDistance > 0) {
      effectiveRange = observationDistance;
    } else {
      let maxSensedDist = 0;
      for (const raw of rawParcels) {
        const d = manhattanDistance(selfPos, { x: raw.x, y: raw.y });
        if (d > maxSensedDist) maxSensedDist = d;
      }
      effectiveRange = rawParcels.length > 0 ? maxSensedDist : 1;
    }

    // Process non-sensed parcels: delete if in range, mark stale if out of range
    for (const [id, belief] of Array.from(parcels.entries())) {
      if (sensedIds.has(id)) continue;
      if (belief.carriedBy !== null) continue; // carried parcels don't appear in sensing

      const dist = manhattanDistance(selfPos, belief.position);
      if (dist <= effectiveRange) {
        parcels.delete(id);
      } else {
        // Mark stale parcels with decaying confidence
        const age = now - belief.lastSeen;
        if (age > STALE_THRESHOLD_MS) {
          const confidence = Math.max(
            0,
            1 - (age - STALE_THRESHOLD_MS) / STALE_THRESHOLD_MS,
          );
          const estimatedReward = Math.max(
            0,
            belief.reward - belief.decayRatePerMs * age,
          );
          parcels.set(id, {
            ...belief,
            confidence,
            estimatedReward,
          });
        }
      }
    }

    return {
      parcels,
      changed: true, // Always emit for consistency
    };
  }
}
