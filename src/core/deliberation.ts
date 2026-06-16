import {
	selectBestIntention,
	type IntentionCandidate,
	type IntentionRuleContext,
} from "./intention_rules.js";
import {
	scorePickup,
	scoreDeliver,
	scoreGoto,
	batchCandidates,
	type ValuatorMetrics,
} from "./valuator.js";
import {
	buildPlan,
	computeDecayPerStep,
	nearestOutOfViewSpawn,
	nearestRoamTarget,
} from "./planner.js";
import {
	INTENTION_START_MARGIN,
	SPAWN_OBSERVED_TTL_STEPS,
	EXPLORE_EV_PROMOTE,
} from "../config.js";
import { type StaticMap, tileId, idToXY } from "../static_map.js";
import { computeCurrentIntentionUtility } from "./reconsider.js";
import { type Intention, makeIntention } from "./intention.js";
import type { ActiveDirectives } from "../team/directives.js";
import type { TeamAdvice } from "../team/coordinator.js";
import type { BeliefStore } from "../belief_store.js";
import type { BfsFromSelf } from "../pathfinder.js";
import { log } from "../logger.js";

export type DeliberationContext = {
	myId: string;
	map: StaticMap;
	beliefs: BeliefStore;
	bfs: BfsFromSelf;
	selfX: number;
	selfY: number;
	now: number;
	movementDurationMs: number;
	observationDistance: number;
	decayIntervalMs: number;
	carry: import("./planner.js").CarryState;
	intention: Intention | null;
	teamAdvice?: TeamAdvice;
	/** Active mission directives — consumed by valuator scorers. */
	directives?: Readonly<ActiveDirectives>;
	/** Live currency rates (M-EMA, L-throughput). Fallback: M=movementDurationMs, L=0. */
	metrics?: ValuatorMetrics;
	/** Server-reported average parcel reward for explore EV estimate. Fallback: 10. */
	rewardAvg?: number;
};

function freshObservedEmptySpawns(
	beliefs: BeliefStore,
	now: number,
	movementDurationMs: number,
	exploreExcluded?: ReadonlySet<number>,
): Set<number> {
	const spawnTtlMs = SPAWN_OBSERVED_TTL_STEPS * movementDurationMs;
	const fresh = new Set<number>();
	for (const [id, seenAt] of beliefs.observedEmptySpawns) {
		if (now - seenAt < spawnTtlMs) fresh.add(id);
	}
	if (exploreExcluded) for (const id of exploreExcluded) fresh.add(id);
	return fresh;
}

function computeExploreEV(
	map: StaticMap,
	bfs: BfsFromSelf,
	target: { x: number; y: number },
	beliefs: BeliefStore,
	decayIntervalMs: number,
	movementDurationMs: number,
	rewardAvg: number,
): number {
	if (!EXPLORE_EV_PROMOTE) return 0;
	// §5.4: spawn_prob · reward_avg · (1 − decay_rate · ms_per_step · steps)
	const id = map.spawnTileIds.find((sid) => {
		const xy = idToXY(map, sid);
		return xy.x === target.x && xy.y === target.y;
	});
	const steps = id !== undefined ? (bfs.dist[id] ?? 0) : 0;
	const decayPerStep = computeDecayPerStep(
		decayIntervalMs,
		movementDurationMs,
	);
	const spawnerEmptyN = Math.max(
		1,
		map.spawnTileIds.length - beliefs.observedEmptySpawns.size,
	);
	const spawnProb = Math.min(1, steps / Math.max(1, spawnerEmptyN));
	return Math.max(
		0,
		spawnProb * rewardAvg * Math.max(0, 1 - decayPerStep * steps),
	);
}

export function deliberate(context: DeliberationContext): Intention | null {
	const metrics: ValuatorMetrics = context.metrics ?? {
		M: context.movementDurationMs,
		L: 0,
		decayIntervalMs: context.decayIntervalMs,
	};
	const directives = context.directives;
	const excludedParcels = context.teamAdvice?.excludedParcelIds;

	const candidates: IntentionCandidate[] = [];

	// Keep current intention as a candidate (retention bias / hysteresis).
	if (context.intention) {
		candidates.push({
			intention: context.intention,
			source: "current",
			utility: computeCurrentIntentionUtility(
				context.intention,
				context.map,
				context.bfs,
				context.beliefs,
				context.carry,
				context.decayIntervalMs,
				context.movementDurationMs,
			),
		});
	}

	// Deliver candidate (null when carry empty or all delivery tiles excluded).
	const deliverResult = scoreDeliver(
		context.map,
		context.bfs,
		context.carry,
		metrics,
		directives,
	);
	if (deliverResult) {
		candidates.push({
			intention: makeIntention(
				"deliver",
				deliverResult.tile,
				context.now,
			),
			source: "deliver",
			utility: deliverResult.score,
		});
	}

	// Pickup candidate (works for both empty carry and carry > 0).
	const pickupResult = scorePickup(
		context.map,
		context.bfs,
		context.beliefs,
		context.carry,
		metrics,
		directives,
		undefined,
		excludedParcels,
	);
	if (pickupResult) {
		candidates.push({
			intention: makeIntention(
				"pickup",
				{ x: pickupResult.parcel.x, y: pickupResult.parcel.y },
				context.now,
				pickupResult.parcel.id,
			),
			source: "pickup",
			utility: pickupResult.utility,
		});
	}

	// Batch candidates for count-multiplier missions (parcelCountMin threshold).
	if (directives) {
		const batches = batchCandidates(
			context.map,
			context.bfs,
			context.beliefs,
			context.carry,
			metrics,
			directives,
			excludedParcels,
		);
		for (const b of batches) {
			candidates.push({
				intention: makeIntention(
					"pickup",
					{ x: b.firstParcel.x, y: b.firstParcel.y },
					context.now,
					b.firstParcel.id,
				),
				source: "batch",
				utility: b.score,
			});
		}
	}

	// Goto candidates from on:"goto" MODIFIER pool (priced goto missions).
	if (directives) {
		for (const m of directives.modifiers) {
			if (m.selector.on !== "goto") continue;
			// Pick nearest reachable coord among the mission's target coords.
			let nearestXY: { x: number; y: number } | null = null;
			let nearestDist = Infinity;
			for (const coord of m.selector.coords) {
				const id = tileId(context.map, coord.x, coord.y);
				const dist = context.bfs.dist[id];
				if (dist === undefined || dist === -1 || dist >= nearestDist)
					continue;
				nearestDist = dist;
				nearestXY = coord;
			}
			if (!nearestXY) continue;

			const key = `${nearestXY.x},${nearestXY.y}`;
			if (context.teamAdvice?.excludedGotoTargets?.has(key)) continue;

			const bonus = m.effect.add ?? 0;
			const gotoScore = scoreGoto(
				context.bfs,
				context.map,
				nearestXY,
				bonus,
				context.carry,
				metrics,
			);
			if (gotoScore === null) continue;

			candidates.push({
				intention: makeIntention(
					"goto",
					nearestXY,
					context.now,
					undefined,
					m.missionId,
					m.target === "both" ? "global" : "per-agent",
				),
				source: "goto",
				utility: gotoScore,
			});
		}
	}

	// Explore fallback: no pickup found, or crates block delivery and we carry nothing.
	const cratesBlockDelivery =
		context.beliefs.crates.size > 0 &&
		context.carry.n === 0 &&
		!deliverResult;
	if (!pickupResult || cratesBlockDelivery) {
		const explore = nearestOutOfViewSpawn(
			context.map,
			context.bfs,
			context.selfX,
			context.selfY,
			context.observationDistance,
			freshObservedEmptySpawns(
				context.beliefs,
				context.now,
				context.movementDurationMs,
				context.teamAdvice?.exploreExcludedSpawnIds,
			),
			{
				beliefs: context.beliefs,
				now: context.now,
				movementDurationMs: context.movementDurationMs,
			},
		);
		if (explore) {
			candidates.push({
				intention: makeIntention("explore", explore, context.now),
				source: "explore",
				utility: computeExploreEV(
					context.map,
					context.bfs,
					explore,
					context.beliefs,
					context.decayIntervalMs,
					context.movementDurationMs,
					context.rewardAvg ?? 10,
				),
			});
		} else {
			const roam = nearestRoamTarget(
				context.map,
				context.bfs,
				context.selfX,
				context.selfY,
				context.observationDistance,
			);
			if (roam) {
				candidates.push({
					intention: makeIntention("explore", roam, context.now),
					source: "explore",
					utility: 0,
				});
			}
		}
	}

	const ruleContext: IntentionRuleContext = {
		map: context.map,
		bfs: context.bfs,
	};

	const selected = selectBestIntention(ruleContext, candidates);
	if (!selected) return null;

	log.debug(
		"deliberate",
		candidates
			.map((c) => `${c.source}(${c.utility.toFixed(1)})`)
			.join(" | ") +
			` → ${selected.source}(${selected.utility.toFixed(1)}) carry=${context.carry.n}`,
	);

	if (
		selected.source !== "current" &&
		selected.intention.kind !== "explore" &&
		INTENTION_START_MARGIN > 0 &&
		selected.utility < INTENTION_START_MARGIN
	)
		return null;

	const plan = buildPlan(
		context.map,
		context.bfs,
		selected.intention.targetXY.x,
		selected.intention.targetXY.y,
	);
	if (plan.length === 0) return null;

	if (selected.source === "current") {
		return { ...context.intention!, plan };
	}
	return {
		...selected.intention,
		committedAt: context.now,
		moveFailStreak: 0,
		plan,
	};
}
