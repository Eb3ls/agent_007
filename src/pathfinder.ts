import {
	DIRS,
	canMoveForward,
	idToXY,
	inBounds,
	tileId,
	type StaticMap,
} from "./static_map.js";

export type Direction = "up" | "down" | "left" | "right";

export type BfsFromSelf = {
	dist: Int32Array; // -1 = unreachable; 0 = start tile
	prev: Int32Array; // -1 = no predecessor; otherwise tileId of parent
};

/**
 * Forward BFS from (sx, sy). Call once per cycle; reuse result for all target queries.
 *
 * `passableCrateTiles` marks crate-slide tiles currently free of a crate as walkable.
 * canMoveForward blocks all crate-slide tiles statically, so without this a route
 * opened by an earlier push would never be found.
 */
export function bfsFromSelf(
	m: StaticMap,
	sx: number,
	sy: number,
	blocked?: ReadonlySet<number>,
	passableCrateTiles?: ReadonlySet<number>,
): BfsFromSelf {
	const size = m.gridWidth * m.gridHeight;
	const dist = new Int32Array(size).fill(-1);
	const prev = new Int32Array(size).fill(-1);

	if (size === 0) return { dist, prev };
	if (!m.tiles.has(`${sx},${sy}`)) return { dist, prev };

	const startId = tileId(m, sx, sy);
	dist[startId] = 0;

	const queue = new Int32Array(size);
	let head = 0,
		tail = 0;
	queue[tail++] = startId;

	while (head < tail) {
		const cur = queue[head++]!;
		const { x: cx, y: cy } = idToXY(m, cur);
		const d = dist[cur]!;

		for (const [dx, dy] of DIRS) {
			const nx = cx + dx,
				ny = cy + dy;
			if (!inBounds(m, nx, ny)) continue;
			const nid = tileId(m, nx, ny);
			if (dist[nid] !== -1) continue;
			if (blocked?.has(nid)) continue;
			if (
				canMoveForward(m, cx, cy, nx, ny) ||
				passableCrateTiles?.has(nid)
			) {
				dist[nid] = d + 1;
				prev[nid] = cur;
				queue[tail++] = nid;
			}
		}
	}

	return { dist, prev };
}

/** Reconstructs direction sequence from start to (tx, ty). Returns null if unreachable, [] if already there. */
export function reconstructPath(
	m: StaticMap,
	bfs: BfsFromSelf,
	tx: number,
	ty: number,
): Direction[] | null {
	if (!inBounds(m, tx, ty)) return null;

	const tid = tileId(m, tx, ty);
	if (bfs.dist[tid] === -1) return null;
	if (bfs.dist[tid] === 0) return [];

	const path: Direction[] = [];
	let cur = tid;
	while (bfs.prev[cur] !== -1) {
		const p = bfs.prev[cur]!;
		const { x: cx, y: cy } = idToXY(m, cur);
		const { x: px, y: py } = idToXY(m, p);
		path.push(directionOf(px, py, cx, cy));
		cur = p;
	}

	return path.reverse();
}

export function directionOf(
	fx: number,
	fy: number,
	tx: number,
	ty: number,
): Direction {
	if (ty > fy) return "up";
	if (ty < fy) return "down";
	if (tx < fx) return "left";
	return "right";
}

// Maps each cardinal Direction to its [dx, dy] grid offset.
// Convention matches directionOf: up=+y, down=−y, right=+x, left=−x.
export const DELTA_OF: Record<Direction, readonly [number, number]> = {
	right: [1, 0],
	left: [-1, 0],
	up: [0, 1],
	down: [0, -1],
};
