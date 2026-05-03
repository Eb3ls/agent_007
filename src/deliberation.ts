import {
	DETOUR_UTILITY_EPSILON,
	EXPECTED_STEAL_HORIZON_STEPS,
	SPAWN_VISITED_TTL_STEPS,
} from "./config.js";
import type { BeliefStore } from "./belief_store.js";
import {
	type Intention,
	isIntentionStillValid,
	makeIntention,
} from "./intention.js";
import type { PickResult } from "./planner.js";
import {
	nearestDeliveryTile,
	nearestOutOfViewSpawn,
	pickBestDetourTarget,
	pickBestParcelTarget,
} from "./planner.js";
import type { BfsFromSelf } from "./pathfinder.js";
import { tileId, type StaticMap } from "./static_map.js";

export type DeliberationContext = {
	myId: string;
	map: StaticMap;
	beliefs: BeliefStore;
	bfs: BfsFromSelf;
	selfX: number;
	selfY: number;
	now: number;
	movementDurationMs: number;
	observationDistance: number;
	capacity: number;
	decayIntervalMs: number;
	carry: { n: number; rewards: number[]; nearestDeliveryDist: number; ids: string[] };
	intention: Intention | null;
	observedEmptySpawns: Map<number, number>;
};

export type DeliberationOutcome = {
	replanned: boolean;
	intention: Intention | null;
	targetResult: PickResult | null;
	detourResult: PickResult | null;
	explore: { x: number; y: number } | null;
};

function freshVisitedSpawns(
	observedEmptySpawns: Map<number, number>,
	now: number,
	movementDurationMs: number,
): Set<number> {
	const spawnTtlMs = SPAWN_VISITED_TTL_STEPS * movementDurationMs;
	const freshVisited = new Set<number>();
	for (const [id, visitedAt] of observedEmptySpawns) {
		if (now - visitedAt < spawnTtlMs) freshVisited.add(id);
	}
	return freshVisited;
}

function markExploreArrival(
	context: DeliberationContext,
): void {
	if (
		context.intention?.kind === "explore" &&
		context.selfX === context.intention.targetXY.x &&
		context.selfY === context.intention.targetXY.y
	) {
		context.observedEmptySpawns.set(
			tileId(context.map, context.selfX, context.selfY),
			context.now,
		);
	}
}

export function deliberate(context: DeliberationContext): DeliberationOutcome {
	markExploreArrival(context);

	const needsDeliberation =
		!context.intention ||
		!isIntentionStillValid(
			context.intention,
			context.beliefs,
			context.map,
			context.bfs,
			context.selfX,
			context.selfY,
			context.now,
			context.movementDurationMs,
		);

	if (!needsDeliberation) {
		return {
			replanned: false,
			intention: context.intention,
			targetResult: null,
			detourResult: null,
			explore: null,
		};
	}

	const targetResult =
		context.carry.n > 0
			? null
			: pickBestParcelTarget(
					context.map,
					context.bfs,
					context.beliefs,
					context.decayIntervalMs,
					context.movementDurationMs,
				);
	const detourResult =
		context.carry.n > 0
			? pickBestDetourTarget(
					context.map,
					context.bfs,
					context.beliefs,
					context.carry,
					context.decayIntervalMs,
					context.movementDurationMs,
					EXPECTED_STEAL_HORIZON_STEPS,
					context.capacity,
					DETOUR_UTILITY_EPSILON,
				)
			: null;
	const explore =
		!context.carry.n && !targetResult
			? nearestOutOfViewSpawn(
					context.map,
					context.bfs,
					context.selfX,
					context.selfY,
					context.observationDistance,
					freshVisitedSpawns(
						context.observedEmptySpawns,
						context.now,
						context.movementDurationMs,
					),
				)
			: null;

	let candidate: Intention | null = null;
	if (context.carry.n > 0 && detourResult) {
		candidate = makeIntention(
			"detour",
			{ x: detourResult.parcel.x, y: detourResult.parcel.y },
			context.now,
			detourResult.utility,
			detourResult.parcel.id,
		);
	} else if (context.carry.n > 0) {
		const deliveryXY = nearestDeliveryTile(context.map, context.bfs);
		if (deliveryXY) candidate = makeIntention("deliver", deliveryXY, context.now);
	} else if (targetResult) {
		candidate = makeIntention(
			"pickup",
			{ x: targetResult.parcel.x, y: targetResult.parcel.y },
			context.now,
			targetResult.utility,
			targetResult.parcel.id,
		);
	} else if (explore) {
		candidate = makeIntention("explore", explore, context.now);
	}

	return {
		replanned: true,
		intention: candidate ? { ...candidate, committedAt: context.now, moveFailStreak: 0 } : null,
		targetResult,
		detourResult,
		explore,
	};
}