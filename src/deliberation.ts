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
import { type Intention, makeIntention } from "./intention.js";
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

// Pure option + filter + plan: generates candidates, selects best, builds plan.
// Does NOT check viability or reconsider — caller is responsible for those gates.
// If current intention is provided it is included as a candidate (retention bias).
// Returns null if no viable candidate or no path found.
export function deliberate(context: DeliberationContext): Intention | null {
	markExploreArrival(context);

	// option: generate candidates based on carry state
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
	const delivery =
		context.carry.n > 0
			? nearestDeliveryTile(context.map, context.bfs)
			: null;

	// build candidate list
	const candidates: IntentionCandidate[] = [];

	if (context.intention) {
		candidates.push({ intention: context.intention, source: "current" });
	}

	if (context.carry.n > 0) {
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

	// filter: pick best candidate
	const ruleContext: IntentionRuleContext = {
		myId: context.myId,
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

	const selected = selectBestIntention(ruleContext, candidates);
	if (!selected) return null;

	// plan: build path for selected intention
	const plan = buildPlan(
		context.map,
		context.bfs,
		selected.intention.targetXY.x,
		selected.intention.targetXY.y,
	);
	if (plan.length === 0) return null;

	// Preserve original intention fields (moveFailStreak, committedAt) when keeping current
	if (selected.source === "current") {
		return { ...context.intention!, plan };
	}
	return { ...selected.intention, committedAt: context.now, moveFailStreak: 0, plan };
}
