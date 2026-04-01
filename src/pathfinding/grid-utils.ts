// ============================================================
// src/pathfinding/grid-utils.ts — Grid utility functions (T09)
// Neighbor computation, walkability checks
// ============================================================

import type { BeliefMap, Direction, Position } from '../types.js';

/** R09: derive movement direction from source→destination delta. */
function movementDirection(from: Position, to: Position): Direction {
  if (to.y > from.y) return 'up';
  if (to.y < from.y) return 'down';
  if (to.x < from.x) return 'left';
  return 'right';
}

/**
 * Returns 4-connected walkable neighbors of a position on the grid.
 * Uses canEnterFrom (R02) for directional tile constraints.
 * Optionally excludes positions listed as dynamic obstacles (R05).
 */
export function getNeighbors(
  pos: Position,
  map: BeliefMap,
  dynamicObstacles?: ReadonlyArray<Position>,
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
    if (dynamicObstacles && dynamicObstacles.some(o => o.x === c.x && o.y === c.y)) continue; // R05
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
