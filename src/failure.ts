import type { BeliefStore } from "./belief_store.js";
import type { Intention } from "./intention.js";
import type { BfsFromSelf } from "./pathfinder.js";
import { tileId, type StaticMap } from "./static_map.js";

export type FailureType = "target_lost" | "belief_stale" | "blocked";

export type FailureAssessment = {
	type: FailureType;
	reason: string;
	recoveryAction: "retry" | "drop";
	shouldReconsider: boolean;
};

export type FailureContext = {
	myId: string;
	intention: Intention | null;
	beliefs: BeliefStore;
	map: StaticMap;
	bfs: BfsFromSelf;
	now: number;
	movementDurationMs: number;
	moveSucceeded: boolean;
	moveFailStreak: number;
	stalled: boolean;
	reachedTarget: boolean;
};

function targetDistance(map: StaticMap, bfs: BfsFromSelf, intention: Intention): number | null {
	const targetTileId = tileId(map, intention.targetXY.x, intention.targetXY.y);
	const distance = bfs.dist[targetTileId];
	return distance === undefined || distance === -1 ? null : distance;
}

function inspectTargetParcel(context: FailureContext): FailureAssessment | null {
	const intention = context.intention;
	if (!intention) return null;
	if (intention.kind !== "pickup" && intention.kind !== "detour") return null;
	if (!intention.targetId) return null;

	const parcel = context.beliefs.parcels.get(intention.targetId);
	if (!parcel) {
		return { type: "target_lost", reason: "the target parcel is no longer in the belief store", recoveryAction: "drop", shouldReconsider: true };
	}

	if (parcel.carriedBy && parcel.carriedBy !== context.myId) {
		return { type: "target_lost", reason: "the target parcel was picked up by another agent", recoveryAction: "drop", shouldReconsider: true };
	}

	if (parcel.inView && (parcel.x !== intention.targetXY.x || parcel.y !== intention.targetXY.y)) {
		return { type: "belief_stale", reason: "fresh sensing disagrees with the committed parcel position", recoveryAction: "drop", shouldReconsider: true };
	}

	if (!parcel.inView && context.now - parcel.lastSeenAt > context.movementDurationMs * 4) {
		return { type: "target_lost", reason: "the parcel has not been seen recently enough to trust", recoveryAction: "drop", shouldReconsider: true };
	}

	return null;
}

function inspectBlocking(context: FailureContext): FailureAssessment | null {
	const intention = context.intention;
	if (!intention) return null;

	const distance = targetDistance(context.map, context.bfs, intention);
	if (distance === null) {
		return { type: "blocked", reason: "the committed target is currently not reachable through the sensed world", recoveryAction: "retry", shouldReconsider: false };
	}

	if (!context.moveSucceeded) {
		return { type: "blocked", reason: "the move was denied while the target still looked reachable", recoveryAction: "retry", shouldReconsider: context.moveFailStreak >= 3 };
	}

	if (context.stalled) {
		return { type: "blocked", reason: "the intention is moving, but not making progress", recoveryAction: "retry", shouldReconsider: true };
	}

	return null;
}

export function classifyFailure(context: FailureContext): FailureAssessment | null {
	if (!context.intention || context.reachedTarget) return null;

	return inspectTargetParcel(context) ?? inspectBlocking(context);
}