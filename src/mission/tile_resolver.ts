import type { StaticMap } from "../static_map.js";
import { idToXY } from "../static_map.js";

export type XY = { x: number; y: number };

/** Resolves a semantic label like "leftmost delivery" to a map coordinate. Returns null when unresolved. */
export function resolveLabel(label: string, map: StaticMap): XY | null {
	const norm = label.toLowerCase().trim();

	// "leftmost delivery" / "rightmost delivery" / "top delivery" / "bottom delivery"
	if (norm.includes("delivery") || norm.includes("deliver")) {
		const deliveries = map.deliveryTileIds.map((id) => idToXY(map, id));
		if (deliveries.length === 0) return null;
		if (norm.includes("left"))
			return deliveries.reduce((a, b) => (a.x < b.x ? a : b));
		if (norm.includes("right"))
			return deliveries.reduce((a, b) => (a.x > b.x ? a : b));
		if (norm.includes("top") || norm.includes("north"))
			return deliveries.reduce((a, b) => (a.y < b.y ? a : b));
		if (norm.includes("bottom") || norm.includes("south"))
			return deliveries.reduce((a, b) => (a.y > b.y ? a : b));
		return deliveries[0] ?? null;
	}

	// "leftmost spawn" / "rightmost spawn"
	if (norm.includes("spawn") || norm.includes("spawner")) {
		const spawns = map.spawnTileIds.map((id) => idToXY(map, id));
		if (spawns.length === 0) return null;
		if (norm.includes("left"))
			return spawns.reduce((a, b) => (a.x < b.x ? a : b));
		if (norm.includes("right"))
			return spawns.reduce((a, b) => (a.x > b.x ? a : b));
		if (norm.includes("top") || norm.includes("north"))
			return spawns.reduce((a, b) => (a.y < b.y ? a : b));
		if (norm.includes("bottom") || norm.includes("south"))
			return spawns.reduce((a, b) => (a.y > b.y ? a : b));
		return spawns[0] ?? null;
	}

	// "center" / "middle"
	if (norm.includes("center") || norm.includes("middle")) {
		if (map.gridWidth > 0 && map.gridHeight > 0) {
			return {
				x: map.minX + Math.floor(map.gridWidth / 2),
				y: map.minY + Math.floor(map.gridHeight / 2),
			};
		}
	}

	// Bare directional labels ("rightmost tile", "leftmost", "topmost", "bottommost")
	// without a type qualifier — default to delivery tiles since that's where packages are dropped.
	const deliveries = map.deliveryTileIds.map((id) => idToXY(map, id));
	if (deliveries.length > 0) {
		if (norm.includes("right"))
			return deliveries.reduce((a, b) => (a.x > b.x ? a : b));
		if (norm.includes("left"))
			return deliveries.reduce((a, b) => (a.x < b.x ? a : b));
		if (norm.includes("top") || norm.includes("north"))
			return deliveries.reduce((a, b) => (a.y < b.y ? a : b));
		if (norm.includes("bottom") || norm.includes("south"))
			return deliveries.reduce((a, b) => (a.y > b.y ? a : b));
	}

	return null;
}
