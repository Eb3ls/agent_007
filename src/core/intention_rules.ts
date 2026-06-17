import { tileId, type StaticMap } from "../static_map.js";
import type { BfsFromSelf } from "../pathfinder.js";
import type { Intention } from "./intention.js";
import { cfg } from "../config.js";

export type IntentionCandidateSource =
	| "current"
	| "pickup"
	| "deliver"
	| "explore"
	| "batch"
	| "goto";

export type IntentionCandidate = {
	intention: Intention;
	source: IntentionCandidateSource;
	utility: number;
	detail?: string; // human label for decision logs, e.g. "batch→2×10"
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
// Hysteresis (anti-thrash): a value-based alternative must beat the current
// intention by switch_margin_fraction (relative) before switching; two explore
// targets compare on a distance margin; mixed value/explore switches freely.
export function selectBestIntention(
	context: IntentionRuleContext,
	candidates: IntentionCandidate[],
): IntentionCandidate | null {
	if (candidates.length === 0) return null;

	let best: IntentionCandidate | null = null;
	let bestScore = -Infinity;
	let current: IntentionCandidate | null = null;
	let currentScore = -Infinity;

	for (const candidate of candidates) {
		const result = evaluateCandidate(candidate, context);
		if (!result.pass) continue;
		if (candidate.source === "current") {
			current = candidate;
			currentScore = result.score;
		}
		if (result.score > bestScore) {
			best = candidate;
			bestScore = result.score;
		}
	}

	if (!best) return null;
	if (!current || best.source === "current") return best;

	const currentIsExplore = current.intention.kind === "explore";
	const bestIsExplore = best.intention.kind === "explore";

	// Both explore: scores are -distance, so a relative margin is meaningless.
	// Hold the committed target unless the fresh one is meaningfully nearer.
	if (currentIsExplore && bestIsExplore)
		return bestScore > currentScore + cfg.explore.switch_distance_margin
			? best
			: current;

	// Both value-based: relative margin scales the threshold with reward.
	if (!currentIsExplore && !bestIsExplore)
		return bestScore >
			currentScore * (1 + cfg.intention.switch_margin_fraction)
			? best
			: current;

	// Mixed (value vs explore): no comparable margin — take the argmax winner.
	return best;
}

export function intentSig(intention: Intention | null): string {
	return intention
		? `${intention.kind}:(${intention.targetXY.x},${intention.targetXY.y})`
		: "idle";
}
