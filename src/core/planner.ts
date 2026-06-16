import {
	beliefTrust,
	competitorWeight,
	type AgentBelief,
	type BeliefStore,
	type ParcelBelief,
} from "../belief_store.js";
import {
	reconstructPath,
	type BfsFromSelf,
	type Direction,
} from "../pathfinder.js";
import {
	TILE,
	idToXY,
	inBounds,
	tileId,
	type StaticMap,
} from "../static_map.js";
import { cfg } from "../config.js";

// In-view agents always block; out-of-view ones block only while last-seen belief retains trust ≥ 0.5.
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
	return trust >= cfg.belief.agent_blocking_trust_threshold;
}

export function computeBlockedTiles(
	map: StaticMap,
	beliefs: BeliefStore,
	movementDurationMs: number,
	graceSteps: number = cfg.belief.agent_grace_steps,
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

// Crate-slide tiles ("5"/"5!") that currently hold no crate, per belief.
//
// These are walkable floor right now — a crate was pushed off (or never sat
// there) — but canMoveForward blocks crate tiles by static type. Pass this set
// to bfsFromSelf so plain BFS can route through a path that opened up. Backed by
// crateOccupancy, which is seeded from the spawn rule, so unobserved "5!" tiles
// are treated as blocked (not optimistically walkable) until seen empty.
export function passableCrateTileSet(
	map: StaticMap,
	beliefs: BeliefStore,
): Set<number> {
	const passable = new Set<number>();
	for (const t of map.tiles.values()) {
		if (t.type !== TILE.CRATE_SLIDE && t.type !== TILE.CRATE_SLIDE_MOVING)
			continue;
		const id = tileId(map, t.x, t.y);
		if (!beliefs.crateOccupancy.has(id)) passable.add(id);
	}
	return passable;
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

type CompetitorPenaltyConfig = {
	beliefs: BeliefStore;
	now: number;
	movementDurationMs: number;
};

// Prefers spawns that minimize walk + delivery distance + competitor presence,
// skipping tiles in current FOV or recently observed empty.
export function nearestOutOfViewSpawn(
	map: StaticMap,
	bfs: BfsFromSelf,
	selfX: number,
	selfY: number,
	observationDistance: number,
	observedEmptySpawnIds?: ReadonlySet<number>,
	competitorPenalty?: CompetitorPenaltyConfig,
): { x: number; y: number } | null {
	let bestId = -1;
	let bestCost = Infinity;
	for (const spawnId of map.spawnTileIds) {
		const distToSpawn = bfs.dist[spawnId];
		if (distToSpawn === undefined || distToSpawn === -1) continue;
		const distSpawnToDelivery = map.baseReverseDistToDelivery[spawnId];
		if (distSpawnToDelivery === undefined || distSpawnToDelivery === -1)
			continue;
		if (observedEmptySpawnIds?.has(spawnId)) continue;
		const { x, y } = idToXY(map, spawnId);
		if (Math.abs(x - selfX) + Math.abs(y - selfY) <= observationDistance)
			continue;

		let cost = distToSpawn + distSpawnToDelivery;
		if (competitorPenalty) {
			const { beliefs, now, movementDurationMs } = competitorPenalty;
			cost +=
				cfg.explore.competitor_penalty_alpha *
				competitorWeight(beliefs, x, y, now, movementDurationMs);
		}
		if (cost < bestCost) {
			bestCost = cost;
			bestId = spawnId;
		}
	}
	return bestId === -1 ? null : idToXY(map, bestId);
}

// Roaming fallback when no spawn target is available.
// Prefers the nearest reachable non-visible tile so exploration keeps moving instead of idling.
export function nearestRoamTarget(
	map: StaticMap,
	bfs: BfsFromSelf,
	selfX: number,
	selfY: number,
	observationDistance: number,
): { x: number; y: number } | null {
	let bestId = -1;
	let bestDist = Infinity;
	let bestVisibleId = -1;
	let bestVisibleDist = Infinity;

	for (const tile of map.tiles.values()) {
		if (tile.type === TILE.EMPTY) continue;

		const id = tileId(map, tile.x, tile.y);
		const dist = bfs.dist[id];
		if (dist === undefined || dist === -1 || dist === 0) continue;

		if (
			Math.abs(tile.x - selfX) + Math.abs(tile.y - selfY) <=
			observationDistance
		) {
			if (dist < bestVisibleDist) {
				bestVisibleDist = dist;
				bestVisibleId = id;
			}
			continue;
		}

		if (dist < bestDist) {
			bestDist = dist;
			bestId = id;
		}
	}

	const chosenId = bestId !== -1 ? bestId : bestVisibleId;
	return chosenId === -1 ? null : idToXY(map, chosenId);
}

// True when standing on a delivery tile (dist=0) while carrying at least one parcel.
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

// In-view parcels report current value as-is; out-of-view ones decay by floor(elapsedMs / decayIntervalMs).
export function currentReward(
	p: ParcelBelief,
	decayIntervalMs: number,
	now: number,
): number {
	if (!Number.isFinite(decayIntervalMs)) return p.reward;
	if (p.inView) return p.reward;
	return Math.max(
		0,
		p.reward - Math.floor((now - p.lastSeenAt) / decayIntervalMs),
	);
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

// P_steal for one competitor: grows with its tile advantage over self,
// weighted by belief trust so uncertain positions contribute proportionally.
// Uses Manhattan distance as approximation (no per-competitor BFS needed).
export function computeContestFactor(
	beliefs: BeliefStore,
	parcelX: number,
	parcelY: number,
	distSelf: number,
	movementDurationMs: number,
	now: number,
): number {
	let maxSteal = 0;
	for (const agent of beliefs.agents.values()) {
		if (agent.x === undefined || agent.y === undefined) continue;
		const trust = beliefTrust(
			agent.confidence,
			agent.lastSeenAt,
			now,
			movementDurationMs * cfg.belief.agent_grace_steps,
			agent.inView,
		);
		if (trust < 0.05) continue;
		const distComp =
			Math.abs(Math.round(agent.x) - parcelX) +
			Math.abs(Math.round(agent.y) - parcelY);
		const margin = distSelf - distComp; // positive = competitor closer
		if (margin <= 0) continue;
		const pSteal = trust * (1 - Math.exp(-margin / cfg.race.horizon_steps));
		if (pSteal > maxSteal) maxSteal = pSteal;
	}
	return maxSteal;
}

// Returns the best parcel to target, with absolute pickup utility.
// When empty (carry.n === 0): utility = parcel net value after decay to delivery.
// When carrying: utility = total portfolio value (all carried + new parcel) after
// taking the detour path self → parcel → delivery.
export function pickBestParcelTarget(
	map: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	decayIntervalMs: number,
	movementDurationMs: number,
	carry: CarryState,
	stealHorizonSteps: number = cfg.belief.expected_steal_horizon_steps,
	excludedParcelIds?: ReadonlySet<string>,
): PickResult | null {
	const now = Date.now();
	const decayPerStep = computeDecayPerStep(
		decayIntervalMs,
		movementDurationMs,
	);
	let best: ParcelBelief | null = null;
	let bestUtility = -Infinity;
	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		if (excludedParcelIds?.has(p.id)) continue;
		const parcelTileId = tileId(map, p.x, p.y);
		const distToParcel = bfs.dist[parcelTileId];
		if (distToParcel === undefined || distToParcel === -1) continue;
		const distParcelToDelivery =
			map.baseReverseDistToDelivery[parcelTileId];
		if (distParcelToDelivery === undefined || distParcelToDelivery === -1)
			continue;

		const totalDist = distToParcel + distParcelToDelivery;
		const parcelReward =
			expectedReward(
				p,
				decayIntervalMs,
				movementDurationMs,
				stealHorizonSteps,
				now,
			) *
			(1 -
				computeContestFactor(
					beliefs,
					p.x,
					p.y,
					distToParcel,
					movementDurationMs,
					now,
				));
		if (parcelReward <= 0) continue;
		const parcelNet =
			parcelReward - decayCost(parcelReward, decayPerStep, totalDist);
		if (parcelNet <= 0) continue;

		let utility: number;
		if (carry.n === 0) {
			utility = parcelNet;
		} else {
			utility =
				computeDeliverUtility(carry.rewards, decayPerStep, totalDist) +
				parcelNet;
		}

		if (utility > bestUtility) {
			bestUtility = utility;
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

// Returns 0 when decayInterval is non-finite (game configured without decay).
export function computeDecayPerStep(
	decayIntervalMs: number,
	movementDurationMs: number,
): number {
	return Number.isFinite(decayIntervalMs)
		? movementDurationMs / decayIntervalMs
		: 0;
}

function nearestDeliveryDist(map: StaticMap, bfs: BfsFromSelf): number {
	const tile = nearestDeliveryTile(map, bfs);
	if (!tile) return Infinity;
	return bfs.dist[tileId(map, tile.x, tile.y)] ?? Infinity;
}

// Saturated decay cost: a parcel with reward R cannot lose more than R over t steps.
export function decayCost(
	reward: number,
	decayPerStep: number,
	steps: number,
): number {
	return Math.min(reward, decayPerStep * steps);
}

// Net portfolio value when delivering from dist steps away (per-parcel saturated decay).
export function computeDeliverUtility(
	rewards: number[],
	decayPerStep: number,
	dist: number,
): number {
	return rewards.reduce(
		(s, r) => s + r - decayCost(r, decayPerStep, dist),
		0,
	);
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
