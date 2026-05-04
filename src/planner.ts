import {
	reconstructPath,
	type BfsFromSelf,
	type Direction,
} from "./pathfinder.js";
import {
	beliefTrust,
	type AgentBelief,
	type BeliefStore,
	type ParcelBelief,
} from "./belief_store.js";
import { AGENT_GRACE_STEPS, EXPECTED_STEAL_HORIZON_STEPS } from "./config.js";
import { idToXY, inBounds, tileId, type StaticMap } from "./static_map.js";

export function isAgentBlocking(
	agent: AgentBelief,
	movementDurationMs: number,
	graceSteps: number,
	now: number,
): boolean {
	if (agent.inView) return true;
	const trust = beliefTrust(
		agent.confidence,
		agent.lastSeenAt,
		now,
		movementDurationMs * graceSteps,
		agent.inView,
	);
	return trust >= 0.5;
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
		if (!isAgentBlocking(agent, movementDurationMs, graceSteps, now))
			continue;
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
		if (distSpawnToDelivery === undefined || distSpawnToDelivery === -1)
			continue;
		if (visitedSpawnIds?.has(spawnId)) continue;
		const { x, y } = idToXY(map, spawnId);
		if (Math.abs(x - selfX) + Math.abs(y - selfY) <= observationDistance)
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
		if (parcel.x === selfX && parcel.y === selfY && !parcel.carriedBy)
			return parcel;
	}
	return undefined;
}

export function currentReward(
	p: ParcelBelief,
	decayIntervalMs: number,
	now: number,
): number {
	if (!Number.isFinite(decayIntervalMs)) return p.reward;
	if (p.inView) return p.reward;
	return p.reward - Math.floor((now - p.lastSeenAt) / decayIntervalMs);
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
	return (
		base *
		beliefTrust(
			p.confidence,
			p.lastSeenAt,
			now,
			movementDurationMs * stealHorizonSteps,
			p.inView,
		)
	);
}

export type PickResult = { parcel: ParcelBelief; utility: number };

export function pickBestParcelTarget(
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	decayIntervalMs: number,
	movementDurationMs: number,
	stealHorizonSteps: number = EXPECTED_STEAL_HORIZON_STEPS,
): PickResult | null {
	const now = Date.now();
	const decayPerStep = computeDecayPerStep(
		decayIntervalMs,
		movementDurationMs,
	);
	let best: ParcelBelief | null = null;
	let bestUtility = -Infinity;
	let bestDistToParcel = Infinity;
	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		const parcelTileId = tileId(map, p.x, p.y);
		const distToParcel = bfs.dist[parcelTileId];
		if (distToParcel === undefined || distToParcel === -1) continue;
		const distParcelToDelivery =
			map.baseReverseDistToDelivery[parcelTileId];
		if (distParcelToDelivery === undefined || distParcelToDelivery === -1)
			continue;
		const reward = expectedReward(
			p,
			decayIntervalMs,
			movementDurationMs,
			stealHorizonSteps,
			now,
		);
		if (reward <= 0) continue;
		const utility =
			reward - decayPerStep * (distToParcel + distParcelToDelivery);
		if (utility <= 0) continue;
		if (
			utility > bestUtility ||
			(utility === bestUtility && distToParcel < bestDistToParcel)
		) {
			bestUtility = utility;
			bestDistToParcel = distToParcel;
			best = p;
		}
	}
	return best ? { parcel: best, utility: bestUtility } : null;
}

export type CarryState = {
	n: number;
	rewards: number[];
	nearestDeliveryDist: number;
	ids: string[];
};

// Derives carry state from beliefs.parcels (authoritative for carriedBy).
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
	return {
		n: ids.length,
		rewards,
		nearestDeliveryDist: nearestDeliveryDist(map, bfs),
		ids,
	};
}

function computeDecayPerStep(
	decayIntervalMs: number,
	movementDurationMs: number,
): number {
	return Number.isFinite(decayIntervalMs)
		? movementDurationMs / decayIntervalMs
		: 0;
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
function decayCost(
	reward: number,
	decayPerStep: number,
	steps: number,
): number {
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
): PickResult | null {
	if (carry.n >= capacity) return null;
	const now = Date.now();
	const decayPerStep = computeDecayPerStep(
		decayIntervalMs,
		movementDurationMs,
	);
	const directDeliveryDist = carry.nearestDeliveryDist;

	const decayDirect = carry.rewards.reduce(
		(sum, reward) =>
			sum + decayCost(reward, decayPerStep, directDeliveryDist),
		0,
	);

	let best: ParcelBelief | null = null;
	let bestSurplus = -Infinity;

	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		const parcelTileId = tileId(map, p.x, p.y);
		const distToParcel = bfs.dist[parcelTileId];
		if (distToParcel === undefined || distToParcel === -1) continue;
		const distParcelToDelivery =
			map.baseReverseDistToDelivery[parcelTileId];
		if (distParcelToDelivery === undefined || distParcelToDelivery === -1)
			continue;
		const detourTotalDist = distToParcel + distParcelToDelivery;
		const parcelReward = expectedReward(
			p,
			decayIntervalMs,
			movementDurationMs,
			stealHorizonSteps,
			now,
		);
		if (parcelReward <= 0) continue;
		const decayDetour =
			carry.rewards.reduce(
				(sum, reward) =>
					sum + decayCost(reward, decayPerStep, detourTotalDist),
				0,
			) + decayCost(parcelReward, decayPerStep, detourTotalDist);
		const surplus = parcelReward - decayDetour + decayDirect;
		if (surplus > epsilon && surplus > bestSurplus) {
			bestSurplus = surplus;
			best = p;
		}
	}
	return best ? { parcel: best, utility: bestSurplus } : null;
}

export function buildPlan(
	map: StaticMap,
	bfs: BfsFromSelf,
	targetX: number,
	targetY: number,
): Direction[] {
	return reconstructPath(map, bfs, targetX, targetY) ?? [];
}

// Returns false if the next planned step leads into a currently blocked tile.
export function isSoundPlan(
	plan: Direction[],
	selfX: number,
	selfY: number,
	map: StaticMap,
	blocked: ReadonlySet<number>,
): boolean {
	if (plan.length === 0) return false;
	const dir = plan[0]!;
	const nx = selfX + (dir === "right" ? 1 : dir === "left" ? -1 : 0);
	const ny = selfY + (dir === "up" ? 1 : dir === "down" ? -1 : 0);
	if (!inBounds(map, nx, ny)) return false;
	return !blocked.has(tileId(map, nx, ny));
}
