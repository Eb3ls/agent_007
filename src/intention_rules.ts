import { tileId, type StaticMap } from "./static_map.js";
import { INTENTION_UTILITY_EPSILON } from "./config.js";
import type { BfsFromSelf } from "./pathfinder.js";
import type { Intention } from "./intention.js";

export type IntentionCandidateSource = "current" | "pickup" | "deliver" | "explore";

export type IntentionCandidate = {
	intention: Intention;
	source: IntentionCandidateSource;
	utility: number;
};

export type IntentionRuleContext = {
	map: StaticMap;
	bfs: BfsFromSelf;
};

function evaluateCandidate(
	candidate: IntentionCandidate,
	context: IntentionRuleContext,
): { pass: boolean; score: number } {
	const targetTileId = tileId(
		context.map,
		candidate.intention.targetXY.x,
		candidate.intention.targetXY.y,
	);
	const distance = context.bfs.dist[targetTileId];
	if (distance === undefined || distance === -1) {
		return { pass: false, score: 0 };
	}

	// Explore is a fallback — prefer nearer spawns. pickup/deliver score = absolute utility (decay-adjusted, distance already inside).
	const score =
		candidate.intention.kind === "explore" ? -distance : candidate.utility;

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
