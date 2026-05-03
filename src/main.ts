import {
	CAPACITY_OVERRIDE,
	FALLBACK_MOVEMENT_DURATION_MS,
	FALLBACK_OBSERVATION_DISTANCE,
	NO_STEP_WAIT_MS,
	READY_POLL_MS,
	parseDecayInterval,
} from "./config.js";
import {
	computeBlockedTiles,
	deriveCarryState,
	parcelHere,
	planStep,
	shouldDrop,
} from "./planner.js";
import { applyDelivery, applyPickupResult } from "./belief_store.js";
import { deliberate } from "./deliberation.js";
import type { Intention } from "./intention.js";
import { introspect } from "./introspection.js";
import { tileId } from "./static_map.js";
import { GameClient } from "./game_client.js";
import { bfsFromSelf } from "./pathfinder.js";
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
			console.log(
				`[intent] commit kind=${intention!.kind} age=${Math.round((now - intention!.committedAt) / movementDurationMs)}steps fails=${intention!.moveFailStreak}`,
			);
		} else {
			intention = deliberation.intention;
			if (intention)
				console.log(
					`[intent] replan kind=${intention.kind} target=${JSON.stringify(intention.targetXY)}`,
				);
		}

		const commitTarget = intention?.targetXY ?? null;
		const step = planStep(
			map,
			bfs,
			carrying,
			deliberation.targetResult,
			deliberation.detourResult,
			deliberation.explore,
			commitTarget,
		);

		if (!step) {
			stuckIterations++;
			console.log(
				`[wait] no step — carrying=${carrying} distToDelivery=${map.baseReverseDistToDelivery[selfId]} pos=(${selfX},${selfY}) intention=${intention ? intention.kind : "null"} targetResult=${deliberation.targetResult ? "yes" : "no"} explore=${deliberation.explore ? `(${deliberation.explore.x},${deliberation.explore.y})` : "no"} stuck=${stuckIterations}`,
			);
			
			// If stuck for too long with no viable action, reset spawn tracking to force re-exploration
			if (stuckIterations >= 5) {
				console.log(`[stuck] resetting spawn tracking after ${stuckIterations} iterations`);
				observedEmptySpawns.clear();
				stuckIterations = 0;
			}
			
			// Detect stall: if we have an intention but can't plan a step, 
			// it's blocked and should be reconsidered
			if (intention) {
				intention.moveFailStreak++;
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
				if (feedback.shouldReconsider) {
					console.log(
						`[intent] reconsider kind=${intention.kind} action=${feedback.recoveryAction ?? "drop"} reason=${feedback.failure?.reason ?? "no_step_available"} fails=${intention.moveFailStreak}`,
					);
					if (feedback.recoveryAction !== "retry") intention = null;
				}
			}
			
			await sleep(NO_STEP_WAIT_MS);
			continue;
		}

		stuckIterations = 0; // reset counter when we successfully plan a step

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
			console.log(`[move] ${step} → ok@(${selfX},${selfY})`);
			if (intention) intention.moveFailStreak = 0;
			if (feedback.progressed) {
				console.log(
					`[introspect] progress kind=${intention!.kind} distance=${feedback.distanceToTarget ?? "n/a"} prev=${feedback.previousDistanceToTarget ?? "n/a"}`,
				);
			} else if (feedback.stalled) {
				console.log(
					`[introspect] stalled kind=${intention!.kind} distance=${feedback.distanceToTarget ?? "n/a"} prev=${feedback.previousDistanceToTarget ?? "n/a"}`,
				);
			}
			if (feedback.shouldReconsider) {
				console.log(
					`[intent] reconsider kind=${intention!.kind} action=${feedback.recoveryAction ?? "drop"} reason=${feedback.failure?.reason ?? (feedback.reachedTarget ? "reached" : feedback.failed ? "failed" : "stalled")}`,
				);
				if (feedback.recoveryAction !== "retry") intention = null;
			}
		} else {
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
			console.log(
				`[move] ${step} → FAILED (wait ${movementDurationMs}ms)`,
			);
			if (intention) intention.moveFailStreak++;
			if (feedback.failed) {
				console.log(
					`[introspect] failure kind=${intention!.kind} fails=${intention!.moveFailStreak}`,
				);
			}
			if (feedback.shouldReconsider) {
				console.log(
					`[intent] reconsider kind=${intention!.kind} action=${feedback.recoveryAction ?? "drop"} reason=${feedback.failure?.reason ?? (feedback.reachedTarget ? "reached" : feedback.failed ? "failed" : "stalled")}`,
				);
				if (feedback.recoveryAction !== "retry") intention = null;
			}
			await sleep(movementDurationMs);
		}
	}
}

loop().catch(console.error);
