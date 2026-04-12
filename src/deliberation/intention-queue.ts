// ============================================================
// src/deliberation/intention-queue.ts — Priority queue of Intentions (T11)
// Sorted by utility (descending). revise() removes invalid intentions
// and recomputes utilities using Manhattan distance approximation.
// ============================================================

import type { IBeliefStore, IIntentionQueue, Intention } from '../types.js';
import { manhattanDistance } from '../types.js';
import { computeUtility } from './intention.js';

export class IntentionQueue implements IIntentionQueue {
  private readonly _items: Intention[] = [];

  push(intention: Intention): void {
    this._items.push(intention);
    this._sort();
  }

  pop(): Intention | null {
    return this._items.shift() ?? null;
  }

  peek(): Intention | null {
    return this._items[0] ?? null;
  }

  /**
   * Remove invalid intentions and recompute utilities with Manhattan approximation.
   * An intention is invalid if any of its target parcels:
   *   - no longer appears in beliefs, OR
   *   - is being carried by another agent.
   */
  revise(beliefs: IBeliefStore): void {
    const parcelMap = new Map(beliefs.getParcelBeliefs().map(p => [p.id, p]));
    const self = beliefs.getSelf();
    const delivery = beliefs.getNearestDeliveryZone(self.position);

    for (let i = this._items.length - 1; i >= 0; i--) {
      const intention = this._items[i]!;

      // Resolve each target parcel
      const resolved = intention.targetParcels.map(id => parcelMap.get(id));
      const valid = resolved.every(p => p !== undefined && p.carriedBy === null);

      if (!valid) {
        this._items.splice(i, 1);
        continue;
      }

      // Recompute utility (Manhattan approximation)
      if (delivery) {
        const live = resolved as NonNullable<(typeof resolved)[0]>[];
        let interSteps = 0;
        for (let j = 1; j < live.length; j++) {
          interSteps += manhattanDistance(live[j - 1]!.position, live[j]!.position);
        }
        const stepsToFirst = manhattanDistance(self.position, live[0]!.position);
        const stepsToDelivery = manhattanDistance(live[live.length - 1]!.position, delivery);
        const totalReward = live.reduce((sum, p) => sum + p.estimatedReward, 0);
        const newUtility = computeUtility(totalReward, stepsToFirst + interSteps + stepsToDelivery);
        this._items[i] = { ...intention, utility: newUtility };
      }
    }

    this._sort();
  }

  clear(): void {
    this._items.length = 0;
  }

  size(): number {
    return this._items.length;
  }

  toArray(): ReadonlyArray<Intention> {
    return [...this._items];
  }

  private _sort(): void {
    this._items.sort((a, b) => b.utility - a.utility);
  }
}
