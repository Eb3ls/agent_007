import { tileId, type StaticMap } from "./static_map.js";
import { INTENTION_UTILITY_EPSILON } from "./config.js";
import type { BfsFromSelf } from "./pathfinder.js";
import type { Intention } from "./intention.js";

export type IntentionCandidateSource =
	| "current"
	| "pickup"
	| "deliver"
	| "explore";

export type IntentionCandidate = {
	intention: Intention;
	source: IntentionCandidateSource;
};

export type IntentionRuleContext = {
	map: StaticMap;
	bfs: BfsFromSelf;
};

// Scores one candidate; "current" source uses viability check + retention bonus instead of utility scoring.
function evaluateCandidate(
	candidate: IntentionCandidate,
	context: IntentionRuleContext,
): { pass: boolean; score: number } {
	// Viability already confirmed by Gate 1 in main.ts; apply retention bonus to discourage thrash.
	if (candidate.source === "current") {
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

	// Score: higher is better. pickup/deliver use expectedUtility × 10 − distance; explore uses a fixed distance-only score.
	const utility = candidate.intention.expectedUtility;
	const score =
		candidate.intention.kind === "explore"
			? 5 - distance
			: utility * 10 - distance;

	return { pass: true, score };
}

// Returns the highest-scoring viable candidate, or null if none pass.
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
