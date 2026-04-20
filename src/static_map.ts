import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";

export type StaticMap = {
	tiles: Map<string, IOTile>;
};

export function createStaticMap(): StaticMap {
	return { tiles: new Map() };
}

export function setMap(m: StaticMap, tiles: IOTile[]): void {
	m.tiles.clear();
	for (const t of tiles) m.tiles.set(`${t.x},${t.y}`, t);
}

export function updateTile(m: StaticMap, tile: IOTile): void {
	m.tiles.set(`${tile.x},${tile.y}`, tile);
}
