import { bfsFromSelf } from "./pathfinder.js";
import { GameClient } from "./game_client.js";
import { tileId } from "./static_map.js";
import {
	computeBlockedTiles,
	deriveCarryState,
	nearestOutOfViewSpawn,
	parcelHere,
	pickBestParcelTarget,
	planStep,
	shouldDrop,
} from "./planner.js";
import {
	FALLBACK_MOVEMENT_DURATION_MS,
	FALLBACK_OBSERVATION_DISTANCE,
	NO_STEP_WAIT_MS,
	POST_ACTION_WAIT_MS,
	READY_POLL_MS,
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
		const blocked = computeBlockedTiles(m, gc.beliefs, movMs);
		const bfs = bfsFromSelf(m, sx, sy, blocked);
		const parcels = gc.perception.visibleParcels;
		const carry = deriveCarryState(gc.beliefs.parcels, myId, m, bfs, decayMs, Date.now());
		const carrying = carry.n > 0;

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
