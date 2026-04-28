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
	agent: AgentBelief,
	movementDurationMs: number,
	graceSteps: number,
	now: number,
): boolean {
	if (agent.inView) return true;
	const ageSteps = (now - agent.lastSeenAt) / movementDurationMs;
	return ageSteps <= graceSteps;
}

export function computeBlockedTiles(
	map: StaticMap,
	beliefs: BeliefStore,
	movementDurationMs: number,
	graceSteps: number = AGENT_GRACE_STEPS,
): Set<number> {
	const blocked = new Set<number>();
	const now = Date.now();
	for (const agent of beliefs.agents.values()) {
		if (!isAgentBlocking(agent, movementDurationMs, graceSteps, now)) continue;
		if (agent.x === undefined || agent.y === undefined) continue;
		const agentX = Math.round(agent.x);
		const agentY = Math.round(agent.y);
		if (!inBounds(map, agentX, agentY)) continue;
		blocked.add(tileId(map, agentX, agentY));
	}
	return blocked;
}

export function nearestDeliveryTile(
	map: StaticMap,
	bfs: BfsFromSelf,
): { x: number; y: number } | null {
	let bestId = -1,
		bestDist = Infinity;
	for (const deliveryId of map.deliveryTileIds) {
		const dist = bfs.dist[deliveryId];
		if (dist !== undefined && dist !== -1 && dist < bestDist) {
			bestDist = dist;
			bestId = deliveryId;
		}
	}
	return bestId === -1 ? null : idToXY(map, bestId);
}

export function nearestOutOfViewSpawn(
	map: StaticMap,
	bfs: BfsFromSelf,
	selfX: number,
	selfY: number,
	observationDistance: number,
	visitedSpawnIds?: ReadonlySet<number>,
): { x: number; y: number } | null {
	let bestId = -1;
	let bestCost = Infinity;
	for (const spawnId of map.spawnTileIds) {
		const distToSpawn = bfs.dist[spawnId];
		if (distToSpawn === undefined || distToSpawn <= 0) continue;
		const distSpawnToDelivery = map.baseReverseDistToDelivery[spawnId];
		if (distSpawnToDelivery === undefined || distSpawnToDelivery === -1) continue;
		if (visitedSpawnIds?.has(spawnId)) continue;
		const { x, y } = idToXY(map, spawnId);
		if (Math.max(Math.abs(x - selfX), Math.abs(y - selfY)) <= observationDistance)
			continue;
		const cost = distToSpawn + distSpawnToDelivery;
		if (cost < bestCost) {
			bestCost = cost;
			bestId = spawnId;
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
	selfX: number,
	selfY: number,
): ParcelBelief | undefined {
	for (const parcel of parcels.values()) {
		if (parcel.inView && parcel.x === selfX && parcel.y === selfY && !parcel.carriedBy) return parcel;
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
	decayIntervalMs: number,
	movementDurationMs: number,
	stealHorizonSteps: number,
	now: number,
): number {
	const base = currentReward(p, decayIntervalMs, now);
	if (base <= 0) return 0;
	if (p.inView) return base;
	const ageSteps = (now - p.lastSeenAt) / movementDurationMs;
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
	const decayPerStep = computeDecayPerStep(decayIntervalMs, movementDurationMs);
	let best: ParcelBelief | null = null;
	let bestUtility = -Infinity;
	let bestDistToParcel = Infinity;
	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		const parcelTileId = tileId(map, p.x, p.y);
		const distToParcel = bfs.dist[parcelTileId];
		if (distToParcel === undefined || distToParcel === -1) continue;
		const distParcelToDelivery = map.baseReverseDistToDelivery[parcelTileId];
		if (distParcelToDelivery === undefined || distParcelToDelivery === -1) continue;
		const reward = expectedReward(
			p,
			decayIntervalMs,
			movementDurationMs,
			stealHorizonSteps,
			now,
		);
		if (reward <= 0) continue;
		const utility = reward - decayPerStep * (distToParcel + distParcelToDelivery);
		if (utility <= 0) continue;
		if (utility > bestUtility || (utility === bestUtility && distToParcel < bestDistToParcel)) {
			bestUtility = utility;
			bestDistToParcel = distToParcel;
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
	decayIntervalMs: number,
	now: number,
): CarryState {
	const ids: string[] = [];
	const rewards: number[] = [];
	for (const p of parcels.values()) {
		if (p.carriedBy !== myId) continue;
		ids.push(p.id);
		rewards.push(currentReward(p, decayIntervalMs, now));
	}
	return { n: ids.length, rewards, nearestDeliveryDist: nearestDeliveryDist(map, bfs), ids };
}

function computeDecayPerStep(decayIntervalMs: number, movementDurationMs: number): number {
	return Number.isFinite(decayIntervalMs) ? movementDurationMs / decayIntervalMs : 0;
}

function nearestDeliveryDist(map: StaticMap, bfs: BfsFromSelf): number {
	let best = Infinity;
	for (const deliveryId of map.deliveryTileIds) {
		const dist = bfs.dist[deliveryId];
		if (dist !== undefined && dist !== -1 && dist < best) best = dist;
	}
	return best;
}

// Saturated decay cost: a parcel with reward R cannot lose more than R over t steps.
function decayCost(reward: number, decayPerStep: number, steps: number): number {
	return Math.min(reward, decayPerStep * steps);
}

// Evaluates whether a mid-carry detour to pick up an additional parcel is worth it.
// Uses the portfolio-aware formula with per-parcel saturation:
//   surplus = R_p_expected − (decay_detour − decay_direct)
// where decay costs are capped at each parcel's current reward.
export function pickBestDetourTarget(
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	carry: CarryState,
	decayIntervalMs: number,
	movementDurationMs: number,
	stealHorizonSteps: number,
	capacity: number,
	epsilon: number,
): ParcelBelief | null {
	if (carry.n >= capacity) return null;
	const now = Date.now();
	const decayPerStep = computeDecayPerStep(decayIntervalMs, movementDurationMs);
	const directDeliveryDist = carry.nearestDeliveryDist;

	const decayDirect = carry.rewards.reduce(
		(sum, reward) => sum + decayCost(reward, decayPerStep, directDeliveryDist),
		0,
	);

	let best: ParcelBelief | null = null;
	let bestSurplus = -Infinity;

	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		const parcelTileId = tileId(map, p.x, p.y);
		const distToParcel = bfs.dist[parcelTileId];
		if (distToParcel === undefined || distToParcel === -1) continue;
		const distParcelToDelivery = map.baseReverseDistToDelivery[parcelTileId];
		if (distParcelToDelivery === undefined || distParcelToDelivery === -1) continue;
		const detourTotalDist = distToParcel + distParcelToDelivery;
		const parcelReward = expectedReward(p, decayIntervalMs, movementDurationMs, stealHorizonSteps, now);
		if (parcelReward <= 0) continue;
		const decayDetour =
			carry.rewards.reduce(
				(sum, reward) => sum + decayCost(reward, decayPerStep, detourTotalDist),
				0,
			) + decayCost(parcelReward, decayPerStep, detourTotalDist);
		const surplus = parcelReward - decayDetour + decayDirect;
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
	selfX: number,
	selfY: number,
	now: number,
	movementDurationMs: number,
): boolean {
	if (!current) return true;

	// Reached target
	if (selfX === current.targetXY.x && selfY === current.targetXY.y) return true;

	// Safety timeout
	const ageSteps = (now - current.committedAt) / movementDurationMs;
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
		const parcel = beliefs.parcels.get(current.targetId);
		if (!parcel || parcel.carriedBy) return true;
	}

	// TODO: expectedUtility currently always 0 at call sites — branch dead until populated.
	// Better candidate appears
	if (
		candidate &&
		candidate.expectedUtility >
			current.expectedUtility + INTENTION_UTILITY_EPSILON
	)
		return true;

	return false;
}
