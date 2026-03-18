// ============================================================
// src/testing/fixtures.ts — Sample map data, parcel sets, agent positions
// ============================================================

import type {
  Tile,
  TileType,
  Position,
  RawParcelSensing,
  RawAgentSensing,
  RawSelfSensing,
} from '../types.js';

// --- Helper ---

function tile(x: number, y: number, type: TileType): Tile {
  return { x, y, type };
}

// --- 10x10 Map ---
// Layout (y=0 is bottom):
//
//   y=9:  3 3 3 3 3 3 3 3 3 2   ← delivery zone at (9,9)
//   y=8:  3 3 3 3 3 3 3 3 3 3
//   y=7:  3 3 0 0 3 3 0 0 3 3   ← walls
//   y=6:  3 3 0 0 3 3 0 0 3 3   ← walls
//   y=5:  3 3 3 3 3 3 3 3 3 3
//   y=4:  3 3 3 3 3 3 3 3 3 3
//   y=3:  3 3 0 0 3 3 0 0 3 3   ← walls
//   y=2:  3 3 0 0 3 3 0 0 3 3   ← walls
//   y=1:  3 3 3 3 3 3 3 3 3 3
//   y=0:  2 1 3 1 3 3 1 3 1 2   ← delivery at corners, spawning tiles
//         0 1 2 3 4 5 6 7 8 9

export const FIXTURE_MAP_WIDTH = 10;
export const FIXTURE_MAP_HEIGHT = 10;

function buildFixtureMapTiles(): Tile[] {
  const tiles: Tile[] = [];

  // Fill with walkable (3) by default
  for (let x = 0; x < FIXTURE_MAP_WIDTH; x++) {
    for (let y = 0; y < FIXTURE_MAP_HEIGHT; y++) {
      tiles.push(tile(x, y, 3));
    }
  }

  const overrides: [number, number, TileType][] = [
    // Delivery zones at corners
    [0, 0, 2], [9, 0, 2], [9, 9, 2],
    // Spawning tiles along bottom row
    [1, 0, 1], [3, 0, 1], [6, 0, 1], [8, 0, 1],
    // 2x2 wall blocks (4 of them, symmetric)
    [2, 2, 0], [3, 2, 0], [2, 3, 0], [3, 3, 0],
    [6, 2, 0], [7, 2, 0], [6, 3, 0], [7, 3, 0],
    [2, 6, 0], [3, 6, 0], [2, 7, 0], [3, 7, 0],
    [6, 6, 0], [7, 6, 0], [6, 7, 0], [7, 7, 0],
  ];

  for (const [ox, oy, ot] of overrides) {
    const idx = tiles.findIndex(t => t.x === ox && t.y === oy);
    tiles[idx] = tile(ox, oy, ot);
  }

  return tiles;
}

export const FIXTURE_MAP_TILES: ReadonlyArray<Tile> = buildFixtureMapTiles();

// --- Delivery zones ---

export const FIXTURE_DELIVERY_ZONES: ReadonlyArray<Position> = [
  { x: 0, y: 0 },
  { x: 9, y: 0 },
  { x: 9, y: 9 },
];

// --- Spawning tiles ---

export const FIXTURE_SPAWNING_TILES: ReadonlyArray<Position> = [
  { x: 1, y: 0 },
  { x: 3, y: 0 },
  { x: 6, y: 0 },
  { x: 8, y: 0 },
];

// --- Sample parcels (5 parcels at known positions) ---

export const FIXTURE_PARCELS: ReadonlyArray<RawParcelSensing> = [
  { id: 'p1', x: 1, y: 0, carriedBy: null, reward: 50 },
  { id: 'p2', x: 3, y: 0, carriedBy: null, reward: 30 },
  { id: 'p3', x: 5, y: 5, carriedBy: null, reward: 80 },
  { id: 'p4', x: 8, y: 0, carriedBy: null, reward: 20 },
  { id: 'p5', x: 4, y: 8, carriedBy: null, reward: 100 },
];

// --- Sample agents (3 agents at known positions) ---

export const FIXTURE_AGENTS: ReadonlyArray<RawAgentSensing> = [
  { id: 'agent-a', name: 'Alice', x: 0, y: 1, score: 100 },
  { id: 'agent-b', name: 'Bob',   x: 5, y: 5, score: 200 },
  { id: 'agent-c', name: 'Carol', x: 9, y: 8, score: 50 },
];

// --- Sample self ---

export const FIXTURE_SELF: RawSelfSensing = {
  id: 'agent-self',
  name: 'TestAgent',
  x: 4,
  y: 4,
  score: 0,
  penalty: 0,
};
