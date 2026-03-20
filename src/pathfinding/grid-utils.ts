// ============================================================
// src/pathfinding/grid-utils.ts — Grid utility functions (T09)
// Neighbor computation, walkability checks
// ============================================================

import type { BeliefMap, Position } from '../types.js';

/**
 * Returns 4-connected walkable neighbors of a position on the grid.
 * Optionally excludes positions listed as dynamic obstacles.
 */
export function getNeighbors(
  pos: Position,
  map: BeliefMap,
  dynamicObstacles?: ReadonlyArray<Position>,
): Position[] {
  const candidates: Position[] = [
    { x: pos.x, y: pos.y + 1 }, // up
    { x: pos.x, y: pos.y - 1 }, // down
    { x: pos.x - 1, y: pos.y }, // left
    { x: pos.x + 1, y: pos.y }, // right
  ];

  const result: Position[] = [];
  for (const c of candidates) {
    const tileType = map.getTile(c.x, c.y);
    if (tileType === null || tileType === 0) continue; // non-walkable
    // One-way tiles: enforce entry direction constraints.
    const dy = c.y - pos.y;
    const dx = c.x - pos.x;
    if (tileType === 4 && dy !== 1)  continue; // ↑: must enter moving up
    if (tileType === 5 && dy !== -1) continue; // ↓: must enter moving down
    if (tileType === 6 && dx !== -1) continue; // ←: must enter moving left
    if (tileType === 7 && dx !== 1)  continue; // →: must enter moving right
    if (dynamicObstacles && dynamicObstacles.some(o => o.x === c.x && o.y === c.y)) continue;
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
