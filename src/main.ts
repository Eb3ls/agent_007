import {
	bfsFromSelf,
	gradientStepToDelivery,
	reconstructPath,
	type BfsFromSelf,
	type Direction,
} from "./pathfinder.js";
import { GameClient } from "./game_client.js";
import { tileId, type StaticMap } from "./static_map.js";
import type { IOParcel } from "@unitn-asa/deliveroo-js-sdk";
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
		await sleep(50);
	}
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

function pickBestParcelTarget(
	m: StaticMap,
	bfs: BfsFromSelf,
	parcels: Map<string, IOParcel>,
): IOParcel | null {
	let best: IOParcel | null = null;
	let bestDist = Infinity;
	for (const p of parcels.values()) {
		if (p.carriedBy) continue;
		const d = bfs.dist[tileId(m, p.x, p.y)];
		if (d === undefined || d === -1) continue;
		if (d < bestDist) {
			bestDist = d;
			best = p;
		}
	}
	return best;
}

function planStep(
	m: StaticMap,
	bfs: BfsFromSelf,
	sx: number,
	sy: number,
	carrying: boolean,
	target: IOParcel | null,
): Direction | null {
	if (carrying) return gradientStepToDelivery(m, sx, sy);
	if (!target) return null;
	const path = reconstructPath(m, bfs, target.x, target.y);
	return path?.[0] ?? null;
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
		const bfs = bfsFromSelf(m, sx, sy);
		const parcels = gc.perception.visibleParcels;

		// Derive carrying from sensing: server sets carriedBy=myId on our parcels.
		// If a parcel decays while carried it disappears from sensing → carrying becomes false automatically.
		const carrying = [...parcels.values()].some((p) => p.carriedBy === myId);

		if (shouldDrop(m, selfId, carrying)) {
			const dropped = await gc.putdown();
			console.log(`[putdown] dropped=${dropped.length}`);
			await sleep(300); // wait for sensing update before next cycle
			continue;
		}

		if (!carrying) {
			const here = parcelHere(parcels, sx, sy);
			if (here) {
				const picked = await gc.pickup();
				console.log(`[pickup] picked=${picked.length}`);
				await sleep(300); // wait for sensing update before next cycle
				continue;
			}
		}

		const target = carrying ? null : pickBestParcelTarget(m, bfs, parcels);
		const step = planStep(m, bfs, sx, sy, carrying, target);

		if (!step) {
			console.log(
				`[wait] no step — carrying=${carrying} distToDelivery=${m.baseReverseDistToDelivery[selfId]} pos=(${sx},${sy})`,
			);
			await sleep(200);
			continue;
		}

		const result = await gc.move(step);
		if (result) {
			sx = result.x;
			sy = result.y;
		}
		console.log(
			`[move] ${step} → ${result ? `ok@(${result.x},${result.y})` : "FAILED"}`,
		);
	}
}

loop().catch(console.error);
