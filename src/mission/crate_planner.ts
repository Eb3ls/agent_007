import {
	DIRS,
	TILE,
	canMoveForward,
	idToXY,
	inBounds,
	tileId,
	type StaticMap,
} from "../static_map.js";
import { planWithCrates } from "./pddl_planner.js";
import type { Direction } from "../pathfinder.js";

// ── Dead-square detection ─────────────────────────────────────────────────────

/**
 * A type-5 tile is a dead square when a crate placed on it cannot be pushed out
 * in any direction: both the push-from and push-to tiles must be type-5 for a
 * push to be legal, so a corner (blocked in both axes) is permanent.
 */
export function computeDeadSquares(map: StaticMap): Set<number> {
	const dead = new Set<number>();
	for (const [, t] of map.tiles) {
		if (!t.type.startsWith("5")) continue;
		const id = tileId(map, t.x, t.y);
		if (isTileDeadSquare(map, t.x, t.y)) dead.add(id);
	}
	return dead;
}

function isTileDeadSquare(map: StaticMap, x: number, y: number): boolean {
	// Horizontal: can push left (from right, to left) or push right (from left, to right)
	const leftType = map.tiles.get(`${x - 1},${y}`)?.type;
	const rightType = map.tiles.get(`${x + 1},${y}`)?.type;
	const upType = map.tiles.get(`${x},${y + 1}`)?.type;
	const downType = map.tiles.get(`${x},${y - 1}`)?.type;

	// Push along H axis requires type-5 on BOTH sides (push-from and push-to).
	const canPushH =
		(leftType?.startsWith("5") ?? false) &&
		(rightType?.startsWith("5") ?? false);
	const canPushV =
		(upType?.startsWith("5") ?? false) &&
		(downType?.startsWith("5") ?? false);

	return !canPushH && !canPushV;
}

// ── Reachability (BFS) ────────────────────────────────────────────────────────

/**
 * BFS over type-5/walkable tiles, excluding tiles occupied by crates.
 * Returns the set of tile IDs reachable from startId.
 */
function bfsReachable(
	map: StaticMap,
	startId: number,
	crateSet: ReadonlySet<number>,
): Set<number> {
	const visited = new Set<number>();
	const queue: number[] = [startId];
	visited.add(startId);

	while (queue.length > 0) {
		const cur = queue.shift()!;
		const { x, y } = idToXY(map, cur);

		for (const [dx, dy] of DIRS) {
			const nx = x + dx,
				ny = y + dy;
			if (!inBounds(map, nx, ny)) continue;
			const nid = tileId(map, nx, ny);
			if (visited.has(nid) || crateSet.has(nid)) continue;
			if (!canMoveForward(map, x, y, nx, ny)) continue;
			visited.add(nid);
			queue.push(nid);
		}
	}
	return visited;
}

/**
 * Finds the crate tile whose removal restores connectivity from agentTile to
 * any delivery tile. Returns the blocking crate's tile ID or null if delivery is
 * already reachable or no single crate removal fixes connectivity.
 */
export function findBridgeCrateTile(
	map: StaticMap,
	agentTile: number,
	crates: ReadonlyArray<number>,
	deliveryTileIds: ReadonlyArray<number>,
): number | null {
	const crateSet = new Set(crates);

	// Already reachable — nothing to do.
	const reach = bfsReachable(map, agentTile, crateSet);
	if (deliveryTileIds.some((d) => reach.has(d))) return null;

	// Try removing each crate one at a time.
	for (const c of crates) {
		const reduced = new Set(crateSet);
		reduced.delete(c);
		const r = bfsReachable(map, agentTile, reduced);
		if (deliveryTileIds.some((d) => r.has(d))) return c;
	}
	return null;
}

// ── Reachability watch ────────────────────────────────────────────────────────

export type ReachabilityStatus = {
	deliveryReachable: boolean;
	bridgeCrateTile: number | null;
};

/**
 * Called after each crate-position sensing update.
 * Returns current reachability status and the blocking crate tile (if any).
 */
export function checkReachability(
	map: StaticMap,
	agentTile: number,
	crates: ReadonlyArray<number>,
): ReachabilityStatus {
	const crateSet = new Set(crates);
	const reach = bfsReachable(map, agentTile, crateSet);
	const deliveryReachable = map.deliveryTileIds.some((d) => reach.has(d));
	if (deliveryReachable)
		return { deliveryReachable: true, bridgeCrateTile: null };

	const bridge = findBridgeCrateTile(
		map,
		agentTile,
		crates,
		map.deliveryTileIds,
	);
	return { deliveryReachable: false, bridgeCrateTile: bridge };
}

export async function planCrateNavPath(
	map: StaticMap,
	beliefs: import("../belief_store.js").BeliefStore,
	selfX: number,
	selfY: number,
	targetX: number,
	targetY: number,
): Promise<Direction[] | null> {
	return planWithCrates(map, beliefs, selfX, selfY, targetX, targetY);
}
