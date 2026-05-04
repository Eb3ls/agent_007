import {
	INTENTION_MAX_AGE_STEPS,
	INTENTION_UTILITY_EPSILON,
	MAX_MOVE_FAIL_STREAK,
} from "./config.js";
import type { BfsFromSelf, Direction } from "./pathfinder.js";
import { tileId, type StaticMap } from "./static_map.js";
import type { BeliefStore } from "./belief_store.js";

export type Intention = {
	kind: "deliver" | "pickup" | "detour" | "explore";
	targetId?: string;
	targetXY: { x: number; y: number };
	expectedUtility: number;
	committedAt: number;
	moveFailStreak: number;
	progress: IntentionProgress;
	plan: Direction[];
};

export type IntentionProgress = {
	startedAt: number;
	lastCheckedAt: number;
	stepsTaken: number;
	lastDistance: number | null;
	lastProgressAt: number;
	failuresSinceProgress: number;
};

export function createIntentionProgress(now: number): IntentionProgress {
	return {
		startedAt: now,
		lastCheckedAt: now,
		stepsTaken: 0,
		lastDistance: null,
		lastProgressAt: now,
		failuresSinceProgress: 0,
	};
}

export function makeIntention(
	kind: Intention["kind"],
	targetXY: { x: number; y: number },
	now: number,
	utility: number = 0,
	targetId?: string,
): Intention {
	const base = {
		kind,
		targetXY,
		expectedUtility: utility,
		committedAt: now,
		moveFailStreak: 0,
		progress: createIntentionProgress(now),
		plan: [] as Direction[],
	};
	return targetId !== undefined ? { ...base, targetId } : base;
}

// Intention filter: returns false if the current intention has become invalid.
// Call this before deliberation to skip re-planning when the intention is still good.
export function isIntentionStillValid(
	intention: Intention,
	beliefs: BeliefStore,
	map: StaticMap,
	bfs: BfsFromSelf,
	selfX: number,
	selfY: number,
	now: number,
	movementDurationMs: number,
): boolean {
	if (selfX === intention.targetXY.x && selfY === intention.targetXY.y)
		return false;
	const ageSteps = (now - intention.committedAt) / movementDurationMs;
	if (ageSteps >= INTENTION_MAX_AGE_STEPS) return false;
	if (intention.moveFailStreak >= MAX_MOVE_FAIL_STREAK) return false;
	const targetTileId = tileId(
		map,
		intention.targetXY.x,
		intention.targetXY.y,
	);
	if (bfs.dist[targetTileId] === -1) return false;
	if (
		(intention.kind === "pickup" || intention.kind === "detour") &&
		intention.targetId
	) {
		const parcel = beliefs.parcels.get(intention.targetId);
		if (!parcel || parcel.carriedBy) return false;
	}
	return true;
}

// Intention selection: returns true when a better candidate should replace current.
export function shouldSwitch(
	current: Intention | null,
	candidate: Intention | null,
): boolean {
	if (!current) return true;
	if (!candidate) return false;
	return (
		candidate.expectedUtility >
		current.expectedUtility + INTENTION_UTILITY_EPSILON
	);
}
