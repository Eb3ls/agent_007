// ============================================================
// src/pathfinding/pathfinder.ts — A* pathfinding on the grid (T09)
// Stateless: caller passes map and obstacles, no belief store access
// ============================================================

import type { BeliefMap, Position } from '../types.js';
import { manhattanDistance } from '../types.js';
import { getNeighbors } from './grid-utils.js';

/** Encode a position as a single integer for use as a Map key. */
function posKey(x: number, y: number, width: number): number {
  return y * width + x;
}

/**
 * A* pathfinding from `from` to `to` on the given belief map.
 * Returns the path as an array of positions (including `from` and `to`),
 * or null if no path exists.
 *
 * `dynamicObstacles` are treated as non-walkable tiles (e.g. known agent positions).
 */
export function findPath(
  from: Position,
  to: Position,
  map: BeliefMap,
  dynamicObstacles?: ReadonlyArray<Position>,
): Position[] | null {
  // Trivial case
  if (from.x === to.x && from.y === to.y) return [from];

  // Target must be walkable (unless it's a dynamic obstacle — we still navigate to it)
  if (!map.isWalkable(to.x, to.y)) return null;

  const w = map.width;
  const startKey = posKey(from.x, from.y, w);
  const goalKey = posKey(to.x, to.y, w);

  // g-scores: cost from start to node
  const gScore = new Map<number, number>();
  gScore.set(startKey, 0);

  // For path reconstruction
  const cameFrom = new Map<number, number>();

  // Open set as a simple binary heap (priority queue)
  // Each entry: [fScore, gScore, x, y]
  const open: [number, number, number, number][] = [];
  const h0 = manhattanDistance(from, to);
  open.push([h0, 0, from.x, from.y]);

  // Track which nodes are in the closed set
  const closed = new Set<number>();

  while (open.length > 0) {
    // Find minimum f-score (simple extraction — swap with last for O(1) removal)
    let minIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i][0] < open[minIdx][0] || (open[i][0] === open[minIdx][0] && open[i][1] > open[minIdx][1])) {
        minIdx = i;
      }
    }
    const [, currentG, cx, cy] = open[minIdx];
    open[minIdx] = open[open.length - 1];
    open.pop();

    const currentKey = posKey(cx, cy, w);

    if (currentKey === goalKey) {
      // Reconstruct path
      return reconstructPath(cameFrom, currentKey, from, w);
    }

    if (closed.has(currentKey)) continue;
    closed.add(currentKey);

    const neighbors = getNeighbors({ x: cx, y: cy }, map, dynamicObstacles);
    const tentativeG = currentG + 1;

    for (const n of neighbors) {
      const nKey = posKey(n.x, n.y, w);
      if (closed.has(nKey)) continue;

      const prevG = gScore.get(nKey);
      if (prevG !== undefined && tentativeG >= prevG) continue;

      gScore.set(nKey, tentativeG);
      cameFrom.set(nKey, currentKey);
      const f = tentativeG + manhattanDistance(n, to);
      open.push([f, tentativeG, n.x, n.y]);
    }
  }

  return null; // No path found
}

function reconstructPath(
  cameFrom: Map<number, number>,
  goalKey: number,
  from: Position,
  width: number,
): Position[] {
  const path: Position[] = [];
  let current = goalKey;
  while (current !== undefined) {
    const x = current % width;
    const y = Math.floor(current / width);
    path.push({ x, y });
    const prev = cameFrom.get(current);
    if (prev === undefined) break;
    current = prev;
  }
  path.reverse();
  return path;
}
