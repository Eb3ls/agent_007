import {
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
import {
	applyDelivery,
	applyPickupResult,
	topCompetitorTiles,
} from "./belief_store.js";
import { checkIntentionViability, shouldReconsider } from "./reconsider.js";
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
	let intention: Intention | null = null;
	let stuckIterations = 0; // count of iterations with no step
	let loopCount = 0;

	while (true) {
		loopCount++;
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

		// Gate 1: viability — succeeded / impossible / aged / unreachable
		if (intention) {
			const viability = checkIntentionViability(
				myId,
				intention,
				client.beliefs,
				map,
				bfs,
				selfX,
				selfY,
				now,
				movementDurationMs,
			);
			if (!viability.viable) {
				log.warn(
					"intent",
					`terminal kind=${intention.kind} reason=${viability.reason}`,
				);
				intention = null;
			}
		}

		// Gate 2: sound — next step blocked or plan empty → rebuild plan, keep I
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
				log.warn(
					"intent",
					`sound-fail kind=${intention.kind} reason=unreachable`,
				);
				intention = null;
			}
		}

		// Gate 3 + initial deliberation: single call.
		// Pass current intention when reconsidering so it competes as candidate (retention bias).
		const reconsider =
			intention !== null &&
			shouldReconsider(
				intention,
				map,
				bfs,
				client.beliefs,
				carry,
				decayIntervalMs,
				movementDurationMs,
			);

		if (!intention || reconsider) {
			const prev = intention;
			intention = deliberate({
				myId,
				map,
				beliefs: client.beliefs,
				bfs,
				selfX,
				selfY,
				now,
				movementDurationMs,
				observationDistance,
				decayIntervalMs,
				carry,
				intention: reconsider ? intention : null,
			});
			if (intention) {
				const changed =
					!prev ||
					intention.kind !== prev.kind ||
					intention.targetXY.x !== prev.targetXY.x ||
					intention.targetXY.y !== prev.targetXY.y;
				if (changed)
					log.warn(
						"intent",
						`${reconsider && prev ? "reconsider→replan" : "new"} kind=${intention.kind} carrying=${carry.n > 0} target=(${intention.targetXY.x},${intention.targetXY.y}) plan=${intention.plan.length}steps`,
					);
			}
		}

		if (loopCount % 50 === 0) {
			const top = topCompetitorTiles(
				client.beliefs,
				5,
				now,
				movementDurationMs,
			);
			if (top.length > 0) {
				log.info(
					"memory",
					`competitor top5: ${top.map((t) => `(${t.x},${t.y})=${t.weight.toFixed(1)}`).join(" ")}`,
				);
			}
		}

		if (intention) {
			log.debug(
				"intent",
				`commit kind=${intention.kind} age=${Math.round((now - intention.committedAt) / movementDurationMs)}steps fails=${intention.moveFailStreak}`,
			);
		}

		if (!intention) {
			if (stuckIterations === 0)
				log.warn(
					"wait",
					`no intention — carrying=${carrying} pos=(${selfX},${selfY})`,
				);
			stuckIterations++;
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
			intention.moveFailStreak = 0;
			log.ok("move", `${step} → (${selfX},${selfY})`);
		} else {
			intention.moveFailStreak++;
			intention.plan = []; // force plan rebuild next tick
			log.error(
				"move",
				`${step} → FAILED fails=${intention.moveFailStreak}`,
			);
			await sleep(movementDurationMs);
		}
	}
}

loop().catch(console.error);
