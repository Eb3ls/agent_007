
import type { Intention, IntentionProgress } from "./intention.js";
import type { BfsFromSelf } from "./pathfinder.js";
import { tileId, type StaticMap } from "./static_map.js";

export type IntrospectionResult = {
	progressed: boolean;
	reachedTarget: boolean;
	failed: boolean;
	stalled: boolean;
	shouldReconsider: boolean;
	distanceToTarget: number | null;
	previousDistanceToTarget: number | null;
};

export type IntrospectionContext = {
	intention: Intention | null;
	map: StaticMap;
	bfs: BfsFromSelf;
	selfX: number;
	selfY: number;
	now: number;
	movementDurationMs: number;
	moveSucceeded: boolean;
};

const STALL_MOVE_FAILS = 3;
const STALL_NO_PROGRESS_STEPS = 4;

function distanceToTarget(
	intention: Intention,
	map: StaticMap,
	bfs: BfsFromSelf,
): number | null {
	const targetTileId = tileId(map, intention.targetXY.x, intention.targetXY.y);
	const dist = bfs.dist[targetTileId];
	return dist === undefined || dist === -1 ? null : dist;
}

function updateProgressState(
	progress: IntentionProgress,
	now: number,
	distance: number | null,
	moveSucceeded: boolean,
): IntentionProgress {
	const next: IntentionProgress = {
		...progress,
		lastCheckedAt: now,
	};

	if (moveSucceeded) next.stepsTaken += 1;
	if (distance !== null) {
		if (next.lastDistance === null || distance < next.lastDistance) {
			next.lastProgressAt = now;
			next.failuresSinceProgress = 0;
		} else if (!moveSucceeded) {
			next.failuresSinceProgress += 1;
		}
		next.lastDistance = distance;
	}

	return next;
}

export function introspect(context: IntrospectionContext): IntrospectionResult {
	if (!context.intention) {
		return {
			progressed: false,
			reachedTarget: false,
			failed: false,
			stalled: false,
			shouldReconsider: false,
			distanceToTarget: null,
			previousDistanceToTarget: null,
		};
	}

	const distanceToTargetValue = distanceToTarget(
		context.intention,
		context.map,
		context.bfs,
	);
	const previousDistance = context.intention.progress.lastDistance;
	const previousFailures = context.intention.moveFailStreak;
	context.intention.progress = updateProgressState(
		context.intention.progress,
		context.now,
		distanceToTargetValue,
		context.moveSucceeded,
	);

	const reachedTarget =
		context.selfX === context.intention.targetXY.x &&
		context.selfY === context.intention.targetXY.y;
	const failed =
		!context.moveSucceeded && previousFailures + 1 >= STALL_MOVE_FAILS;
	const stalled =
		context.intention.progress.stepsTaken >= STALL_NO_PROGRESS_STEPS &&
		previousDistance !== null &&
		distanceToTargetValue === previousDistance;
	const progressed =
		previousDistance !== null &&
		distanceToTargetValue !== null &&
		distanceToTargetValue < previousDistance;
	const shouldReconsider = reachedTarget || failed || stalled;

	return {
		progressed,
		reachedTarget,
		failed,
		stalled,
		shouldReconsider,
		distanceToTarget: distanceToTargetValue,
		previousDistanceToTarget: previousDistance,
	};
}