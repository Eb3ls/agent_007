import {
	type Intention,
	computeBlockedTiles,
	deriveCarryState,
	nearestDeliveryTile,
	nearestOutOfViewSpawn,
	parcelHere,
	pickBestDetourTarget,
	pickBestParcelTarget,
	planStep,
	shouldDrop,
	shouldReplan,
} from "./planner.js";
import {
	DETOUR_UTILITY_EPSILON,
	EXPECTED_STEAL_HORIZON_STEPS,
	FALLBACK_AGENT_CAPACITY,
	FALLBACK_MOVEMENT_DURATION_MS,
	FALLBACK_OBSERVATION_DISTANCE,
	NO_STEP_WAIT_MS,
	READY_POLL_MS,
	parseDecayInterval,
} from "./config.js";
import { applyDelivery, applyPickupResult } from "./belief_store.js";
import { GameClient } from "./game_client.js";
import { bfsFromSelf } from "./pathfinder.js";
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

	const map = gc.staticMap;
	console.log(
		`[map] tiles=${map.tiles.size} | delivery_zones=${map.deliveryTileIds.length}`,
	);
	console.log(`[main] starting loop at (${sx},${sy})`);

	const decayMs = parseDecayInterval(gc.config?.GAME.parcels.decaying_event);
	const movMs =
		gc.config?.GAME.player.movement_duration ??
		FALLBACK_MOVEMENT_DURATION_MS;
	const obsDist =
		gc.config?.GAME.player.observation_distance ??
		FALLBACK_OBSERVATION_DISTANCE;
	const waitMs =
		gc.config?.GAME.player.movement_duration ??
		FALLBACK_MOVEMENT_DURATION_MS;

	let intention: Intention | null = null;

	while (true) {
		const selfId = tileId(map, sx, sy);
		const blocked = computeBlockedTiles(map, gc.beliefs, movMs);
		const bfs = bfsFromSelf(map, sx, sy, blocked);
		const carry = deriveCarryState(
			gc.beliefs.parcels,
			myId,
			map,
			bfs,
			decayMs,
			Date.now(),
		);
		const carrying = carry.n > 0;

		if (shouldDrop(map, selfId, carrying)) {
			const dropped = await gc.putdown();
			applyDelivery(gc.beliefs, myId);
			console.log(`[deliver] putdown=${dropped.length} cleared=${carry.n}`);
			continue;
		}

		const here = parcelHere(gc.beliefs.parcels, sx, sy);
		if (here) {
			const picked = await gc.pickup();
			applyPickupResult(gc.beliefs, picked, myId);
			console.log(`[pickup] picked=${picked.length}`);
			continue;
		}

		const capacity =
			gc.config?.GAME.player.capacity ?? FALLBACK_AGENT_CAPACITY;
		const target = carrying
			? null
			: pickBestParcelTarget(map, bfs, gc.beliefs, decayMs, movMs);
		const detour = carrying
			? pickBestDetourTarget(
					map,
					bfs,
					gc.beliefs,
					carry,
					decayMs,
					movMs,
					EXPECTED_STEAL_HORIZON_STEPS,
					capacity,
					DETOUR_UTILITY_EPSILON,
				)
			: null;
		const explore =
			!carrying && !target
				? nearestOutOfViewSpawn(map, bfs, sx, sy, obsDist)
				: null;

		// Build candidate intention from current evaluation.
		const now = Date.now();
		let candidate: Intention | null = null;
		if (carrying && detour) {
			candidate = {
				kind: "detour",
				targetId: detour.id,
				targetXY: { x: detour.x, y: detour.y },
				expectedUtility: 0,
				committedAt: now,
				moveFailStreak: 0,
			};
		} else if (carrying) {
			const del = nearestDeliveryTile(map, bfs);
			if (del)
				candidate = {
					kind: "deliver",
					targetXY: del,
					expectedUtility: 0,
					committedAt: now,
					moveFailStreak: 0,
				};
		} else if (target) {
			candidate = {
				kind: "pickup",
				targetId: target.id,
				targetXY: { x: target.x, y: target.y },
				expectedUtility: 0,
				committedAt: now,
				moveFailStreak: 0,
			};
		} else if (explore) {
			candidate = {
				kind: "explore",
				targetXY: explore,
				expectedUtility: 0,
				committedAt: now,
				moveFailStreak: 0,
			};
		}

		const replanning = shouldReplan(
			intention,
			candidate,
			gc.beliefs,
			map,
			bfs,
			sx,
			sy,
			now,
			movMs,
		);
		if (replanning) {
			intention = candidate
				? { ...candidate, committedAt: now, moveFailStreak: 0 }
				: null;
			if (intention)
				console.log(
					`[intent] replan kind=${intention.kind} target=${JSON.stringify(intention.targetXY)}`,
				);
		} else {
			if (intention)
				console.log(
					`[intent] keep kind=${intention.kind} age=${Math.round((now - intention.committedAt) / movMs)}steps fails=${intention.moveFailStreak}`,
				);
		}

		const commitTarget =
			!replanning && intention ? intention.targetXY : null;
		const step = planStep(
			map,
			bfs,
			carrying,
			target,
			detour,
			explore,
			commitTarget,
		);

		if (!step) {
			console.log(
				`[wait] no step — carrying=${carrying} distToDelivery=${map.baseReverseDistToDelivery[selfId]} pos=(${sx},${sy})`,
			);
			await sleep(NO_STEP_WAIT_MS);
			continue;
		}

		const result = await gc.move(step);
		if (result) {
			sx = result.x;
			sy = result.y;
			console.log(`[move] ${step} → ok@(${sx},${sy})`);
			if (intention) intention.moveFailStreak = 0;
		} else {
			console.log(`[move] ${step} → FAILED (wait ${waitMs}ms)`);
			if (intention) intention.moveFailStreak++;
			await sleep(waitMs);
		}
	}
}

loop().catch(console.error);
