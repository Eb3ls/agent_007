import {
	scoreOneParcel,
	scoreDeliver,
	scoreGoto,
	gotoBonusForMission,
	deliverTileBlocked,
	type CrossCtx,
	type ValuatorMetrics,
} from "./valuator.js";
import type { ActiveDirectives } from "../team/directives.js";
import { tileId, type StaticMap } from "../static_map.js";
import type { BeliefStore } from "../belief_store.js";
import type { BfsFromSelf } from "../pathfinder.js";
import type { Intention } from "./intention.js";
import { type CarryState } from "./planner.js";
import { cfg } from "../config.js";

export type TerminalReason =
	| "succeeded" // target reached with expected outcome
	| "target_lost" // parcel gone, stolen, or belief stale
	| "unreachable" // no path to target in current BFS
	| "move_blocked" // moveFailStreak >= cfg.intention.max_move_fail_streak
	| "aged"; // intention exceeded cfg.intention.max_age_steps

export type TargetLostDetail =
	| "evicted" // no longer in beliefs.parcels
	| "stolen" // carried by another agent
	| "moved" // seen in-view at different coords
	| "stale" // out-of-view belief expired
	| "not-on-tile" // reached target tile but parcel not ours
	| "goto-retracted" // backing goto modifier was removed/released
	| "deliver-denied"; // delivery tile unconditionally blocked (mult===0)

export type ViabilityCheck =
	| { viable: true }
	| { viable: false; reason: TerminalReason; detail?: TargetLostDetail };

function computeTargetDistance(
	map: StaticMap,
	bfs: BfsFromSelf,
	intention: Intention,
): number | null {
	const id = tileId(map, intention.targetXY.x, intention.targetXY.y);
	const d = bfs.dist[id];
	return d === undefined || d === -1 ? null : d;
}

// Returns why the target parcel is lost, or null if still valid.
function checkTargetParcel(
	myId: string,
	intention: Intention,
	beliefs: BeliefStore,
	now: number,
	movementDurationMs: number,
): TargetLostDetail | null {
	if (intention.kind !== "pickup") return null;
	const parcel = beliefs.parcels.get(intention.targetId!);
	if (!parcel) return "evicted";
	if (parcel.carriedBy && parcel.carriedBy !== myId) return "stolen";
	if (
		parcel.inView &&
		(parcel.x !== intention.targetXY.x || parcel.y !== intention.targetXY.y)
	)
		return "moved";
	if (
		!parcel.inView &&
		now - parcel.lastSeenAt >
			movementDurationMs * cfg.belief.parcel_belief_stale_steps
	)
		return "stale";
	return null;
}

// Computes absolute utility of the current intention using the same valuator scorers as
// deliberate() — ensures current and fresh candidates are on the same scale.
export function computeCurrentIntentionUtility(
	intention: Intention,
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	metrics: ValuatorMetrics,
	directives?: Readonly<ActiveDirectives>,
	crossCtx?: CrossCtx,
): number {
	if (intention.kind === "deliver") {
		// Global best deliver score — deliberate() re-picks the best tile each tick,
		// so scoring the committed tile would create a false schism.
		return (
			scoreDeliver(map, bfs, carry, metrics, directives, crossCtx)
				?.score ?? 0
		);
	}
	if (intention.kind === "explore" || intention.kind === "push") return 0;
	if (intention.kind === "goto") {
		const bonus = gotoBonusForMission(directives, intention.missionId);
		// null = modifier retracted or no missionId — score 0 so it loses the argmax.
		if (bonus === null) return 0;
		return (
			scoreGoto(
				bfs,
				map,
				intention.targetXY,
				bonus,
				carry,
				metrics,
				crossCtx,
			) ?? 0
		);
	}
	// kind === "pickup"
	const p = beliefs.parcels.get(intention.targetId!);
	if (!p || p.carriedBy) return 0;
	return (
		scoreOneParcel(
			p,
			map,
			bfs,
			beliefs,
			carry,
			metrics,
			directives,
			undefined,
			crossCtx,
		) ?? 0
	);
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
	directives?: Readonly<ActiveDirectives>,
): ViabilityCheck {
	// 1) Target reached — distinguish succeeded from target_lost for pickup
	if (selfX === intention.targetXY.x && selfY === intention.targetXY.y) {
		if (intention.kind === "pickup") {
			const parcel = intention.targetId
				? beliefs.parcels.get(intention.targetId)
				: undefined;
			if (parcel?.carriedBy === myId)
				return { viable: false, reason: "succeeded" };
			return {
				viable: false,
				reason: "target_lost",
				detail: "not-on-tile",
			};
		}
		return { viable: false, reason: "succeeded" };
	}

	// PDDL plans navigate crate obstacles that BFS cannot model. Every BFS-based
	// viability check below (unreachable, aged, etc.) would wrongly abort such a
	// plan after a single step. Trust the solver-verified plan: only terminate on
	// reaching the target (handled above) or repeated real move failures.
	if (intention.usedPDDL) {
		if (intention.moveFailStreak >= cfg.intention.max_move_fail_streak)
			return { viable: false, reason: "move_blocked" };
		return { viable: true };
	}

	// 2) Parcel gone or belief stale while en route
	const lost = checkTargetParcel(
		myId,
		intention,
		beliefs,
		now,
		movementDurationMs,
	);
	if (lost) return { viable: false, reason: "target_lost", detail: lost };

	// 2b) Directive retraction: goto modifier released, deliver tile hard-blocked.
	// Stage-driven gotos (no missionId) are not modifier-backed — skip them.
	if (
		directives &&
		intention.kind === "goto" &&
		intention.missionId &&
		gotoBonusForMission(directives, intention.missionId) === null
	)
		return {
			viable: false,
			reason: "target_lost",
			detail: "goto-retracted",
		};
	if (
		directives &&
		intention.kind === "deliver" &&
		deliverTileBlocked(directives, intention.targetXY)
	)
		return {
			viable: false,
			reason: "target_lost",
			detail: "deliver-denied",
		};

	// 3) Explore: target in FOV and close enough to react quickly if a parcel spawns
	if (intention.kind === "explore") {
		const targetId = tileId(
			map,
			intention.targetXY.x,
			intention.targetXY.y,
		);
		const seenAt = beliefs.observedEmptySpawns.get(targetId);
		const distToTarget =
			Math.abs(selfX - intention.targetXY.x) +
			Math.abs(selfY - intention.targetXY.y);
		if (
			seenAt !== undefined &&
			now - seenAt <
				cfg.explore.spawn_observed_ttl_steps * movementDurationMs &&
			distToTarget <= cfg.explore.termination_distance
		)
			return { viable: false, reason: "succeeded" };
	}

	// 4) No path to target in current BFS
	if (computeTargetDistance(map, bfs, intention) === null)
		return { viable: false, reason: "unreachable" };

	// 5) Too many consecutive move failures
	if (intention.moveFailStreak >= cfg.intention.max_move_fail_streak)
		return { viable: false, reason: "move_blocked" };

	// 6) Intention timed out
	const ageSteps = (now - intention.committedAt) / movementDurationMs;
	if (ageSteps >= cfg.intention.max_age_steps)
		return { viable: false, reason: "aged" };

	return { viable: true };
}
