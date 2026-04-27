import {
	reconstructPath,
	type BfsFromSelf,
	type Direction,
} from "./pathfinder.js";
import type { AgentBelief, BeliefStore, ParcelBelief } from "./belief_store.js";
import {
	AGENT_GRACE_STEPS,
	EXPECTED_STEAL_HORIZON_STEPS,
	INTENTION_MAX_AGE_STEPS,
	INTENTION_UTILITY_EPSILON,
	MAX_MOVE_FAIL_STREAK,
} from "./config.js";
import { idToXY, inBounds, tileId, type StaticMap } from "./static_map.js";
import type { IOParcel } from "@unitn-asa/deliveroo-js-sdk";

export function isAgentBlocking(
	a: AgentBelief,
	movMs: number,
	graceSteps: number,
	now: number,
): boolean {
	if (a.inView) return true;
	const ageSteps = (now - a.lastSeenAt) / movMs;
	return ageSteps <= graceSteps;
}

export function computeBlockedTiles(
	map: StaticMap,
	beliefs: BeliefStore,
	movMs: number,
	graceSteps: number = AGENT_GRACE_STEPS,
): Set<number> {
	const blocked = new Set<number>();
	const now = Date.now();
	for (const a of beliefs.agents.values()) {
		if (!isAgentBlocking(a, movMs, graceSteps, now)) continue;
		if (a.x === undefined || a.y === undefined) continue;
		const ax = Math.round(a.x);
		const ay = Math.round(a.y);
		if (!inBounds(map, ax, ay)) continue;
		blocked.add(tileId(map, ax, ay));
	}
	return blocked;
}

export function nearestDeliveryTile(
	map: StaticMap,
	bfs: BfsFromSelf,
): { x: number; y: number } | null {
	let bestId = -1,
		bestDist = Infinity;
	for (const did of map.deliveryTileIds) {
		const d = bfs.dist[did];
		if (d !== undefined && d !== -1 && d < bestDist) {
			bestDist = d;
			bestId = did;
		}
	}
	return bestId === -1 ? null : idToXY(map, bestId);
}

export function nearestOutOfViewSpawn(
	map: StaticMap,
	bfs: BfsFromSelf,
	sx: number,
	sy: number,
	observationDistance: number,
): { x: number; y: number } | null {
	let bestId = -1;
	let bestCost = Infinity;
	for (const sid of map.spawnTileIds) {
		const sp = bfs.dist[sid];
		if (sp === undefined || sp <= 0) continue;
		const sd = map.baseReverseDistToDelivery[sid];
		if (sd === undefined || sd === -1) continue;
		const { x, y } = idToXY(map, sid);
		if (Math.max(Math.abs(x - sx), Math.abs(y - sy)) <= observationDistance)
			continue;
		const cost = sp + sd;
		if (cost < bestCost) {
			bestCost = cost;
			bestId = sid;
		}
	}
	return bestId === -1 ? null : idToXY(map, bestId);
}

export function shouldDrop(
	map: StaticMap,
	selfId: number,
	carrying: boolean,
): boolean {
	return carrying && map.baseReverseDistToDelivery[selfId] === 0;
}

export function parcelHere(
	parcels: Map<string, ParcelBelief>,
	sx: number,
	sy: number,
): ParcelBelief | undefined {
	for (const p of parcels.values()) {
		if (p.inView && p.x === sx && p.y === sy && !p.carriedBy) return p;
	}
	return undefined;
}

export function currentReward(
	p: ParcelBelief,
	decayIntervalMs: number,
	now: number,
): number {
	if (!Number.isFinite(decayIntervalMs)) return p.reward;
	return p.reward - Math.floor((now - p.firstSeenAt) / decayIntervalMs);
}

// Expected reward accounting for probabilistic availability: in-view parcels are
// certain; out-of-view parcels are discounted by P_alive = exp(-age/horizon).
export function expectedReward(
	p: ParcelBelief,
	decayMs: number,
	movMs: number,
	stealHorizonSteps: number,
	now: number,
): number {
	const base = currentReward(p, decayMs, now);
	if (base <= 0) return 0;
	if (p.inView) return base;
	const ageSteps = (now - p.lastSeenAt) / movMs;
	return base * Math.exp(-ageSteps / stealHorizonSteps);
}

export function pickBestParcelTarget(
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	decayIntervalMs: number,
	movementDurationMs: number,
	stealHorizonSteps: number = EXPECTED_STEAL_HORIZON_STEPS,
): IOParcel | null {
	const now = Date.now();
	const decayPerStep = Number.isFinite(decayIntervalMs)
		? movementDurationMs / decayIntervalMs
		: 0;
	let best: ParcelBelief | null = null;
	let bestUtility = -Infinity;
	let bestSp = Infinity;
	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		const pid = tileId(map, p.x, p.y);
		const sp = bfs.dist[pid];
		if (sp === undefined || sp === -1) continue;
		const sd = map.baseReverseDistToDelivery[pid];
		if (sd === undefined || sd === -1) continue;
		const reward = expectedReward(
			p,
			decayIntervalMs,
			movementDurationMs,
			stealHorizonSteps,
			now,
		);
		if (reward <= 0) continue;
		const utility = reward - decayPerStep * (sp + sd);
		if (utility <= 0) continue;
		if (utility > bestUtility || (utility === bestUtility && sp < bestSp)) {
			bestUtility = utility;
			bestSp = sp;
			best = p;
		}
	}
	return best;
}

export type CarryState = {
	n: number;
	rewards: number[];
	nearestDeliveryDist: number;
	ids: string[];
};

// Derives carry state from beliefs.parcels (authoritative for carriedBy + firstSeenAt).
export function deriveCarryState(
	parcels: Map<string, ParcelBelief>,
	myId: string,
	map: StaticMap,
	bfs: BfsFromSelf,
	decayMs: number,
	now: number,
): CarryState {
	const ids: string[] = [];
	const rewards: number[] = [];
	for (const p of parcels.values()) {
		if (p.carriedBy !== myId) continue;
		ids.push(p.id);
		rewards.push(currentReward(p, decayMs, now));
	}
	let nearestDeliveryDist = Infinity;
	for (const did of map.deliveryTileIds) {
		const d = bfs.dist[did];
		if (d !== undefined && d !== -1 && d < nearestDeliveryDist)
			nearestDeliveryDist = d;
	}
	return { n: ids.length, rewards, nearestDeliveryDist, ids };
}

// Saturated decay cost: a parcel with reward R cannot lose more than R over t steps.
function decayCost(r: number, decayPerStep: number, t: number): number {
	return Math.min(r, decayPerStep * t);
}

// Evaluates whether a mid-carry detour to pick up an additional parcel is worth it.
// Uses the portfolio-aware formula with per-parcel saturation:
//   surplus = R_p_expected − (decay_detour − decay_direct)
// where decay costs are capped at each parcel's current reward.
export function pickBestDetourTarget(
	m: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	decayMs: number,
	movMs: number,
	stealHorizonSteps: number,
	capacity: number,
	epsilon: number,
): ParcelBelief | null {
	if (carry.n >= capacity) return null;
	const now = Date.now();
	const decayPerStep = Number.isFinite(decayMs) ? movMs / decayMs : 0;
	const s0 = carry.nearestDeliveryDist;

	const decayDirect = carry.rewards.reduce(
		(sum, r) => sum + decayCost(r, decayPerStep, s0),
		0,
	);

	let best: ParcelBelief | null = null;
	let bestSurplus = -Infinity;

	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		const pid = tileId(m, p.x, p.y);
		const sp = bfs.dist[pid];
		if (sp === undefined || sp === -1) continue;
		const sd = m.baseReverseDistToDelivery[pid];
		if (sd === undefined || sd === -1) continue;
		const S = sp + sd;
		const rp = expectedReward(p, decayMs, movMs, stealHorizonSteps, now);
		if (rp <= 0) continue;
		const decayDetour =
			carry.rewards.reduce(
				(sum, r) => sum + decayCost(r, decayPerStep, S),
				0,
			) + decayCost(rp, decayPerStep, S);
		const surplus = rp - decayDetour + decayDirect;
		if (surplus > epsilon && surplus > bestSurplus) {
			bestSurplus = surplus;
			best = p;
		}
	}
	return best;
}

export function planStep(
	map: StaticMap,
	bfs: BfsFromSelf,
	carrying: boolean,
	target: IOParcel | null,
	detourTarget: ParcelBelief | null,
	exploreTarget: { x: number; y: number } | null,
	commitTarget?: { x: number; y: number } | null,
): Direction | null {
	let dest: { x: number; y: number } | null;
	if (commitTarget) {
		dest = commitTarget;
	} else if (carrying && detourTarget) {
		dest = { x: detourTarget.x, y: detourTarget.y };
	} else if (carrying) {
		dest = nearestDeliveryTile(map, bfs);
	} else if (target) {
		dest = { x: target.x, y: target.y };
	} else {
		dest = exploreTarget;
	}
	if (!dest) return null;
	return reconstructPath(map, bfs, dest.x, dest.y)?.[0] ?? null;
}

export type Intention = {
	kind: "deliver" | "pickup" | "detour" | "explore";
	targetId?: string;
	targetXY: { x: number; y: number };
	expectedUtility: number;
	committedAt: number;
	moveFailStreak: number;
};

// Returns true when the agent should abandon current intention and replan.
export function shouldReplan(
	current: Intention | null,
	candidate: Intention | null,
	beliefs: BeliefStore,
	map: StaticMap,
	bfs: BfsFromSelf,
	sx: number,
	sy: number,
	now: number,
	movMs: number,
): boolean {
	if (!current) return true;

	// Reached target
	if (sx === current.targetXY.x && sy === current.targetXY.y) return true;

	// Safety timeout
	const ageSteps = (now - current.committedAt) / movMs;
	if (ageSteps >= INTENTION_MAX_AGE_STEPS) return true;

	// Too many consecutive move failures
	if (current.moveFailStreak >= MAX_MOVE_FAIL_STREAK) return true;

	// Target tile unreachable via BFS
	const targetTileId = tileId(map, current.targetXY.x, current.targetXY.y);
	if (bfs.dist[targetTileId] === -1) return true;

	// For pickup/detour: parcel gone or carried by someone else
	if (
		(current.kind === "pickup" || current.kind === "detour") &&
		current.targetId
	) {
		const p = beliefs.parcels.get(current.targetId);
		if (!p || p.carriedBy) return true;
	}

	// Better candidate appears
	if (
		candidate &&
		candidate.expectedUtility >
			current.expectedUtility + INTENTION_UTILITY_EPSILON
	)
		return true;

	return false;
}
