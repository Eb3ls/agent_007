// ============================================================
// src/beliefs/self-belief-updater.ts — Self belief updates
// Handles updates to the agent's own beliefs (position, score, etc.)
// ============================================================

import type { BeliefMap, ParcelBelief, Position, RawSelfSensing, SelfBelief } from '../types.js';
import { positionEquals } from '../types.js';

export type SelfBeliefUpdateResult = {
  belief: SelfBelief;
  positionChanged: boolean;
  scoreChanged: boolean;
};

export class SelfBeliefUpdater {
  constructor(private map: BeliefMap) {}

  /**
   * Update self belief from raw sensing data.
   * @param rawSelf Current self sensing data
   * @param currentBelief Previous self belief
   * @param parcels All parcel beliefs (to compute carried parcels)
   * @param visitedSpawningTiles Set of visited spawning tile coordinates
   * @returns Update result with new belief and flags for emitted events
   */
  update(
    rawSelf: RawSelfSensing,
    currentBelief: SelfBelief,
    parcels: Map<string, ParcelBelief>,
    visitedSpawningTiles: Set<string>,
  ): SelfBeliefUpdateResult {
    const prevPos = currentBelief.position;
    const prevScore = currentBelief.score;

    // Parcels carried by self
    const carried = Array.from(parcels.values()).filter(
      p => p.carriedBy === rawSelf.id,
    );

    // Server sends float coordinates during movement animation.
    // Only update position when the agent is on a stable integer tile;
    // otherwise keep the last known integer position to avoid planning from mid-air.
    const stablePosition = (Number.isInteger(rawSelf.x) && Number.isInteger(rawSelf.y))
      ? { x: rawSelf.x, y: rawSelf.y }
      : currentBelief.position;

    const newBelief: SelfBelief = {
      id: rawSelf.id,
      name: rawSelf.name,
      position: stablePosition,
      score: rawSelf.score,
      penalty: rawSelf.penalty ?? currentBelief.penalty,
      carriedParcels: carried,
    };

    // Track visited spawning tiles for exploration
    if (this.map.isSpawningTile(stablePosition.x, stablePosition.y)) {
      visitedSpawningTiles.add(`${stablePosition.x},${stablePosition.y}`);
    }

    const positionChanged = !positionEquals(prevPos, newBelief.position);
    const scoreChanged = prevScore !== rawSelf.score;

    return {
      belief: newBelief,
      positionChanged,
      scoreChanged,
    };
  }
}
