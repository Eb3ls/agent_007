import {
	buildPlan,
	computeDecayPerStep,
	computeDeliverUtility,
	nearestDeliveryTile,
	nearestOutOfViewSpawn,
	pickBestParcelTarget,
	type CarryState,
} from "./planner.js";
import {
	selectBestIntention,
	type IntentionCandidate,
	type IntentionRuleContext,
} from "./intention_rules.js";
import { type Intention, makeIntention } from "./intention.js";
import { computeCurrentIntentionUtility } from "./reconsider.js";
import { SPAWN_OBSERVED_TTL_STEPS } from "./config.js";
import type { BeliefStore } from "./belief_store.js";
import type { BfsFromSelf } from "./pathfinder.js";
import { type StaticMap } from "./static_map.js";

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
	decayIntervalMs: number;
	carry: CarryState;
	intention: Intention | null;
};

// Returns spawn IDs observed empty within SPAWN_OBSERVED_TTL_STEPS — older entries expire and become re-explorable.
function freshObservedEmptySpawns(
	beliefs: BeliefStore,
	now: number,
	movementDurationMs: number,
): Set<number> {
	const spawnTtlMs = SPAWN_OBSERVED_TTL_STEPS * movementDurationMs;
	const fresh = new Set<number>();
	for (const [id, seenAt] of beliefs.observedEmptySpawns) {
		if (now - seenAt < spawnTtlMs) fresh.add(id);
	}
	return fresh;
}

// Pure option + filter + plan: generates candidates, selects best, builds plan.
// Does NOT check viability or reconsider — caller is responsible for those gates.
// If current intention is provided it is included as a candidate (retention bias).
// Returns null if no viable candidate or no path found.
export function deliberate(context: DeliberationContext): Intention | null {
	// option: generate candidates based on carry state
	const candidates: IntentionCandidate[] = [];

	if (context.intention) {
		candidates.push({
			intention: context.intention,
			source: "current",
			utility: computeCurrentIntentionUtility(
				context.intention,
				context.map,
				context.bfs,
				context.beliefs,
				context.carry,
				context.decayIntervalMs,
				context.movementDurationMs,
			),
		});
	}

	if (context.carry.n > 0) {
		const decayPerStep = computeDecayPerStep(
			context.decayIntervalMs,
			context.movementDurationMs,
		);
		const deliverUtility = computeDeliverUtility(
			context.carry.rewards,
			decayPerStep,
			context.carry.nearestDeliveryDist,
		);

		const delivery = nearestDeliveryTile(context.map, context.bfs);
		if (delivery) {
			candidates.push({
				intention: makeIntention("deliver", delivery, context.now),
				source: "deliver",
				utility: deliverUtility,
			});
		}

		const pickupResult = pickBestParcelTarget(
			context.map,
			context.bfs,
			context.beliefs,
			context.decayIntervalMs,
			context.movementDurationMs,
			context.carry,
		);
		if (pickupResult) {
			candidates.push({
				intention: makeIntention(
					"pickup",
					{ x: pickupResult.parcel.x, y: pickupResult.parcel.y },
					context.now,
					pickupResult.parcel.id,
				),
				source: "pickup",
				utility: pickupResult.utility,
			});
		}
	} else {
		const targetResult = pickBestParcelTarget(
			context.map,
			context.bfs,
			context.beliefs,
			context.decayIntervalMs,
			context.movementDurationMs,
			context.carry,
		);
		const explore = !targetResult
			? nearestOutOfViewSpawn(
					context.map,
					context.bfs,
					context.selfX,
					context.selfY,
					context.observationDistance,
					freshObservedEmptySpawns(
						context.beliefs,
						context.now,
						context.movementDurationMs,
					),
					context.beliefs,
					context.now,
					context.movementDurationMs,
				)
			: null;
		if (targetResult) {
			candidates.push({
				intention: makeIntention(
					"pickup",
					{ x: targetResult.parcel.x, y: targetResult.parcel.y },
					context.now,
					targetResult.parcel.id,
				),
				source: "pickup",
				utility: targetResult.utility,
			});
		}
		if (explore) {
			candidates.push({
				intention: makeIntention("explore", explore, context.now),
				source: "explore",
				utility: 0,
			});
		}
	}

	// filter: pick best candidate
	const ruleContext: IntentionRuleContext = {
		map: context.map,
		bfs: context.bfs,
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

	if (selected.source === "current") {
		return { ...context.intention!, plan };
	}
	return {
		...selected.intention,
		committedAt: context.now,
		moveFailStreak: 0,
		plan,
	};
}
