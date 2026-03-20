// ============================================================
// src/beliefs/belief-map.ts — BeliefMap implementation (T06)
// Grid data structure conforming to BeliefMap interface
// ============================================================

import type { BeliefMap, Position, Tile, TileType } from '../types.js';

export class BeliefMapImpl implements BeliefMap {
  readonly width: number;
  readonly height: number;
  private readonly grid: (TileType | null)[][];
  private readonly deliveryZones: Position[];
  private readonly spawningTiles: Position[];

  constructor(tiles: ReadonlyArray<Tile>, width: number, height: number) {
    this.width = width;
    this.height = height;

    // Initialize grid with null (non-existent tiles)
    this.grid = Array.from({ length: width }, () =>
      Array.from({ length: height }, () => null),
    );

    this.deliveryZones = [];
    this.spawningTiles = [];

    for (const tile of tiles) {
      const type = Number(tile.type) as TileType;
      if (tile.x >= 0 && tile.x < width && tile.y >= 0 && tile.y < height) {
        this.grid[tile.x][tile.y] = type;

        if (type === 2) {
          this.deliveryZones.push({ x: tile.x, y: tile.y });
        } else if (type === 1) {
          this.spawningTiles.push({ x: tile.x, y: tile.y });
        }
      }
    }
  }

  getTile(x: number, y: number): TileType | null {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return null;
    }
    return this.grid[x][y];
  }

  isWalkable(x: number, y: number): boolean {
    const type = this.getTile(x, y);
    // Types 1–7 are walkable (direction constraints handled in getNeighbors); 0 and null are not
    return type !== null && type !== 0;
  }

  isDeliveryZone(x: number, y: number): boolean {
    return this.getTile(x, y) === 2;
  }

  isSpawningTile(x: number, y: number): boolean {
    return this.getTile(x, y) === 1;
  }

  getDeliveryZones(): ReadonlyArray<Position> {
    return this.deliveryZones;
  }

  getSpawningTiles(): ReadonlyArray<Position> {
    return this.spawningTiles;
  }
}
