import {
	bfsFromSelf,
	gradientStepToDelivery,
	reconstructPath,
} from "./pathfinder.js";
import { GameClient } from "./game_client.js";
import { tileId } from "./static_map.js";
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
async function waitForReady(): Promise<{ x: number; y: number }> {
	while (true) {
		const self = gc.perception.self;
		if (
			gc.staticMap.tiles.size > 0 &&
			self?.x !== undefined &&
			self?.y !== undefined &&
			Number.isInteger(self.x) &&
			Number.isInteger(self.y)
		) {
			return { x: self.x, y: self.y };
		}
		await sleep(50);
	}
}

async function loop(): Promise<void> {
	// sx/sy are always confirmed integer positions:
	// — seeded from the initial onYou (integer at connect time)
	// — updated from ACK results (server guarantees integer after move completes)
	// Never read from perception.self mid-loop: onYou fires with fractional
	// positions during animation (server sets pos+0.6*step immediately, before synch).
	let { x: sx, y: sy } = await waitForReady();

	const m = gc.staticMap;
	const tilesReachingDelivery = m.baseReverseDistToDelivery.filter(
		(d) => d >= 0,
	).length;
	console.log(
		`[map] tiles=${m.tiles.size} | delivery_zones=${m.deliveryTileIds.length} | reachable_from_delivery=${tilesReachingDelivery}/${m.gridWidth * m.gridHeight}`,
	);
	console.log(`[main] starting loop at (${sx},${sy})`);

	while (true) {
		const selfId = tileId(m, sx, sy);
		const distToDelivery = m.baseReverseDistToDelivery[selfId] ?? -1;

		const bfs = bfsFromSelf(m, sx, sy);
		const reachable = bfs.dist.filter((d) => d >= 0).length;

		const parcels = [...gc.perception.visibleParcels.values()];
		const firstParcel = parcels[0];
		if (firstParcel) {
			const dist = bfs.dist[tileId(m, firstParcel.x, firstParcel.y)];
			const path = reconstructPath(m, bfs, firstParcel.x, firstParcel.y);
			console.log(
				`[bfs] pos=(${sx},${sy}) to_delivery=${distToDelivery} reachable=${reachable} | parcel@(${firstParcel.x},${firstParcel.y}) dist=${dist ?? "?"} path=[${path?.join(",") ?? "null"}]`,
			);
		} else {
			console.log(
				`[bfs] pos=(${sx},${sy}) to_delivery=${distToDelivery} reachable=${reachable} | no visible parcels`,
			);
		}

		const step = gradientStepToDelivery(m, sx, sy);
		if (!step) {
			console.log("[move] on delivery or unreachable — waiting");
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
