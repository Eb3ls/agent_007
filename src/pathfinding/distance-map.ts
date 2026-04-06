// ============================================================
// src/pathfinding/distance-map.ts — BFS distance map from a source
// Computes exact step-costs to all reachable tiles in O(W×H).
// Used by the deliberator to replace Manhattan distance estimates.
// ============================================================

import type { BeliefMap, Position } from '../types.js';
import { getNeighbors } from './grid-utils.js';

/** Encode a position as a single integer key (same scheme as pathfinder.ts). */
export function posKey(x: number, y: number, width: number): number {
  return y * width + x;
}

/**
 * BFS flood-fill from `from` on the given map.
 *
 * Returns a Map<posKey, distance> where distance is the minimum number of
 * steps to reach that tile from `from`, respecting walkability and
 * directional tile constraints via `getNeighbors()`.
 *
 * Tiles that are unreachable are absent from the map.
 * The source tile itself is included with distance 0.
 *
 * `obstacles` parameter is accepted for API compatibility but currently not
 * forwarded to getNeighbors (pre-existing bug, out of scope).
 * `cratePositions` is a pre-built Set of posKeys for crate tiles; when provided,
 * crates are treated as pushable obstacles (see getNeighbors for semantics).
 */
export function computeDistanceMap(
  from: Position,
  map: BeliefMap,
  obstacles?: ReadonlyArray<Position>,
  cratePositions?: ReadonlySet<number>,
): Map<number, number> {
  const w = map.width;
  const dist = new Map<number, number>();
  const queue: Position[] = [from];
  dist.set(posKey(from.x, from.y, w), 0);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curDist = dist.get(posKey(cur.x, cur.y, w))!;

    for (const nb of getNeighbors(cur, map, undefined, cratePositions)) {
      const key = posKey(nb.x, nb.y, w);
      if (!dist.has(key)) {
        dist.set(key, curDist + 1);
        queue.push(nb);
      }
    }
  }

  return dist;
}
