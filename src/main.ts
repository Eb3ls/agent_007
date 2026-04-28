import {
	DETOUR_UTILITY_EPSILON,
	EXPECTED_STEAL_HORIZON_STEPS,
	FALLBACK_AGENT_CAPACITY,
	FALLBACK_MOVEMENT_DURATION_MS,
	FALLBACK_OBSERVATION_DISTANCE,
	NO_STEP_WAIT_MS,
	READY_POLL_MS,
	SPAWN_VISITED_TTL_STEPS,
	parseDecayInterval,
} from "./config.js";
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

const client = new GameClient(host, token);
client.connect();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits until map is loaded and self has an integer position (not mid-animation).
async function waitForReady(): Promise<{ id: string; x: number; y: number }> {
	while (true) {
		const self = client.perception.self;
		if (
			client.staticMap.tiles.size > 0 &&
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

function makeIntention(
	kind: Intention["kind"],
	targetXY: { x: number; y: number },
	now: number,
	targetId?: string,
): Intention {
	const base = { kind, targetXY, expectedUtility: 0, committedAt: now, moveFailStreak: 0 };
	return targetId !== undefined ? { ...base, targetId } : base;
}

async function loop(): Promise<void> {
	// selfX/selfY are always confirmed integer positions:
	// — seeded from the initial onYou (integer at connect time)
	// — updated from ACK results (server guarantees integer after move completes)
	// Never read from perception.self mid-loop: onYou fires with fractional
	// positions during animation (server sets pos+0.6*step immediately, before synch).
	const { id: myId, x: startX, y: startY } = await waitForReady();
	let selfX = startX,
		selfY = startY;

	const map = client.staticMap;
	console.log(
		`[map] tiles=${map.tiles.size} | delivery_zones=${map.deliveryTileIds.length}`,
	);
	console.log(`[main] starting loop at (${selfX},${selfY})`);

	const decayIntervalMs = parseDecayInterval(client.config?.GAME.parcels.decaying_event);
	const movementDurationMs =
		client.config?.GAME.player.movement_duration ??
		FALLBACK_MOVEMENT_DURATION_MS;
	const observationDistance =
		client.config?.GAME.player.observation_distance ??
		FALLBACK_OBSERVATION_DISTANCE;
	const capacity = client.config?.GAME.player.capacity ?? FALLBACK_AGENT_CAPACITY;
	const spawnTtlMs = SPAWN_VISITED_TTL_STEPS * movementDurationMs;

	let intention: Intention | null = null;
	const visitedSpawns = new Map<number, number>(); // tileId → visitedAt ms

	while (true) {
		const selfId = tileId(map, selfX, selfY);
		const blocked = computeBlockedTiles(map, client.beliefs, movementDurationMs);
		const bfs = bfsFromSelf(map, selfX, selfY, blocked);
		const carry = deriveCarryState(
			client.beliefs.parcels,
			myId,
			map,
			bfs,
			decayIntervalMs,
			Date.now(),
		);
		const carrying = carry.n > 0;

		if (shouldDrop(map, selfId, carrying)) {
			const dropped = await client.putdown();
			applyDelivery(client.beliefs, myId);
			console.log(
				`[deliver] putdown=${dropped.length} cleared=${carry.n}`,
			);
			continue;
		}

		const parcelAtFeet = parcelHere(client.beliefs.parcels, selfX, selfY);
		if (parcelAtFeet) {
			const picked = await client.pickup();
			applyPickupResult(client.beliefs, picked, myId);
			console.log(`[pickup] picked=${picked.length}`);
			continue;
		}

		const target = carrying
			? null
			: pickBestParcelTarget(map, bfs, client.beliefs, decayIntervalMs, movementDurationMs);
		const detour = carrying
			? pickBestDetourTarget(
					map,
					bfs,
					client.beliefs,
					carry,
					decayIntervalMs,
					movementDurationMs,
					EXPECTED_STEAL_HORIZON_STEPS,
					capacity,
					DETOUR_UTILITY_EPSILON,
				)
			: null;

		// Build candidate intention from current evaluation.
		const now = Date.now();
		const freshVisited = new Set<number>();
		for (const [id, visitedAt] of visitedSpawns) {
			if (now - visitedAt < spawnTtlMs) freshVisited.add(id);
		}
		const explore =
			!carrying && !target
				? nearestOutOfViewSpawn(map, bfs, selfX, selfY, observationDistance, freshVisited)
				: null;
		let candidate: Intention | null = null;
		if (carrying && detour) {
			candidate = makeIntention("detour", { x: detour.x, y: detour.y }, now, detour.id);
		} else if (carrying) {
			const deliveryXY = nearestDeliveryTile(map, bfs);
			if (deliveryXY) candidate = makeIntention("deliver", deliveryXY, now);
		} else if (target) {
			candidate = makeIntention("pickup", { x: target.x, y: target.y }, now, target.id);
		} else if (explore) {
			candidate = makeIntention("explore", explore, now);
		}

		// Mark spawn as visited when we arrive at an explore target.
		if (
			intention?.kind === "explore" &&
			selfX === intention.targetXY.x &&
			selfY === intention.targetXY.y
		) {
			visitedSpawns.set(tileId(map, selfX, selfY), now);
		}

		const replanning = shouldReplan(
			intention,
			candidate,
			client.beliefs,
			map,
			bfs,
			selfX,
			selfY,
			now,
			movementDurationMs,
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
					`[intent] keep kind=${intention.kind} age=${Math.round((now - intention.committedAt) / movementDurationMs)}steps fails=${intention.moveFailStreak}`,
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
				`[wait] no step — carrying=${carrying} distToDelivery=${map.baseReverseDistToDelivery[selfId]} pos=(${selfX},${selfY})`,
			);
			await sleep(NO_STEP_WAIT_MS);
			continue;
		}

		const result = await client.move(step);
		if (result) {
			selfX = result.x;
			selfY = result.y;
			console.log(`[move] ${step} → ok@(${selfX},${selfY})`);
			if (intention) intention.moveFailStreak = 0;
		} else {
			console.log(`[move] ${step} → FAILED (wait ${movementDurationMs}ms)`);
			if (intention) intention.moveFailStreak++;
			await sleep(movementDurationMs);
		}
	}
}

loop().catch(console.error);
