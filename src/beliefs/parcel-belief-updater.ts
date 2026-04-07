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

    this.updateSensedParcels(rawParcels, parcels, sensedIds, now);
    const effectiveRange = this.getEffectiveObservationRange(observationDistance, rawParcels, selfPos);
    this.processNonSensedParcels(parcels, sensedIds, selfPos, effectiveRange, now);

    return {
      parcels,
      changed: true, // Always emit for consistency
    };
  }

  private updateSensedParcels(
    rawParcels: ReadonlyArray<RawParcelSensing>,
    parcels: Map<string, ParcelBelief>,
    sensedIds: Set<string>,
    now: number,
  ): void {
    for (const raw of rawParcels) {
      sensedIds.add(raw.id);
      this.parcelTracker.observe(raw.id, raw.reward, now);
      const existing = parcels.get(raw.id);
      parcels.set(raw.id, this.createParcelBelief(raw, existing, now));
    }
  }

  private createParcelBelief(
    raw: RawParcelSensing,
    existing: ParcelBelief | undefined,
    now: number,
  ): ParcelBelief {
    let decayRate = existing?.decayRatePerMs ?? 0;
    if (existing && raw.reward < existing.reward && existing.reward > 0) {
      const dt = now - existing.lastSeen;
      if (dt > 0) {
        decayRate = (existing.reward - raw.reward) / dt;
      }
    }

    return {
      id: raw.id,
      position: { x: raw.x, y: raw.y },
      carriedBy: raw.carriedBy,
      reward: raw.reward,
      estimatedReward: raw.reward,
      lastSeen: now,
      confidence: 1.0,
      decayRatePerMs: decayRate,
    };
  }

  private getEffectiveObservationRange(
    observationDistance: number,
    rawParcels: ReadonlyArray<RawParcelSensing>,
    selfPos: Position,
  ): number {
    if (observationDistance > 0) {
      return observationDistance;
    }

    let maxSensedDist = 0;
    for (const raw of rawParcels) {
      const d = manhattanDistance(selfPos, { x: raw.x, y: raw.y });
      if (d > maxSensedDist) maxSensedDist = d;
    }

    return rawParcels.length > 0 ? maxSensedDist : 1;
  }

  private processNonSensedParcels(
    parcels: Map<string, ParcelBelief>,
    sensedIds: Set<string>,
    selfPos: Position,
    effectiveRange: number,
    now: number,
  ): void {
    for (const [id, belief] of Array.from(parcels.entries())) {
      if (sensedIds.has(id)) continue;
      if (belief.carriedBy !== null) continue; // carried parcels don't appear in sensing

      const dist = manhattanDistance(selfPos, belief.position);
      if (dist <= effectiveRange) {
        parcels.delete(id);
      } else {
        this.updateStaleParcel(id, belief, parcels, now);
      }
    }
  }

  private updateStaleParcel(
    id: string,
    belief: ParcelBelief,
    parcels: Map<string, ParcelBelief>,
    now: number,
  ): void {
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

