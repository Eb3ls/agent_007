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

		// Derive carrying from sensing: server sets carriedBy=myId on our parcels.
		// If a parcel decays while carried it disappears from sensing → carrying becomes false automatically.
		const carrying = [...gc.perception.visibleParcels.values()].some(
			(p) => p.carriedBy === myId,
		);

		// On delivery with parcel → drop everything.
		if (carrying && m.baseReverseDistToDelivery[selfId] === 0) {
			const dropped = await gc.putdown();
			console.log(`[putdown] dropped=${dropped.length}`);
			await sleep(300); // wait for sensing update before next cycle
			continue;
		}

		// On a free parcel tile → pick up.
		if (!carrying) {
			const hereParcel = [...gc.perception.visibleParcels.values()].find(
				(p) => p.x === sx && p.y === sy && !p.carriedBy,
			);
			if (hereParcel) {
				const picked = await gc.pickup();
				console.log(`[pickup] picked=${picked.length}`);
				await sleep(300); // wait for sensing update before next cycle
				continue;
			}
		}

		// Choose next step.
		let step = null;
		if (carrying) {
			step = gradientStepToDelivery(m, sx, sy);
		} else {
			// Walk toward nearest reachable free parcel.
			let best = null;
			let bestDist = Infinity;
			for (const p of gc.perception.visibleParcels.values()) {
				if (p.carriedBy) continue;
				const d = bfs.dist[tileId(m, p.x, p.y)];
				if (d === undefined || d === -1) continue;
				if (d < bestDist) {
					bestDist = d;
					best = p;
				}
			}
			if (best) {
				const path = reconstructPath(m, bfs, best.x, best.y);
				step = path?.[0] ?? null;
			}
		}

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
