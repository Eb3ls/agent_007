import {
	CAPACITY_OVERRIDE,
	FALLBACK_MOVEMENT_DURATION_MS,
	FALLBACK_OBSERVATION_DISTANCE,
	NO_STEP_WAIT_MS,
	READY_POLL_MS,
	parseDecayInterval,
} from "./config.js";
import {
	buildPlan,
	computeBlockedTiles,
	deriveCarryState,
	isSoundPlan,
	parcelHere,
	shouldDrop,
} from "./planner.js";
import { applyDelivery, applyPickupResult } from "./belief_store.js";
import { introspect } from "./introspection.js";
import type { Intention } from "./intention.js";
import { deliberate } from "./deliberation.js";
import { GameClient } from "./game_client.js";
import { bfsFromSelf } from "./pathfinder.js";
import { tileId } from "./static_map.js";
import { log } from "./logger.js";
import dotenv from "dotenv";

dotenv.config();

const host = process.env.DELIVEROO_HOST;
const token = process.env.DELIVEROO_TOKEN;

if (!host || !token) {
	log.error("main", "Missing DELIVEROO_HOST or DELIVEROO_TOKEN");
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
	log.info(
		"map",
		`tiles=${map.tiles.size} delivery_zones=${map.deliveryTileIds.length}`,
	);
	log.info("main", `starting loop at (${selfX},${selfY})`);

	const decayIntervalMs = parseDecayInterval(
		client.config?.GAME.parcels.decaying_event,
	);
	const movementDurationMs =
		client.config?.GAME.player.movement_duration ??
		FALLBACK_MOVEMENT_DURATION_MS;
	const observationDistance =
		client.config?.GAME.player.observation_distance ??
		FALLBACK_OBSERVATION_DISTANCE;
	const capacity = CAPACITY_OVERRIDE;

	let intention: Intention | null = null;
	const observedEmptySpawns = new Map<number, number>(); // tileId → visitedAt ms
	let stuckIterations = 0; // count of iterations with no step

	while (true) {
		const selfId = tileId(map, selfX, selfY);
		const blocked = computeBlockedTiles(
			map,
			client.beliefs,
			movementDurationMs,
		);
		// dist to every tile
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
			log.ok("deliver", `putdown=${dropped.length} cleared=${carry.n}`);
			continue;
		}

		const parcelAtFeet = parcelHere(client.beliefs.parcels, selfX, selfY);
		if (parcelAtFeet) {
			const picked = await client.pickup();
			applyPickupResult(client.beliefs, picked, myId);
			log.ok("pickup", `picked=${picked.length}`);
			continue;
		}

		const now = Date.now();
		const deliberation = deliberate({
			myId,
			map,
			beliefs: client.beliefs,
			bfs,
			selfX,
			selfY,
			now,
			movementDurationMs,
			observationDistance,
			capacity,
			decayIntervalMs,
			carry,
			intention,
			observedEmptySpawns,
		});

		if (!deliberation.replanned && intention) {
			log.debug(
				"intent",
				`commit kind=${intention.kind} age=${Math.round((now - intention.committedAt) / movementDurationMs)}steps fails=${intention.moveFailStreak}`,
			);
		} else {
			intention = deliberation.intention;
			if (intention)
				log.warn(
					"intent",
					`replan kind=${intention.kind} target=(${intention.targetXY.x},${intention.targetXY.y}) plan=${intention.plan.length}steps`,
				);
		}

		// Sound check: plan empty or next step blocked → rebuild (keep intention)
		if (
			intention &&
			!isSoundPlan(intention.plan, selfX, selfY, map, blocked)
		) {
			intention.plan = buildPlan(
				map,
				bfs,
				intention.targetXY.x,
				intention.targetXY.y,
			);
			if (intention.plan.length === 0) {
				log.error(
					"plan",
					`target unreachable kind=${intention.kind}, clearing`,
				);
				intention = null;
			}
		}

		if (!intention) {
			if (stuckIterations === 0)
				log.warn(
					"wait",
					`no intention — carrying=${carrying} pos=(${selfX},${selfY})`,
				);
			stuckIterations++;
			if (stuckIterations >= 5) {
				log.warn(
					"stuck",
					`resetting spawn tracking after ${stuckIterations} iterations`,
				);
				observedEmptySpawns.clear();
				stuckIterations = 0;
			}
			await sleep(NO_STEP_WAIT_MS);
			continue;
		}

		stuckIterations = 0;
		const step = intention.plan.shift()!;
		log.debug(
			"plan",
			`step=${step} remaining=${intention.plan.length} kind=${intention.kind}`,
		);

		const result = await client.move(step);
		if (result) {
			selfX = result.x;
			selfY = result.y;
			const postMoveBfs = bfsFromSelf(map, selfX, selfY, blocked);
			const feedback = introspect({
				myId,
				intention,
				beliefs: client.beliefs,
				map,
				bfs: postMoveBfs,
				selfX,
				selfY,
				now: Date.now(),
				movementDurationMs,
				moveSucceeded: true,
			});
			log.ok("move", `${step} → (${selfX},${selfY})`);
			intention.moveFailStreak = 0;
			if (feedback.stalled)
				log.warn(
					"introspect",
					`stalled kind=${intention.kind} dist=${feedback.distanceToTarget ?? "n/a"}`,
				);
			if (feedback.shouldReconsider) {
				const reason =
					feedback.failure?.reason ??
					(feedback.reachedTarget
						? "reached"
						: feedback.failed
							? "failed"
							: "stalled");
				log.warn(
					"intent",
					`reconsider kind=${intention.kind} reason=${reason} action=${feedback.recoveryAction ?? "drop"}`,
				);
				if (feedback.recoveryAction !== "retry") intention = null;
				else intention.plan = []; // retry: rebuild plan next tick
			}
		} else {
			if (intention) {
				intention.moveFailStreak++;
				intention.plan = []; // force plan rebuild next tick
			}
			const feedback = introspect({
				myId,
				intention,
				beliefs: client.beliefs,
				map,
				bfs,
				selfX,
				selfY,
				now: Date.now(),
				movementDurationMs,
				moveSucceeded: false,
			});
			log.error(
				"move",
				`${step} → FAILED fails=${intention?.moveFailStreak ?? 0}`,
			);
			if (feedback.shouldReconsider) {
				const reason =
					feedback.failure?.reason ??
					(feedback.reachedTarget
						? "reached"
						: feedback.failed
							? "failed"
							: "stalled");
				log.warn(
					"intent",
					`reconsider kind=${intention!.kind} reason=${reason} action=${feedback.recoveryAction ?? "drop"}`,
				);
				if (feedback.recoveryAction !== "retry") intention = null;
				// else: plan already cleared, rebuild next tick
			}
			await sleep(movementDurationMs);
		}
	}
}

loop().catch(console.error);
