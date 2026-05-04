import { tileId, type StaticMap } from "./static_map.js";
import { INTENTION_UTILITY_EPSILON } from "./config.js";
import type { BeliefStore } from "./belief_store.js";
import { isIntentionViable } from "./reconsider.js";
import type { BfsFromSelf } from "./pathfinder.js";
import type { Intention } from "./intention.js";

export type IntentionCandidateSource =
	| "current"
	| "pickup"
	| "deliver"
	| "detour"
	| "explore";

export type IntentionCandidate = {
	intention: Intention;
	source: IntentionCandidateSource;
};

export type IntentionRuleContext = {
	myId: string;
	map: StaticMap;
	beliefs: BeliefStore;
	bfs: BfsFromSelf;
	selfX: number;
	selfY: number;
	now: number;
	movementDurationMs: number;
	carry: { n: number; nearestDeliveryDist: number };
};

/**
 * Evaluate a single candidate intention.
 * Returns { pass: false } if the candidate is invalid or incompatible.
 * Returns { pass: true, score } if the candidate is valid; higher score is better.
 */
function evaluateCandidate(
	candidate: IntentionCandidate,
	context: IntentionRuleContext,
): { pass: boolean; score: number } {
	// Current intention gets a small bonus for retention
	if (candidate.source === "current") {
		const viable = isIntentionViable(
			context.myId,
			candidate.intention,
			context.beliefs,
			context.map,
			context.bfs,
			context.selfX,
			context.selfY,
			context.now,
			context.movementDurationMs,
		);
		if (!viable) return { pass: false, score: 0 };
		return { pass: true, score: INTENTION_UTILITY_EPSILON / 2 };
	}

	// Check: is target reachable?
	const targetTileId = tileId(
		context.map,
		candidate.intention.targetXY.x,
		candidate.intention.targetXY.y,
	);
	const distance = context.bfs.dist[targetTileId];
	if (distance === undefined || distance === -1) {
		return { pass: false, score: 0 }; // target not reachable
	}

	// Check: is this action compatible with current carry state?
	const carrying = context.carry.n > 0;
	if (carrying) {
		// Can only do deliver or detour when carrying
		if (
			candidate.intention.kind === "pickup" ||
			candidate.intention.kind === "explore"
		) {
			return { pass: false, score: 0 };
		}
	} else {
		// Can only do pickup or explore when empty
		if (
			candidate.intention.kind === "deliver" ||
			candidate.intention.kind === "detour"
		) {
			return { pass: false, score: 0 };
		}
	}

	// Score: higher is better. Lower distance is better, higher utility is better.
	const utility = candidate.intention.expectedUtility;
	let score = 0;

	switch (candidate.intention.kind) {
		case "pickup":
			score = utility * 10 - distance;
			break;

		case "deliver": {
			// Delivery is high priority; add urgency based on distance to nearest delivery
			const urgency = Math.max(0, 10 - context.carry.nearestDeliveryDist);
			score = 100 + urgency * 5 - distance;
			break;
		}

		case "detour": {
			// Detour priority increases when delivery is getting urgent
			const deliveryPressure = Math.max(
				0,
				6 - context.carry.nearestDeliveryDist,
			);
			score = utility * 10 - distance - deliveryPressure * 3;
			break;
		}

		case "explore":
			score = 5 - distance;
			break;
	}

	return { pass: true, score };
}

/**
 * Select the best intention from a list of candidates.
 * Returns the candidate with the highest score among those that pass evaluation.
 * Returns null if no candidate passes.
 */
export function selectBestIntention(
	context: IntentionRuleContext,
	candidates: IntentionCandidate[],
): IntentionCandidate | null {
	if (candidates.length === 0) return null;

	let best: IntentionCandidate | null = null;
	let bestScore = -Infinity;

	for (const candidate of candidates) {
		const result = evaluateCandidate(candidate, context);
		if (!result.pass) continue;
		if (result.score > bestScore + INTENTION_UTILITY_EPSILON) {
			best = candidate;
			bestScore = result.score;
		}
	}

	return best;
}
