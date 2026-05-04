import {
	INTENTION_MAX_AGE_STEPS,
	MAX_MOVE_FAIL_STREAK,
	PARCEL_BELIEF_STALE_STEPS,
} from "./config.js";
import { tileId, type StaticMap } from "./static_map.js";
import type { BeliefStore } from "./belief_store.js";
import type { BfsFromSelf } from "./pathfinder.js";
import type { Intention } from "./intention.js";

function computeTargetDistance(
	map: StaticMap,
	bfs: BfsFromSelf,
	intention: Intention,
): number | null {
	const id = tileId(map, intention.targetXY.x, intention.targetXY.y);
	const d = bfs.dist[id];
	return d === undefined || d === -1 ? null : d;
}

function checkTargetParcel(
	myId: string,
	intention: Intention,
	beliefs: BeliefStore,
	now: number,
	movementDurationMs: number,
): boolean {
	if (intention.kind !== "pickup" && intention.kind !== "detour") return true;
	if (!intention.targetId) return true;
	const parcel = beliefs.parcels.get(intention.targetId);
	if (!parcel) return false;
	if (parcel.carriedBy && parcel.carriedBy !== myId) return false;
	if (
		parcel.inView &&
		(parcel.x !== intention.targetXY.x || parcel.y !== intention.targetXY.y)
	)
		return false;
	if (
		!parcel.inView &&
		now - parcel.lastSeenAt > movementDurationMs * PARCEL_BELIEF_STALE_STEPS
	)
		return false;
	return true;
}

// Structural validity check — safe to call multiple times per tick, no side-effects.
// Returns false when the intention can no longer be pursued.
export function isIntentionViable(
	myId: string,
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
	if (!checkTargetParcel(myId, intention, beliefs, now, movementDurationMs))
		return false;
	if (computeTargetDistance(map, bfs, intention) === null) return false;
	if (intention.moveFailStreak >= MAX_MOVE_FAIL_STREAK) return false;
	const ageSteps = (now - intention.committedAt) / movementDurationMs;
	if (ageSteps >= INTENTION_MAX_AGE_STEPS) return false;
	return true;
}
