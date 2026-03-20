import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findPath } from './pathfinder.js';
import { getNeighbors, isValidPosition } from './grid-utils.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import { manhattanDistance } from '../types.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
} from '../testing/fixtures.js';
import type { Tile, TileType, Position } from '../types.js';

// --- Helpers ---

function tile(x: number, y: number, type: TileType): Tile {
  return { x, y, type };
}

/** Build a simple open NxN grid (all walkable). */
function openGrid(n: number): BeliefMapImpl {
  const tiles: Tile[] = [];
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      tiles.push(tile(x, y, 3));
    }
  }
  return new BeliefMapImpl(tiles, n, n);
}

const fixtureMap = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);

// ============================================================
// grid-utils tests
// ============================================================

describe('grid-utils', () => {
  describe('getNeighbors', () => {
    it('returns 4 neighbors in open space', () => {
      const neighbors = getNeighbors({ x: 5, y: 5 }, fixtureMap);
      assert.equal(neighbors.length, 4);
    });

    it('returns fewer neighbors at map corner', () => {
      const neighbors = getNeighbors({ x: 0, y: 0 }, fixtureMap);
      // (0,0) is delivery zone (type 2), neighbors are (1,0) and (0,1)
      assert.equal(neighbors.length, 2);
    });

    it('excludes non-walkable neighbors', () => {
      // (1,2) is walkable; neighbors include (2,2) which is a wall
      const neighbors = getNeighbors({ x: 1, y: 2 }, fixtureMap);
      const hasWall = neighbors.some(n => n.x === 2 && n.y === 2);
      assert.equal(hasWall, false);
    });

    it('excludes dynamic obstacles', () => {
      const obstacles: Position[] = [{ x: 5, y: 6 }];
      const neighbors = getNeighbors({ x: 5, y: 5 }, fixtureMap, obstacles);
      const hasObstacle = neighbors.some(n => n.x === 5 && n.y === 6);
      assert.equal(hasObstacle, false);
      // Should still have 3 other neighbors
      assert.equal(neighbors.length, 3);
    });

    it('returns empty for fully surrounded by walls', () => {
      // Build a tiny map where center is surrounded by walls
      const tiles: Tile[] = [
        tile(0, 0, 0), tile(1, 0, 0), tile(2, 0, 0),
        tile(0, 1, 0), tile(1, 1, 3), tile(2, 1, 0),
        tile(0, 2, 0), tile(1, 2, 0), tile(2, 2, 0),
      ];
      const map = new BeliefMapImpl(tiles, 3, 3);
      const neighbors = getNeighbors({ x: 1, y: 1 }, map);
      assert.equal(neighbors.length, 0);
    });
  });

  describe('one-way tile constraints', () => {
    // Build a 3x1 map: S ← G  (agent at x=0, one-way ← tile at x=1, goal at x=2)
    // ← (type 6): can only be entered moving left (dx=-1), i.e. from x=2 side.
    function makeHorizMap(midType: TileType): BeliefMapImpl {
      return new BeliefMapImpl(
        [tile(0, 0, 3), tile(1, 0, midType), tile(2, 0, 3)],
        3, 1,
      );
    }

    // Build a 1x3 map: S ↑ G  (agent at y=0, one-way tile at y=1, goal at y=2)
    function makeVertMap(midType: TileType): BeliefMapImpl {
      return new BeliefMapImpl(
        [tile(0, 0, 3), tile(0, 1, midType), tile(0, 2, 3)],
        1, 3,
      );
    }

    it('type 6 (←): allows entry from right (dx=-1), blocks entry from left', () => {
      const map = makeHorizMap(6);
      // From (0,0): candidate (1,0) has dx=+1 — blocked (must enter from right)
      const from0 = getNeighbors({ x: 0, y: 0 }, map);
      assert.equal(from0.some(n => n.x === 1), false, 'should not enter ← tile from left');
      // From (2,0): candidate (1,0) has dx=-1 — allowed
      const from2 = getNeighbors({ x: 2, y: 0 }, map);
      assert.equal(from2.some(n => n.x === 1), true, 'should enter ← tile from right');
    });

    it('type 7 (→): allows entry from left (dx=+1), blocks entry from right', () => {
      const map = makeHorizMap(7);
      // From (0,0): candidate (1,0) has dx=+1 — allowed
      const from0 = getNeighbors({ x: 0, y: 0 }, map);
      assert.equal(from0.some(n => n.x === 1), true, 'should enter → tile from left');
      // From (2,0): candidate (1,0) has dx=-1 — blocked
      const from2 = getNeighbors({ x: 2, y: 0 }, map);
      assert.equal(from2.some(n => n.x === 1), false, 'should not enter → tile from right');
    });

    it('type 4 (↑): allows entry moving up (dy=+1), blocks entry from above', () => {
      const map = makeVertMap(4);
      // From (0,0): candidate (0,1) has dy=+1 — allowed
      const fromBelow = getNeighbors({ x: 0, y: 0 }, map);
      assert.equal(fromBelow.some(n => n.y === 1), true, 'should enter ↑ tile from below');
      // From (0,2): candidate (0,1) has dy=-1 — blocked
      const fromAbove = getNeighbors({ x: 0, y: 2 }, map);
      assert.equal(fromAbove.some(n => n.y === 1), false, 'should not enter ↑ tile from above');
    });

    it('type 5 (↓): allows entry moving down (dy=-1), blocks entry from below', () => {
      const map = makeVertMap(5);
      // From (0,2): candidate (0,1) has dy=-1 — allowed
      const fromAbove = getNeighbors({ x: 0, y: 2 }, map);
      assert.equal(fromAbove.some(n => n.y === 1), true, 'should enter ↓ tile from above');
      // From (0,0): candidate (0,1) has dy=+1 — blocked
      const fromBelow = getNeighbors({ x: 0, y: 0 }, map);
      assert.equal(fromBelow.some(n => n.y === 1), false, 'should not enter ↓ tile from below');
    });

    it('pathfinder finds route around a ← tile when approaching from wrong side', () => {
      // 3x3 map: must route around the ← at (1,1) which blocks entry from left
      const tiles: Tile[] = [];
      for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 3; y++) {
          tiles.push(tile(x, y, 3));
        }
      }
      tiles[tiles.findIndex(t => t.x === 1 && t.y === 1)] = tile(1, 1, 6); // ←
      const map = new BeliefMapImpl(tiles, 3, 3);
      // From (0,1) to (2,1): direct path goes through ← tile from wrong side,
      // so must detour via row y=0 or y=2.
      const path = findPath({ x: 0, y: 1 }, { x: 2, y: 1 }, map);
      assert.ok(path, 'should find a detour');
      assert.deepEqual(path[0], { x: 0, y: 1 });
      assert.deepEqual(path[path.length - 1], { x: 2, y: 1 });
      // Should NOT enter (1,1) from (0,1) — that would be dx=+1, wrong direction for ←
      for (let i = 1; i < path.length; i++) {
        const atLeft = path[i - 1].x === 0 && path[i - 1].y === 1;
        const atCenter = path[i].x === 1 && path[i].y === 1;
        assert.ok(!(atLeft && atCenter), 'should not enter ← tile from left side');
      }
    });
  });

  describe('isValidPosition', () => {
    it('returns true for walkable in-bounds position', () => {
      assert.equal(isValidPosition({ x: 5, y: 5 }, fixtureMap), true);
    });

    it('returns false for wall tile', () => {
      assert.equal(isValidPosition({ x: 2, y: 2 }, fixtureMap), false);
    });

    it('returns false for out-of-bounds position', () => {
      assert.equal(isValidPosition({ x: -1, y: 0 }, fixtureMap), false);
      assert.equal(isValidPosition({ x: 10, y: 0 }, fixtureMap), false);
    });

    it('returns true for delivery zone', () => {
      assert.equal(isValidPosition({ x: 0, y: 0 }, fixtureMap), true);
    });

    it('returns true for spawning tile', () => {
      assert.equal(isValidPosition({ x: 1, y: 0 }, fixtureMap), true);
    });
  });
});

// ============================================================
// pathfinder tests
// ============================================================

describe('pathfinder', () => {
  it('returns single-element path for same start and goal', () => {
    const path = findPath({ x: 5, y: 5 }, { x: 5, y: 5 }, fixtureMap);
    assert.ok(path);
    assert.equal(path.length, 1);
    assert.deepEqual(path[0], { x: 5, y: 5 });
  });

  it('finds shortest path on open grid (length = manhattan + 1)', () => {
    const grid = openGrid(10);
    const from = { x: 0, y: 0 };
    const to = { x: 9, y: 9 };
    const path = findPath(from, to, grid);
    assert.ok(path);
    // Path includes start and end, so length = manhattan + 1
    assert.equal(path.length, manhattanDistance(from, to) + 1);
    // Starts and ends correctly
    assert.deepEqual(path[0], from);
    assert.deepEqual(path[path.length - 1], to);
  });

  it('finds path on fixture map from (0,0) to (9,9)', () => {
    const path = findPath({ x: 0, y: 0 }, { x: 9, y: 9 }, fixtureMap);
    assert.ok(path, 'should find a path');
    // Verify start and end
    assert.deepEqual(path[0], { x: 0, y: 0 });
    assert.deepEqual(path[path.length - 1], { x: 9, y: 9 });
    // Verify every step is walkable
    for (const p of path) {
      assert.ok(fixtureMap.isWalkable(p.x, p.y), `position (${p.x},${p.y}) should be walkable`);
    }
    // Verify consecutive steps are adjacent (manhattan distance = 1)
    for (let i = 1; i < path.length; i++) {
      const d = manhattanDistance(path[i - 1], path[i]);
      assert.equal(d, 1, `step ${i - 1} to ${i} should be adjacent`);
    }
  });

  it('returns null for unreachable target (surrounded by walls)', () => {
    // Build a map where the target is enclosed by walls
    const tiles: Tile[] = [];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        tiles.push(tile(x, y, 3));
      }
    }
    // Surround (2,2) with walls
    for (const [wx, wy] of [[1,2],[3,2],[2,1],[2,3]] as const) {
      const idx = tiles.findIndex(t => t.x === wx && t.y === wy);
      tiles[idx] = tile(wx, wy, 0);
    }
    const map = new BeliefMapImpl(tiles, 5, 5);
    const path = findPath({ x: 0, y: 0 }, { x: 2, y: 2 }, map);
    assert.equal(path, null);
  });

  it('returns null when target tile is non-walkable', () => {
    // (2,2) is a wall on the fixture map
    const path = findPath({ x: 0, y: 0 }, { x: 2, y: 2 }, fixtureMap);
    assert.equal(path, null);
  });

  it('returns null when dynamic obstacle blocks the only path', () => {
    // Build a corridor: 3 wide, 1 high effectively
    //  S . G
    const tiles: Tile[] = [
      tile(0, 0, 3), tile(1, 0, 3), tile(2, 0, 3),
    ];
    const map = new BeliefMapImpl(tiles, 3, 1);
    // Without obstacle: path exists
    const path1 = findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, map);
    assert.ok(path1);
    // With obstacle blocking the middle
    const path2 = findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, map, [{ x: 1, y: 0 }]);
    assert.equal(path2, null);
  });

  it('avoids dynamic obstacles and finds alternate route', () => {
    const grid = openGrid(5);
    // Block the direct horizontal path at y=0
    const obstacles: Position[] = [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    const path = findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, grid, obstacles);
    assert.ok(path, 'should find an alternate route');
    assert.deepEqual(path[0], { x: 0, y: 0 });
    assert.deepEqual(path[path.length - 1], { x: 4, y: 0 });
    // Should not pass through any obstacle
    for (const p of path) {
      const blocked = obstacles.some(o => o.x === p.x && o.y === p.y);
      assert.equal(blocked, false, `should not pass through obstacle at (${p.x},${p.y})`);
    }
  });

  it('each step moves exactly one tile in a cardinal direction', () => {
    const path = findPath({ x: 0, y: 0 }, { x: 9, y: 9 }, fixtureMap);
    assert.ok(path);
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      assert.equal(dx + dy, 1, `step ${i} must be a single cardinal move`);
    }
  });

  it('handles adjacent start and goal', () => {
    const path = findPath({ x: 0, y: 0 }, { x: 1, y: 0 }, fixtureMap);
    assert.ok(path);
    assert.equal(path.length, 2);
  });

  it('navigates around wall blocks on fixture map', () => {
    // Path from (1,1) to (4,4) must go around the 2x2 wall at (2,2)-(3,3)
    const path = findPath({ x: 1, y: 1 }, { x: 4, y: 4 }, fixtureMap);
    assert.ok(path);
    // Should not step on any wall tile
    const walls = new Set(['2,2', '3,2', '2,3', '3,3']);
    for (const p of path) {
      assert.ok(!walls.has(`${p.x},${p.y}`), `should not step on wall at (${p.x},${p.y})`);
    }
  });
});
