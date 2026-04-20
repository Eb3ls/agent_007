import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";

export type StaticMap = {
	tiles: Map<string, IOTile>;
	minX: number;
	minY: number;
	gridWidth: number;
	gridHeight: number;
	hasDirectionalTiles: boolean;
	hasMovingWalls: boolean;
};

export function createStaticMap(): StaticMap {
	return {
		tiles: new Map(),
		minX: 0,
		minY: 0,
		gridWidth: 0,
		gridHeight: 0,
		hasDirectionalTiles: false,
		hasMovingWalls: false,
	};
}

export function setMap(m: StaticMap, tiles: IOTile[]): void {
	m.tiles.clear();
	m.hasDirectionalTiles = false;
	m.hasMovingWalls = false;

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const t of tiles) {
		if (t.x < minX) minX = t.x;
		if (t.y < minY) minY = t.y;
		if (t.x > maxX) maxX = t.x;
		if (t.y > maxY) maxY = t.y;
		m.tiles.set(`${t.x},${t.y}`, t);
		if (t.type === "←" || t.type === "↑" || t.type === "→" || t.type === "↓")
			m.hasDirectionalTiles = true;
		if (t.type === "5!") m.hasMovingWalls = true;
	}

	m.minX = minX === Infinity ? 0 : minX;
	m.minY = minY === Infinity ? 0 : minY;
	m.gridWidth = maxX === -Infinity ? 0 : maxX - minX + 1;
	m.gridHeight = maxY === -Infinity ? 0 : maxY - minY + 1;
}

export function updateTile(m: StaticMap, tile: IOTile): void {
	m.tiles.set(`${tile.x},${tile.y}`, tile);
}

/** Converts grid coordinates to a flat tile id for typed-array indexing. */
export function tileId(m: StaticMap, x: number, y: number): number {
	return (y - m.minY) * m.gridWidth + (x - m.minX);
}
