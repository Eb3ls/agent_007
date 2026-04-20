import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";

export type World = {
	tiles: Map<string, IOTile>;
};

export function createWorld(): World {
	return { tiles: new Map() };
}

export function setMap(w: World, tiles: IOTile[]): void {
	w.tiles.clear();
	for (const t of tiles) w.tiles.set(`${t.x},${t.y}`, t);
}

export function updateTile(w: World, tile: IOTile): void {
	w.tiles.set(`${tile.x},${tile.y}`, tile);
}
