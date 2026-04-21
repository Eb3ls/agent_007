import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";

// The 4 cardinal move offsets [dx, dy]. Exported for reuse in pathfinder.
export const DIRS: [number, number][] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];

export const TILE = {
	EMPTY: "0",
	WALKABLE: "1",
	DELIVERY: "2",
	WALL: "5",
	WALL_MOVING: "5!",
	ARROW_R: "→",
	ARROW_L: "←",
	ARROW_U: "↑",
	ARROW_D: "↓",
} as const;

export type StaticMap = {
	tiles: Map<string, IOTile>;
	minX: number;
	minY: number;
	gridWidth: number;
	gridHeight: number;
	hasMovingWalls: boolean;
	// Precomputed at setMap — used by pathfinder
	deliveryTileIds: number[];
	baseReverseDistToDelivery: Int32Array; // min steps to any delivery; -1 = unreachable
};

export function createStaticMap(): StaticMap {
	return {
		tiles: new Map(),
		minX: 0,
		minY: 0,
		gridWidth: 0,
		gridHeight: 0,
		hasMovingWalls: false,
		deliveryTileIds: [],
		baseReverseDistToDelivery: new Int32Array(0),
	};
}

export function setMap(m: StaticMap, tiles: IOTile[]): void {
	m.tiles.clear();
	m.hasMovingWalls = false;

	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const raw of tiles) {
		// Coerce type to string: server may send numeric tile types (e.g. 2 instead of "2").
		const t = { ...raw, type: String(raw.type) as IOTile["type"] };
		if (t.x < minX) minX = t.x;
		if (t.y < minY) minY = t.y;
		if (t.x > maxX) maxX = t.x;
		if (t.y > maxY) maxY = t.y;
		m.tiles.set(`${t.x},${t.y}`, t);
		if (t.type === TILE.WALL_MOVING) m.hasMovingWalls = true;
	}

	m.minX = minX === Infinity ? 0 : minX;
	m.minY = minY === Infinity ? 0 : minY;
	m.gridWidth = maxX === -Infinity ? 0 : maxX - minX + 1;
	m.gridHeight = maxY === -Infinity ? 0 : maxY - minY + 1;

	const size = m.gridWidth * m.gridHeight;
	if (size > 0) buildDeliveryBfs(m, size);
}

export function updateTile(m: StaticMap, tile: IOTile): void {
	const t = { ...tile, type: String(tile.type) as IOTile["type"] };
	m.tiles.set(`${t.x},${t.y}`, t);
}

/** Converts grid coordinates to a flat tile id for typed-array indexing. */
export function tileId(m: StaticMap, x: number, y: number): number {
	return (y - m.minY) * m.gridWidth + (x - m.minX);
}

/** Decodes a flat tile id back to grid coordinates. */
export function idToXY(m: StaticMap, id: number): { x: number; y: number } {
	return { x: (id % m.gridWidth) + m.minX, y: Math.floor(id / m.gridWidth) + m.minY };
}

/** Returns true if (x, y) is within the map bounding box. */
export function inBounds(m: StaticMap, x: number, y: number): boolean {
	return x >= m.minX && x < m.minX + m.gridWidth && y >= m.minY && y < m.minY + m.gridHeight;
}

/**
 * Returns true if moving from (fx,fy) to (tx,ty) is a valid forward move.
 *
 * Server rules (Tile.js / Controller.js, confirmed):
 *   - EXIT from any tile: always allowed (allowsExitInDirection returns true unconditionally).
 *   - ENTRY into a directional tile: prohibited only from the direction OPPOSITE to the arrow.
 *     '→' prohibits entry when dx=-1, '←' when dx=+1, '↓' when dy=+1, '↑' when dy=-1.
 *   - Walls (type "5") are locked tiles; "5!" landing spots are walkable when unoccupied but
 *     we conservatively block both to avoid collisions with moving walls.
 */
export function canMoveForward(
	m: StaticMap,
	fx: number,
	fy: number,
	tx: number,
	ty: number,
): boolean {
	const to = m.tiles.get(`${tx},${ty}`);
	if (!to || to.type === TILE.EMPTY || to.type === TILE.WALL || to.type === TILE.WALL_MOVING)
		return false;
	const from = m.tiles.get(`${fx},${fy}`);
	if (!from || from.type === TILE.EMPTY) return false;

	const dx = tx - fx,
		dy = ty - fy;

	// Entry restrictions: block the direction opposite to the arrow symbol.
	if (to.type === TILE.ARROW_R && dx === -1) return false;
	if (to.type === TILE.ARROW_L && dx === 1) return false;
	if (to.type === TILE.ARROW_D && dy === 1) return false;
	if (to.type === TILE.ARROW_U && dy === -1) return false;

	return true;
}

// Multi-source reverse BFS from all delivery tiles. Runs once at setMap.
// "Reverse" means: instead of asking "can I reach a delivery from here?", we ask
// "which tiles have a forward edge into the already-visited set?" — so a single BFS
// from the delivery set fills the whole map in one pass instead of N separate BFS runs.
// Result: baseReverseDistToDelivery[id] = min steps to any delivery, -1 if unreachable.
function buildDeliveryBfs(m: StaticMap, size: number): void {
	m.deliveryTileIds = [];
	m.baseReverseDistToDelivery = new Int32Array(size).fill(-1);
	const queue = new Int32Array(size);
	let head = 0,
		tail = 0;

	for (const [, t] of m.tiles) {
		if (t.type === TILE.DELIVERY) {
			const id = tileId(m, t.x, t.y);
			if (m.baseReverseDistToDelivery[id] === -1) {
				m.deliveryTileIds.push(id);
				m.baseReverseDistToDelivery[id] = 0;
				queue[tail++] = id;
			}
		}
	}

	while (head < tail) {
		const cur = queue[head++]!;
		const cx = (cur % m.gridWidth) + m.minX;
		const cy = Math.floor(cur / m.gridWidth) + m.minY;
		const d = m.baseReverseDistToDelivery[cur]!;

		for (const [dx, dy] of DIRS) {
			const nx = cx + dx,
				ny = cy + dy;
			if (nx < m.minX || nx >= m.minX + m.gridWidth) continue;
			if (ny < m.minY || ny >= m.minY + m.gridHeight) continue;
			const nid = tileId(m, nx, ny);
			if (m.baseReverseDistToDelivery[nid] !== -1) continue;
			// Reverse edge: does the forward graph have (nx,ny) → (cx,cy)?
			if (canMoveForward(m, nx, ny, cx, cy)) {
				m.baseReverseDistToDelivery[nid] = d + 1;
				queue[tail++] = nid;
			}
		}
	}
}
