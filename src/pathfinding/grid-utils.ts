// ============================================================
// src/pathfinding/grid-utils.ts — Grid utility functions (T09)
// Neighbor computation, walkability checks
// ============================================================

import type { BeliefMap, Direction, Position } from '../types.js';

/** Encode a position as a single integer for use as a Map/Set key. */
export function posKey(x: number, y: number, width: number): number {
  return y * width + x;
}

/** R09: derive movement direction from source→destination delta. */
function movementDirection(from: Position, to: Position): Direction {
  if (to.y > from.y) return 'up';
  if (to.y < from.y) return 'down';
  if (to.x < from.x) return 'left';
  return 'right';
}

/** Apply a direction to a position, returning the adjacent tile. */
function applyDir(pos: Position, dir: Direction): Position {
  switch (dir) {
    case 'up':    return { x: pos.x,     y: pos.y + 1 };
    case 'down':  return { x: pos.x,     y: pos.y - 1 };
    case 'left':  return { x: pos.x - 1, y: pos.y     };
    case 'right': return { x: pos.x + 1, y: pos.y     };
  }
}

/**
 * Returns 4-connected walkable neighbors of a position on the grid.
 * Uses canEnterFrom (R02) for directional tile constraints.
 * Optionally excludes positions listed as dynamic obstacles (R05).
 *
 * If `cratePositions` is provided, tiles occupied by crates are treated
 * as passable only if the crate can be pushed: the tile beyond (in the
 * same direction) must be TileType 8 (crate-slide), not occupied by
 * another crate, not occupied by a dynamic obstacle, and walkable.
 */
export function getNeighbors(
  pos: Position,
  map: BeliefMap,
  dynamicObstacles?: ReadonlyArray<Position>,
  cratePositions?: ReadonlySet<number>,
): Position[] {
  const candidates: Position[] = [
    { x: pos.x, y: pos.y + 1 }, // up    (R09: y+1)
    { x: pos.x, y: pos.y - 1 }, // down  (R09: y-1)
    { x: pos.x - 1, y: pos.y }, // left  (R09: x-1)
    { x: pos.x + 1, y: pos.y }, // right (R09: x+1)
  ];

  const result: Position[] = [];
  for (const c of candidates) {
    const dir = movementDirection(pos, c);
    if (!map.canEnterFrom(c.x, c.y, dir)) continue; // R02: directional + walkability

    const cKey = posKey(c.x, c.y, map.width);
    const isCrateHere = cratePositions?.has(cKey) ?? false;

    if (isCrateHere) {
      // Crate pushing: check if the crate can be pushed to the tile beyond.
      const pushDest = applyDir(c, dir);
      const pushDestKey = posKey(pushDest.x, pushDest.y, map.width);
      const pushDestType = map.getTile(pushDest.x, pushDest.y);
      const pushOk =
        pushDestType === 8 &&
        !(cratePositions?.has(pushDestKey) ?? false) &&
        !(dynamicObstacles?.some(o => o.x === pushDest.x && o.y === pushDest.y) ?? false);
      if (!pushOk) continue; // crate trapped → impassable obstacle
    } else {
      // No crate: standard dynamic obstacle check (R05).
      if (dynamicObstacles && dynamicObstacles.some(o => o.x === c.x && o.y === c.y)) continue;
    }

    result.push(c);
  }
  return result;
}

/**
 * Checks if a position is within the map bounds and walkable.
 */
export function isValidPosition(pos: Position, map: BeliefMap): boolean {
  return pos.x >= 0 && pos.x < map.width && pos.y >= 0 && pos.y < map.height && map.isWalkable(pos.x, pos.y);
}
