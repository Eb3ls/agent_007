import {
	computeDecayPerStep,
	computeDeliverUtility,
	decayCost,
	expectedReward,
	pickBestParcelTarget,
	type CarryState,
} from "./planner.js";
import { tileId, type StaticMap } from "../static_map.js";
import type { BeliefStore } from "../belief_store.js";
import type { BfsFromSelf } from "../pathfinder.js";
import type { Intention } from "./intention.js";
import { cfg } from "../config.js";

export type TerminalReason =
	| "succeeded" // target reached with expected outcome
	| "target_lost" // parcel gone, stolen, or belief stale
	| "unreachable" // no path to target in current BFS
	| "move_blocked" // moveFailStreak >= cfg.intention.max_move_fail_streak
	| "aged"; // intention exceeded cfg.intention.max_age_steps

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

// False if the target parcel was stolen, has moved in-view, or belief has gone stale out-of-view.
function checkTargetParcel(
	myId: string,
	intention: Intention,
	beliefs: BeliefStore,
	now: number,
	movementDurationMs: number,
): boolean {
	if (intention.kind !== "pickup") return true;
	const parcel = beliefs.parcels.get(intention.targetId!);
	if (!parcel) return false;
	if (parcel.carriedBy && parcel.carriedBy !== myId) return false;

	if (
		parcel.inView &&
		(parcel.x !== intention.targetXY.x || parcel.y !== intention.targetXY.y)
	)
		return false;
	if (
		!parcel.inView &&
		now - parcel.lastSeenAt >
			movementDurationMs * cfg.belief.parcel_belief_stale_steps
	)
		return false;
	return true;
}

// Computes absolute utility of the current intention — same formula as pickBestParcelTarget
// so the comparison with freshTarget.utility is on the same scale.
export function computeCurrentIntentionUtility(
	intention: Intention,
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	decayIntervalMs: number,
	movementDurationMs: number,
): number {
	const decayPerStep = computeDecayPerStep(
		decayIntervalMs,
		movementDurationMs,
	);

	if (intention.kind === "deliver") {
		return computeDeliverUtility(
			carry.rewards,
			decayPerStep,
			carry.nearestDeliveryDist,
		);
	}
	if (intention.kind === "explore") return 0;

	// kind === "pickup"
	const p = beliefs.parcels.get(intention.targetId!);
	if (!p || p.carriedBy) return 0;

	const parcelTileId = tileId(map, p.x, p.y);
	const dist = bfs.dist[parcelTileId];
	const distToDel = map.baseReverseDistToDelivery[parcelTileId];
	if (
		dist === undefined ||
		dist === -1 ||
		distToDel === undefined ||
		distToDel === -1
	)
		return 0;

	const reward = expectedReward(
		p,
		decayIntervalMs,
		movementDurationMs,
		cfg.belief.expected_steal_horizon_steps,
		Date.now(),
	);
	if (reward <= 0) return 0;

	const totalDist = dist + distToDel; // detour path: self → parcel → delivery
	const parcelNet = reward - decayCost(reward, decayPerStep, totalDist);
	if (carry.n === 0) return parcelNet;
	return (
		computeDeliverUtility(carry.rewards, decayPerStep, totalDist) +
		parcelNet
	);
}

// Meta-level reconsider gate: should we re-deliberate even though intention is still viable?
// Utilities are absolute and comparable: freshTarget uses pickBestParcelTarget,
// currentUtility uses the same formula for the committed intention.
export function shouldReconsider(
	intention: Intention,
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	decayIntervalMs: number,
	movementDurationMs: number,
): boolean {
	const freshTarget = pickBestParcelTarget(
		map,
		bfs,
		beliefs,
		decayIntervalMs,
		movementDurationMs,
		carry,
	);
	if (!freshTarget) return false;
	if (
		intention.kind === "pickup" &&
		freshTarget.parcel.id === intention.targetId
	)
		return false;
	const currentUtility = computeCurrentIntentionUtility(
		intention,
		map,
		bfs,
		beliefs,
		carry,
		decayIntervalMs,
		movementDurationMs,
	);
	// abort_margin: force reconsider if current utility has dropped too low.
	if (
		cfg.intention.abort_margin > 0 &&
		currentUtility < cfg.intention.abort_margin
	)
		return true;
	return (
		freshTarget.utility >
		currentUtility *
			(1 + cfg.intention.reconsider_opportunity_margin_fraction)
	);
}

// Reconsider gate for committed PDDL plans: only an explore plan may be
// preempted, and only by a more valuable parcel pickup — never by another
// explore target — so crate plans run to completion. For an explore intention
// shouldReconsider already reduces to exactly this parcel comparison, so we
// just gate on kind and delegate.
export function shouldReconsiderPDDLForParcel(
	intention: Intention,
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	decayIntervalMs: number,
	movementDurationMs: number,
): boolean {
	if (intention.kind !== "explore") return false;
	return shouldReconsider(
		intention,
		map,
		bfs,
		beliefs,
		carry,
		decayIntervalMs,
		movementDurationMs,
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
): ViabilityCheck {
	// 1) Target reached — distinguish succeeded from target_lost for pickup
	if (selfX === intention.targetXY.x && selfY === intention.targetXY.y) {
		if (intention.kind === "pickup") {
			const parcel = intention.targetId
				? beliefs.parcels.get(intention.targetId)
				: undefined;
			if (parcel?.carriedBy === myId)
				return { viable: false, reason: "succeeded" };
			return { viable: false, reason: "target_lost" };
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
	if (!checkTargetParcel(myId, intention, beliefs, now, movementDurationMs))
		return { viable: false, reason: "target_lost" };

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
