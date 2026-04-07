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

    const carried = this.getSelfCarriedParcels(rawSelf.id, parcels);
    const stablePosition = this.getStablePosition(rawSelf, currentBelief.position);
    const newBelief = this.buildNewBelief(rawSelf, currentBelief.penalty, stablePosition, carried);

    this.trackVisitedSpawningTile(stablePosition, visitedSpawningTiles);

    const positionChanged = !positionEquals(prevPos, newBelief.position);
    const scoreChanged = prevScore !== rawSelf.score;

    return {
      belief: newBelief,
      positionChanged,
      scoreChanged,
    };
  }

  private getSelfCarriedParcels(id: string, parcels: Map<string, ParcelBelief>): ParcelBelief[] {
    return Array.from(parcels.values()).filter(p => p.carriedBy === id);
  }

  private getStablePosition(rawSelf: RawSelfSensing, previousPosition: Position): Position {
    return Number.isInteger(rawSelf.x) && Number.isInteger(rawSelf.y)
      ? { x: rawSelf.x, y: rawSelf.y }
      : previousPosition;
  }

  private buildNewBelief(
    rawSelf: RawSelfSensing,
    previousPenalty: number,
    stablePosition: Position,
    carriedParcels: ParcelBelief[],
  ): SelfBelief {
    return {
      id: rawSelf.id,
      name: rawSelf.name,
      position: stablePosition,
      score: rawSelf.score,
      penalty: rawSelf.penalty ?? previousPenalty,
      carriedParcels,
    };
  }

  private trackVisitedSpawningTile(
    stablePosition: Position,
    visitedSpawningTiles: Set<string>,
  ): void {
    if (this.map.isSpawningTile(stablePosition.x, stablePosition.y)) {
      visitedSpawningTiles.add(`${stablePosition.x},${stablePosition.y}`);
    }
  }
}
