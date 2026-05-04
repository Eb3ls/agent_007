import {
	buildPlan,
	nearestDeliveryTile,
	nearestOutOfViewSpawn,
	pickBestDetourTarget,
	pickBestParcelTarget,
} from "./planner.js";
import {
	selectBestIntention,
	type IntentionCandidate,
	type IntentionRuleContext,
} from "./intention_rules.js";
import {
	DETOUR_UTILITY_EPSILON,
	EXPECTED_STEAL_HORIZON_STEPS,
	SPAWN_VISITED_TTL_STEPS,
} from "./config.js";
import {
	type Intention,
	isIntentionStillValid,
	makeIntention,
} from "./intention.js";
import { tileId, type StaticMap } from "./static_map.js";
import type { BeliefStore } from "./belief_store.js";
import type { BfsFromSelf } from "./pathfinder.js";

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
	carry: {
		n: number;
		rewards: number[];
		nearestDeliveryDist: number;
		ids: string[];
	};
	intention: Intention | null;
	observedEmptySpawns: Map<number, number>;
};

export type DeliberationOutcome = {
	replanned: boolean;
	intention: Intention | null;
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

function markExploreArrival(context: DeliberationContext): void {
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

	// Compute delivery target once (always available when carrying)
	const delivery =
		context.carry.n > 0
			? nearestDeliveryTile(context.map, context.bfs)
			: null;

	// Build candidates and let rules engine pick the best one
	const candidates: IntentionCandidate[] = [];

	// Add current intention (if still valid) as a candidate for retention
	if (context.intention) {
		candidates.push({
			intention: context.intention,
			source: "current",
		});
	}

	// Add available actions based on carry state
	if (context.carry.n > 0) {
		// When carrying: detour and deliver are options
		if (detourResult) {
			candidates.push({
				intention: makeIntention(
					"detour",
					{ x: detourResult.parcel.x, y: detourResult.parcel.y },
					context.now,
					detourResult.utility,
					detourResult.parcel.id,
				),
				source: "detour",
			});
		}
		if (delivery) {
			candidates.push({
				intention: makeIntention("deliver", delivery, context.now),
				source: "deliver",
			});
		}
	} else {
		// When empty: pickup and explore are options
		if (targetResult) {
			candidates.push({
				intention: makeIntention(
					"pickup",
					{ x: targetResult.parcel.x, y: targetResult.parcel.y },
					context.now,
					targetResult.utility,
					targetResult.parcel.id,
				),
				source: "pickup",
			});
		}
		if (explore) {
			candidates.push({
				intention: makeIntention("explore", explore, context.now),
				source: "explore",
			});
		}
	}

	// Evaluate candidates using rules and pick the best
	const ruleContext: IntentionRuleContext = {
		map: context.map,
		beliefs: context.beliefs,
		bfs: context.bfs,
		selfX: context.selfX,
		selfY: context.selfY,
		now: context.now,
		movementDurationMs: context.movementDurationMs,
		carry: {
			n: context.carry.n,
			nearestDeliveryDist: context.carry.nearestDeliveryDist,
		},
	};

	const selectedCandidate = selectBestIntention(ruleContext, candidates);
	const candidate = selectedCandidate?.intention ?? null;

	let newIntention: Intention | null = null;
	if (candidate) {
		const plan = buildPlan(
			context.map,
			context.bfs,
			candidate.targetXY.x,
			candidate.targetXY.y,
		);
		newIntention = {
			...candidate,
			committedAt: context.now,
			moveFailStreak: 0,
			plan,
		};
	}

	return {
		replanned: true,
		intention: newIntention,
	};
}
