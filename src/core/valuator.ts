import {
	computeContestFactor,
	expectedReward,
	nearestDeliveryTile,
	nearestOutOfViewSpawn,
	sumRewards,
	type CarryState,
	type PickResult,
} from "./planner.js";
import type {
	ActiveDirectives,
	ActiveModifier,
	Condition,
} from "../team/directives.js";
import type { BeliefStore, ParcelBelief } from "../belief_store.js";
import { idToXY, tileId, type StaticMap } from "../static_map.js";
import type { BfsFromSelf } from "../pathfinder.js";
import { bfsFromSelf } from "../pathfinder.js";
import { cfg } from "../config.js";

export type { CarryState, PickResult };
export { nearestOutOfViewSpawn as scoreExplore };

export type ValuatorMetrics = {
	M: number;
	L: number;
	decayIntervalMs: number;
};

export type DeliverResult = {
	tile: { x: number; y: number; id: number };
	score: number;
};

export type BatchResult = {
	targetCount: number;
	mult: number;
	score: number;
	firstParcel: ParcelBelief;
};

function dPerStep(metrics: ValuatorMetrics): number {
	return Number.isFinite(metrics.decayIntervalMs)
		? metrics.M / metrics.decayIntervalMs
		: 0;
}

function conditionMet(cond: Condition | undefined, carry: CarryState): boolean {
	if (!cond) return true;
	const R_c = sumRewards(carry);
	if ("carryCountEquals" in cond) return carry.n === cond.carryCountEquals;
	if ("carryCountAtLeast" in cond) return carry.n >= cond.carryCountAtLeast;
	if ("carryCountOver" in cond) return carry.n > cond.carryCountOver;
	if ("carryRewardAtMost" in cond) return R_c <= cond.carryRewardAtMost;
	return true;
}

/**
 * Σ_effects(R_c) = R_c × Π(mult_i) + Σ(add_i) for all matching deliver modifiers.
 * tile: if provided, tile-specific modifiers only apply when selector.tile matches.
 */
function sigmaEffects(
	R_c: number,
	modifiers: readonly ActiveModifier[],
	carry: CarryState,
	tile?: { x: number; y: number },
): number {
	let mult = 1;
	let add = 0;
	for (const m of modifiers) {
		if (m.selector.on !== "deliver") continue;
		if (
			tile &&
			m.selector.tile &&
			(m.selector.tile.x !== tile.x || m.selector.tile.y !== tile.y)
		)
			continue;
		if (!conditionMet(m.condition, carry)) continue;
		if (m.effect.mult !== undefined) mult *= m.effect.mult;
		if (m.effect.add !== undefined) add += m.effect.add;
	}
	return R_c * mult + add;
}

export type ParcelCapEffect = {
	rewardOver: number;
	mult: number;
	add: number;
};

// Returns the combined effect of all active deliver-parcel cap modifiers,
// keyed on the lowest rewardOver threshold. mult defaults to 0 (hard block)
// when not specified, matching the corpus behaviour.
export function parcelCapEffect(
	modifiers: readonly ActiveModifier[],
): ParcelCapEffect | null {
	let rewardOver: number | null = null;
	let mult = 1;
	let add = 0;
	for (const m of modifiers) {
		if (m.selector.on !== "deliver-parcel") continue;
		const ro = (m.selector as { on: "deliver-parcel"; rewardOver?: number })
			.rewardOver;
		if (ro === undefined) continue;
		if (rewardOver === null || ro < rewardOver) rewardOver = ro;
		mult *= m.effect.mult ?? 0;
		if (m.effect.add !== undefined) add += m.effect.add;
	}
	return rewardOver !== null ? { rewardOver, mult, add } : null;
}

// Thin wrapper for callers that only need the threshold.
export function activeScoreCap(
	modifiers: readonly ActiveModifier[],
): number | null {
	return parcelCapEffect(modifiers)?.rewardOver ?? null;
}

/**
 * Absolute full-trip pickup score per §5.3.
 * Score_pickup(P) = R_c + R_p_eff − (n+1)·d·M·S
 * Parcels whose reward exceeds an active deliver-parcel cap → parcel_reward_eff = 0 → skipped.
 */
export function scorePickup(
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	metrics: ValuatorMetrics,
	directives?: Readonly<ActiveDirectives>,
	stealHorizonSteps: number = cfg.belief.expected_steal_horizon_steps,
	extraExcludedIds?: ReadonlySet<string>,
): PickResult | null {
	const now = Date.now();
	const dp = dPerStep(metrics);
	const modifiers = directives?.modifiers ?? [];
	const forbidden = directives?.forbiddenPickupParcelIds ?? new Set<string>();

	const capFx = parcelCapEffect(modifiers);

	const nearestDeliv = nearestDeliveryTile(map, bfs);
	const s0 =
		nearestDeliv !== null
			? (bfs.dist[tileId(map, nearestDeliv.x, nearestDeliv.y)] ??
				Infinity)
			: Infinity;

	const R_c = sumRewards(carry);
	const n = carry.n;

	let best: ParcelBelief | null = null;
	let bestScore = -Infinity;

	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		if (forbidden.has(p.id)) continue;
		if (extraExcludedIds?.has(p.id)) continue;

		// Skip parcels too stale to actually pursue. A pickup committed to an
		// out-of-view parcel not seen within parcel_belief_stale_steps is dropped by
		// viability (checkTargetParcel) on the very next tick, so selecting one here
		// only causes commit → target_lost → reselect thrash (and, while carrying,
		// oscillation against deliver). Keep selection consistent with viability.
		if (
			!p.inView &&
			now - p.lastSeenAt >
				metrics.M * cfg.belief.parcel_belief_stale_steps
		)
			continue;

		// Hard-skip when cap mult is 0 (×0 block); fractional mult → scale reward below.
		if (capFx !== null && p.reward > capFx.rewardOver && capFx.mult === 0)
			continue;

		const pId = tileId(map, p.x, p.y);
		const distToP = bfs.dist[pId];
		if (distToP === undefined || distToP === -1) continue;

		const distPToDel = map.baseReverseDistToDelivery[pId];
		if (distPToDel === undefined || distPToDel === -1) continue;

		const S = distToP + distPToDel;

		const R_p =
			expectedReward(
				p,
				metrics.decayIntervalMs,
				metrics.M,
				stealHorizonSteps,
				now,
			) *
			(1 -
				computeContestFactor(
					beliefs,
					p.x,
					p.y,
					distToP,
					metrics.M,
					now,
				));
		if (R_p <= 0) continue;

		const R_p_eff =
			capFx !== null && p.reward > capFx.rewardOver
				? R_p * capFx.mult + capFx.add
				: R_p;

		if (dp > 0 && R_p_eff <= dp * ((n + 1) * S - n * s0)) continue;

		const score = R_c + R_p_eff - (n + 1) * dp * S;
		if (score > bestScore) {
			bestScore = score;
			best = p;
		}
	}

	return best ? { parcel: best, utility: bestScore } : null;
}

/**
 * Absolute deliver score per §5.3.
 * Scores ALL reachable delivery tiles with Σ_effects and returns the best.
 * Score_deliver(T) = Σ_effects(R_c, T) − n·d·M·dist(T)
 */
export function scoreDeliver(
	map: StaticMap,
	bfs: BfsFromSelf,
	carry: CarryState,
	metrics: ValuatorMetrics,
	directives?: Readonly<ActiveDirectives>,
): DeliverResult | null {
	if (carry.n === 0) return null;

	const dp = dPerStep(metrics);
	const R_c = sumRewards(carry);
	const modifiers = directives?.modifiers ?? [];

	let best: DeliverResult | null = null;
	let bestScore = -Infinity;

	for (const id of map.deliveryTileIds) {
		const dist = bfs.dist[id];
		if (dist === undefined || dist === -1) continue;
		const { x, y } = idToXY(map, id);
		const score =
			sigmaEffects(R_c, modifiers, carry, { x, y }) - carry.n * dp * dist;
		if (!Number.isFinite(score) || score <= bestScore) continue;
		bestScore = score;
		best = { tile: { x, y, id }, score };
	}

	return best;
}

/**
 * Absolute goto score per §5.3.
 * Score_goto(T, B) = B − (L + n·d)·M·s_T
 */
export function scoreGoto(
	bfs: BfsFromSelf,
	map: StaticMap,
	target: { x: number; y: number },
	bonus: number,
	carry: CarryState,
	metrics: ValuatorMetrics,
): number | null {
	const tId = tileId(map, target.x, target.y);
	const sT = bfs.dist[tId];
	if (sT === undefined || sT === -1) return null;

	const d = Number.isFinite(metrics.decayIntervalMs)
		? 1 / metrics.decayIntervalMs
		: 0;
	return bonus - (metrics.L + carry.n * d) * metrics.M * sT;
}

/**
 * Batch candidates for count-multiplier missions (§5.6).
 * Derives count thresholds from MODIFIER with on:"deliver" + carryCountEquals|carryCountAtLeast condition.
 * FIX: chain valuation uses expectedReward (not currentReward) per §5.3.
 */
export function batchCandidates(
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	metrics: ValuatorMetrics,
	directives: Readonly<ActiveDirectives>,
	extraExcludedIds?: ReadonlySet<string>,
): BatchResult[] {
	const targets: Array<{ targetCount: number; mult: number }> = [];

	for (const m of directives.modifiers) {
		if (m.selector.on !== "deliver") continue;
		const cond = m.condition;
		if (!cond || m.effect.mult === undefined) continue;
		let threshold: number | null = null;
		if ("carryCountEquals" in cond) threshold = cond.carryCountEquals;
		else if ("carryCountAtLeast" in cond)
			threshold = cond.carryCountAtLeast;
		if (threshold !== null && threshold > carry.n) {
			targets.push({ targetCount: threshold, mult: m.effect.mult });
		}
	}

	if (targets.length === 0) return [];

	const dp = dPerStep(metrics);
	const R_c = sumRewards(carry);
	const forbidden = directives.forbiddenPickupParcelIds;
	const results: BatchResult[] = [];

	for (const { targetCount, mult } of targets) {
		const need = targetCount - carry.n;
		if (need <= 0) continue;

		const chain = buildGreedyChain(
			map,
			bfs,
			beliefs,
			need,
			metrics,
			forbidden,
			extraExcludedIds,
		);
		if (!chain) continue;

		const totalReward = R_c + chain.reward;
		const score = mult * totalReward - targetCount * dp * chain.totalSteps;
		results.push({
			targetCount,
			mult,
			score,
			firstParcel: chain.firstParcel,
		});
	}

	return results;
}

function buildGreedyChain(
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	need: number,
	metrics: ValuatorMetrics,
	forbidden: ReadonlySet<string>,
	extraExcluded?: ReadonlySet<string>,
): { reward: number; totalSteps: number; firstParcel: ParcelBelief } | null {
	const now = Date.now();
	let currentBfs = bfs;
	let totalSteps = 0;
	let totalReward = 0;
	const taken = new Set<string>();
	let lastPos: { x: number; y: number } | null = null;
	let firstParcel: ParcelBelief | null = null;

	for (let i = 0; i < need; i++) {
		let nearestParcel: ParcelBelief | null = null;
		let nearestDist = Infinity;

		for (const p of beliefs.parcels.values()) {
			if (p.carriedBy) continue;
			if (forbidden.has(p.id)) continue;
			if (extraExcluded?.has(p.id)) continue;
			if (taken.has(p.id)) continue;
			// Skip parcels too stale to pursue (see scorePickup) — consistency with viability.
			if (
				!p.inView &&
				now - p.lastSeenAt >
					metrics.M * cfg.belief.parcel_belief_stale_steps
			)
				continue;

			const pId = tileId(map, p.x, p.y);
			const dist = currentBfs.dist[pId];
			if (dist === undefined || dist === -1) continue;
			if (dist < nearestDist) {
				nearestDist = dist;
				nearestParcel = p;
			}
		}

		if (!nearestParcel) return null;

		if (i === 0) firstParcel = nearestParcel;
		taken.add(nearestParcel.id);
		totalSteps += nearestDist;
		// FIX: use expectedReward (travel-decay + contest) not currentReward
		totalReward += expectedReward(
			nearestParcel,
			metrics.decayIntervalMs,
			metrics.M,
			cfg.belief.expected_steal_horizon_steps,
			now,
		);
		lastPos = { x: nearestParcel.x, y: nearestParcel.y };

		if (i < need - 1) {
			currentBfs = bfsFromSelf(map, nearestParcel.x, nearestParcel.y);
		}
	}

	if (!lastPos || !firstParcel) return null;

	const delivBfs =
		need === 1 ? currentBfs : bfsFromSelf(map, lastPos.x, lastPos.y);
	const delivTile = nearestDeliveryTile(map, delivBfs);
	if (!delivTile) return null;
	const delivDist = delivBfs.dist[tileId(map, delivTile.x, delivTile.y)];
	if (delivDist === undefined || delivDist === -1) return null;
	totalSteps += delivDist;

	return { reward: totalReward, totalSteps, firstParcel };
}

export function maxBatchScore(batches: BatchResult[]): number {
	return batches.length > 0
		? Math.max(...batches.map((b) => b.score))
		: -Infinity;
}

export function carryValue(
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	metrics: ValuatorMetrics,
	directives: Readonly<ActiveDirectives>,
): number {
	const d = scoreDeliver(map, bfs, carry, metrics, directives);
	const batches = batchCandidates(
		map,
		bfs,
		beliefs,
		carry,
		metrics,
		directives,
	);
	return Math.max(
		d?.score ?? 0,
		batches.length > 0 ? maxBatchScore(batches) : 0,
	);
}
