import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";

export type StaticMap = {
	tiles: Map<string, IOTile>;
	hasDirectionalTiles: boolean;
	hasMovingWalls: boolean;
};

export function createStaticMap(): StaticMap {
	return { tiles: new Map(), hasDirectionalTiles: false, hasMovingWalls: false };
}

export function setMap(m: StaticMap, tiles: IOTile[]): void {
	m.tiles.clear();
	m.hasDirectionalTiles = false;
	m.hasMovingWalls = false;
	for (const t of tiles) {
		m.tiles.set(`${t.x},${t.y}`, t);
		if (t.type === "←" || t.type === "↑" || t.type === "→" || t.type === "↓")
			m.hasDirectionalTiles = true;
		if (t.type === "5!") m.hasMovingWalls = true;
	}
}

export function updateTile(m: StaticMap, tile: IOTile): void {
	m.tiles.set(`${tile.x},${tile.y}`, tile);
}
