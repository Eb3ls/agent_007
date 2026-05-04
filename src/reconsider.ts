import {
	INTENTION_MAX_AGE_STEPS,
	MAX_MOVE_FAIL_STREAK,
	PARCEL_BELIEF_STALE_STEPS,
} from "./config.js";
import { tileId, type StaticMap } from "./static_map.js";
import type { BeliefStore } from "./belief_store.js";
import type { BfsFromSelf } from "./pathfinder.js";
import type { Intention } from "./intention.js";

export type TerminalReason =
	| "succeeded" // target reached with expected outcome
	| "target_lost" // parcel gone, stolen, or belief stale
	| "unreachable" // no path to target in current BFS
	| "move_blocked" // moveFailStreak >= MAX_MOVE_FAIL_STREAK
	| "aged"; // intention exceeded INTENTION_MAX_AGE_STEPS

export type ViabilityCheck =
	| { viable: true }
	| { viable: false; reason: TerminalReason };

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

// Gate function — returns why an intention is no longer viable, or viable=true.
// Safe to call multiple times per tick (no side-effects).
export function checkIntentionViability(
	myId: string,
	intention: Intention,
	beliefs: BeliefStore,
	map: StaticMap,
	bfs: BfsFromSelf,
	selfX: number,
	selfY: number,
	now: number,
	movementDurationMs: number,
): ViabilityCheck {
	// 1) Target reached — distinguish succeeded from target_lost for pickup/detour
	if (selfX === intention.targetXY.x && selfY === intention.targetXY.y) {
		if (intention.kind === "pickup" || intention.kind === "detour") {
			const parcel = intention.targetId
				? beliefs.parcels.get(intention.targetId)
				: undefined;
			if (parcel?.carriedBy === myId)
				return { viable: false, reason: "succeeded" };
			return { viable: false, reason: "target_lost" };
		}
		return { viable: false, reason: "succeeded" };
	}

	// 2) Parcel gone or belief stale while en route
	if (!checkTargetParcel(myId, intention, beliefs, now, movementDurationMs))
		return { viable: false, reason: "target_lost" };

	// 3) No path to target in current BFS
	if (computeTargetDistance(map, bfs, intention) === null)
		return { viable: false, reason: "unreachable" };

	// 4) Too many consecutive move failures
	if (intention.moveFailStreak >= MAX_MOVE_FAIL_STREAK)
		return { viable: false, reason: "move_blocked" };

	// 5) Intention timed out
	const ageSteps = (now - intention.committedAt) / movementDurationMs;
	if (ageSteps >= INTENTION_MAX_AGE_STEPS)
		return { viable: false, reason: "aged" };

	return { viable: true };
}
