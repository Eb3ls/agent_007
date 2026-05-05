import { tileId, type StaticMap } from "./static_map.js";
import { INTENTION_SWITCH_MARGIN_FRACTION } from "./config.js";
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
// Hysteresis: a new candidate must exceed the current intention's score by
// INTENTION_SWITCH_MARGIN_FRACTION to prevent flicker between near-equal options.
export function selectBestIntention(
	context: IntentionRuleContext,
	candidates: IntentionCandidate[],
): IntentionCandidate | null {
	if (candidates.length === 0) return null;

	// Pure argmax over all viable candidates.
	let best: IntentionCandidate | null = null;
	let bestScore = -Infinity;
	let currentScore = -Infinity;

	for (const candidate of candidates) {
		const result = evaluateCandidate(candidate, context);
		if (!result.pass) continue;
		if (candidate.source === "current") currentScore = result.score;
		if (result.score > bestScore) {
			best = candidate;
			bestScore = result.score;
		}
	}

	if (!best) return null;

	// If the current intention is viable, require the new best to exceed it by
	// the hysteresis margin before switching.
	if (currentScore > -Infinity && best.source !== "current") {
		const switchThreshold = currentScore * (1 + INTENTION_SWITCH_MARGIN_FRACTION);
		if (bestScore <= switchThreshold) {
			return candidates.find((c) => c.source === "current")!;
		}
	}

	return best;
}
