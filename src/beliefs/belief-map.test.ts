import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BeliefMapImpl } from './belief-map.js';
import type { Tile, TileType } from '../types.js';

function makeTile(x: number, y: number, type: TileType): Tile {
  return { x, y, type };
}

// Build a 5x5 map:
// Row 4 (top):   3 3 3 3 3
// Row 3:         3 0 3 0 3
// Row 2:         3 3 2 3 3
// Row 1:         3 0 3 0 3
// Row 0 (bot):   1 3 1 3 2
function makeFixtureMap(): { tiles: Tile[]; width: number; height: number } {
  const width = 5;
  const height = 5;
  const tiles: Tile[] = [];

  // Fill everything as walkable (3)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      tiles.push(makeTile(x, y, 3));
    }
  }

  // Override specific tiles
  const overrides: [number, number, TileType][] = [
    [1, 1, 0], [3, 1, 0], // walls
    [1, 3, 0], [3, 3, 0], // walls
    [2, 2, 2],             // delivery zone (center)
    [4, 0, 2],             // delivery zone (corner)
    [0, 0, 1], [2, 0, 1], // spawning tiles
  ];

  for (const [ox, oy, ot] of overrides) {
    const idx = tiles.findIndex((t) => t.x === ox && t.y === oy);
    tiles[idx] = makeTile(ox, oy, ot);
  }

  return { tiles, width, height };
}

describe('BeliefMapImpl', () => {
  const { tiles, width, height } = makeFixtureMap();
  const map = new BeliefMapImpl(tiles, width, height);

  it('has correct dimensions', () => {
    assert.equal(map.width, 5);
    assert.equal(map.height, 5);
  });

  it('getTile returns correct types', () => {
    assert.equal(map.getTile(0, 0), 1); // spawning
    assert.equal(map.getTile(2, 2), 2); // delivery
    assert.equal(map.getTile(1, 1), 0); // wall
    assert.equal(map.getTile(0, 4), 3); // walkable
  });

  it('getTile returns null for out-of-bounds', () => {
    assert.equal(map.getTile(-1, 0), null);
    assert.equal(map.getTile(5, 0), null);
    assert.equal(map.getTile(0, -1), null);
    assert.equal(map.getTile(0, 5), null);
    assert.equal(map.getTile(100, 100), null);
  });

  it('isWalkable returns true for types 1, 2, 3 and false for 0', () => {
    assert.equal(map.isWalkable(0, 0), true);  // type 1
    assert.equal(map.isWalkable(2, 2), true);  // type 2
    assert.equal(map.isWalkable(0, 4), true);  // type 3
    assert.equal(map.isWalkable(1, 1), false); // type 0
  });

  it('isWalkable returns false for out-of-bounds', () => {
    assert.equal(map.isWalkable(-1, 0), false);
    assert.equal(map.isWalkable(5, 5), false);
  });

  it('isDeliveryZone identifies type-2 tiles', () => {
    assert.equal(map.isDeliveryZone(2, 2), true);
    assert.equal(map.isDeliveryZone(4, 0), true);
    assert.equal(map.isDeliveryZone(0, 0), false); // spawning, not delivery
    assert.equal(map.isDeliveryZone(0, 4), false); // walkable, not delivery
  });

  it('isSpawningTile identifies type-1 tiles', () => {
    assert.equal(map.isSpawningTile(0, 0), true);
    assert.equal(map.isSpawningTile(2, 0), true);
    assert.equal(map.isSpawningTile(2, 2), false); // delivery, not spawning
    assert.equal(map.isSpawningTile(0, 4), false); // walkable
  });

  it('getDeliveryZones returns exactly the type-2 tiles', () => {
    const zones = map.getDeliveryZones();
    assert.equal(zones.length, 2);
    const sorted = [...zones].sort((a, b) => a.x - b.x || a.y - b.y);
    assert.deepEqual(sorted, [
      { x: 2, y: 2 },
      { x: 4, y: 0 },
    ]);
  });

  it('getSpawningTiles returns exactly the type-1 tiles', () => {
    const spawns = map.getSpawningTiles();
    assert.equal(spawns.length, 2);
    const sorted = [...spawns].sort((a, b) => a.x - b.x || a.y - b.y);
    assert.deepEqual(sorted, [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it('handles string tile types from server (coerced to numbers)', () => {
    // Server may send tile types as strings
    const stringTiles = [
      { x: 0, y: 0, type: '1' as unknown as TileType },
      { x: 1, y: 0, type: '2' as unknown as TileType },
      { x: 0, y: 1, type: '0' as unknown as TileType },
      { x: 1, y: 1, type: '3' as unknown as TileType },
    ];
    const m = new BeliefMapImpl(stringTiles as Tile[], 2, 2);
    assert.equal(m.isSpawningTile(0, 0), true);
    assert.equal(m.isDeliveryZone(1, 0), true);
    assert.equal(m.isWalkable(0, 1), false);
    assert.equal(m.isWalkable(1, 1), true);
  });

  it('empty map has no delivery zones or spawning tiles', () => {
    const m = new BeliefMapImpl([], 3, 3);
    assert.equal(m.getDeliveryZones().length, 0);
    assert.equal(m.getSpawningTiles().length, 0);
    assert.equal(m.getTile(0, 0), null);
    assert.equal(m.isWalkable(0, 0), false);
  });
});
