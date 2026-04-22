import { bfsFromSelf, reconstructPath, type BfsFromSelf, type Direction } from "./pathfinder.js";
import { GameClient } from "./game_client.js";
import { idToXY, inBounds, tileId, type StaticMap } from "./static_map.js";
import type { BeliefStore, ParcelBelief } from "./belief_store.js";
import type { IOParcel } from "@unitn-asa/deliveroo-js-sdk";
import {
	FALLBACK_MOVEMENT_DURATION_MS,
	FALLBACK_OBSERVATION_DISTANCE,
	NO_STEP_WAIT_MS,
	POST_ACTION_WAIT_MS,
	READY_POLL_MS,
	SHORT_BLOCK_TTL_MS,
	parseDecayInterval,
} from "./config.js";
import dotenv from "dotenv";

dotenv.config();

const host = process.env.DELIVEROO_HOST;
const token = process.env.DELIVEROO_TOKEN;

if (!host || !token) {
	console.error("Missing DELIVEROO_HOST or DELIVEROO_TOKEN");
	process.exit(1);
}

const gc = new GameClient(host, token);
gc.connect();

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// Waits until map is loaded and self has an integer position (not mid-animation).
async function waitForReady(): Promise<{ id: string; x: number; y: number }> {
	while (true) {
		const self = gc.perception.self;
		if (
			gc.staticMap.tiles.size > 0 &&
			self?.x !== undefined &&
			self?.y !== undefined &&
			Number.isInteger(self.x) &&
			Number.isInteger(self.y)
		) {
			return { id: self.id, x: self.x, y: self.y };
		}
		await sleep(READY_POLL_MS);
	}
}

function computeBlockedTiles(m: StaticMap, beliefs: BeliefStore): Set<number> {
	const blocked = new Set<number>();
	const now = Date.now();
	for (const a of beliefs.agents.values()) {
		if (!a.inView && now - a.lastSeenAt > SHORT_BLOCK_TTL_MS) continue;
		if (a.x === undefined || a.y === undefined) continue;
		const ax = Math.round(a.x);
		const ay = Math.round(a.y);
		if (!inBounds(m, ax, ay)) continue;
		blocked.add(tileId(m, ax, ay));
	}
	return blocked;
}

function nearestDeliveryTile(
	m: StaticMap,
	bfs: BfsFromSelf,
): { x: number; y: number } | null {
	let bestId = -1,
		bestDist = Infinity;
	for (const did of m.deliveryTileIds) {
		const d = bfs.dist[did];
		if (d !== undefined && d !== -1 && d < bestDist) {
			bestDist = d;
			bestId = did;
		}
	}
	return bestId === -1 ? null : idToXY(m, bestId);
}

function nearestOutOfViewSpawn(
	m: StaticMap,
	bfs: BfsFromSelf,
	sx: number,
	sy: number,
	observationDistance: number,
): { x: number; y: number } | null {
	let bestId = -1;
	let bestCost = Infinity;
	for (const sid of m.spawnTileIds) {
		const sp = bfs.dist[sid];
		if (sp === undefined || sp <= 0) continue;
		const sd = m.baseReverseDistToDelivery[sid];
		if (sd === undefined || sd === -1) continue;
		const { x, y } = idToXY(m, sid);
		if (Math.max(Math.abs(x - sx), Math.abs(y - sy)) <= observationDistance) continue;
		const cost = sp + sd;
		if (cost < bestCost) {
			bestCost = cost;
			bestId = sid;
		}
	}
	return bestId === -1 ? null : idToXY(m, bestId);
}

function shouldDrop(m: StaticMap, selfId: number, carrying: boolean): boolean {
	return carrying && m.baseReverseDistToDelivery[selfId] === 0;
}

function parcelHere(
	parcels: Map<string, IOParcel>,
	sx: number,
	sy: number,
): IOParcel | undefined {
	for (const p of parcels.values()) {
		if (p.x === sx && p.y === sy && !p.carriedBy) return p;
	}
	return undefined;
}

function currentReward(p: ParcelBelief, decayIntervalMs: number, now: number): number {
	if (!Number.isFinite(decayIntervalMs)) return p.reward;
	return p.reward - Math.floor((now - p.firstSeenAt) / decayIntervalMs);
}

function pickBestParcelTarget(
	m: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	decayIntervalMs: number,
	movementDurationMs: number,
): IOParcel | null {
	const now = Date.now();
	const decayPerStep = Number.isFinite(decayIntervalMs)
		? movementDurationMs / decayIntervalMs
		: 0;
	let best: ParcelBelief | null = null;
	let bestUtility = -Infinity;
	let bestSp = Infinity;
	for (const p of beliefs.parcels.values()) {
		if (!p.inView) continue;
		if (p.carriedBy) continue;
		const pid = tileId(m, p.x, p.y);
		const sp = bfs.dist[pid];
		if (sp === undefined || sp === -1) continue;
		const sd = m.baseReverseDistToDelivery[pid];
		if (sd === undefined || sd === -1) continue;
		const reward = currentReward(p, decayIntervalMs, now);
		if (reward <= 0) continue;
		const utility = reward - decayPerStep * (sp + sd);
		if (utility <= 0) continue;
		if (utility > bestUtility || (utility === bestUtility && sp < bestSp)) {
			bestUtility = utility;
			bestSp = sp;
			best = p;
		}
	}
	return best;
}

function planStep(
	m: StaticMap,
	bfs: BfsFromSelf,
	carrying: boolean,
	target: IOParcel | null,
	exploreTarget: { x: number; y: number } | null,
): Direction | null {
	const dest = carrying
		? nearestDeliveryTile(m, bfs)
		: target
			? { x: target.x, y: target.y }
			: exploreTarget;
	if (!dest) return null;
	return reconstructPath(m, bfs, dest.x, dest.y)?.[0] ?? null;
}

async function loop(): Promise<void> {
	// sx/sy are always confirmed integer positions:
	// — seeded from the initial onYou (integer at connect time)
	// — updated from ACK results (server guarantees integer after move completes)
	// Never read from perception.self mid-loop: onYou fires with fractional
	// positions during animation (server sets pos+0.6*step immediately, before synch).
	const { id: myId, x: startX, y: startY } = await waitForReady();
	let sx = startX,
		sy = startY;

	const m = gc.staticMap;
	console.log(
		`[map] tiles=${m.tiles.size} | delivery_zones=${m.deliveryTileIds.length}`,
	);
	console.log(`[main] starting loop at (${sx},${sy})`);

	while (true) {
		const selfId = tileId(m, sx, sy);
		const decayMs = parseDecayInterval(gc.config?.GAME.parcels.decaying_event);
		const movMs = gc.config?.GAME.player.movement_duration ?? FALLBACK_MOVEMENT_DURATION_MS;
		const blocked = computeBlockedTiles(m, gc.beliefs);
		const bfs = bfsFromSelf(m, sx, sy, blocked);
		const parcels = gc.perception.visibleParcels;

		// Derive carrying from sensing: server sets carriedBy=myId on our parcels.
		// If a parcel decays while carried it disappears from sensing → carrying becomes false automatically.
		const carrying = [...parcels.values()].some((p) => p.carriedBy === myId);

		if (shouldDrop(m, selfId, carrying)) {
			const dropped = await gc.putdown();
			console.log(`[putdown] dropped=${dropped.length}`);
			await sleep(POST_ACTION_WAIT_MS);
			continue;
		}

		if (!carrying) {
			const here = parcelHere(parcels, sx, sy);
			if (here) {
				const picked = await gc.pickup();
				console.log(`[pickup] picked=${picked.length}`);
				await sleep(POST_ACTION_WAIT_MS);
				continue;
			}
		}

		const obsDist = gc.config?.GAME.player.observation_distance ?? FALLBACK_OBSERVATION_DISTANCE;
		const target = carrying ? null : pickBestParcelTarget(m, bfs, gc.beliefs, decayMs, movMs);
		const explore =
			!carrying && !target ? nearestOutOfViewSpawn(m, bfs, sx, sy, obsDist) : null;
		const step = planStep(m, bfs, carrying, target, explore);

		if (!step) {
			console.log(
				`[wait] no step — carrying=${carrying} distToDelivery=${m.baseReverseDistToDelivery[selfId]} pos=(${sx},${sy})`,
			);
			await sleep(NO_STEP_WAIT_MS);
			continue;
		}

		const result = await gc.move(step);
		if (result) {
			sx = result.x;
			sy = result.y;
			console.log(`[move] ${step} → ok@(${sx},${sy})`);
		} else {
			const waitMs = gc.config?.GAME.player.movement_duration ?? FALLBACK_MOVEMENT_DURATION_MS;
			console.log(`[move] ${step} → FAILED (wait ${waitMs}ms)`);
			await sleep(waitMs);
		}
	}
}

loop().catch(console.error);
