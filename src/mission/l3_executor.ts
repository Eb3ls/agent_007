import { HYSTERESIS_PCT, STEAL_PROB, parseDecayInterval } from "../config.js";
import type { AgentBus, ConfirmPayload } from "../team/agent_bus.js";
import { inBounds, tileId, type StaticMap } from "../static_map.js";
import { bfsFromSelf, type BfsFromSelf } from "../pathfinder.js";
import type { Coordinator } from "../team/coordinator.js";
import type { BeliefStore } from "../belief_store.js";
import type { GameClient } from "../game_client.js";
import type { MissionRecord } from "./extractor.js";
import { log } from "../logger.js";

export type XY = { x: number; y: number };

// ── Drop-tile feasibility (§5.9) ──────────────────────────────────────────────

/** Returns true if tile has ≥2 walkable, non-occupied free neighbors. */
function hasTwoFreeNeighbors(
	map: StaticMap,
	beliefs: BeliefStore,
	x: number,
	y: number,
): boolean {
	const occupiedXY = new Set<string>();
	for (const a of beliefs.agents.values()) {
		if (a.inView)
			occupiedXY.add(`${Math.round(a.x ?? 0)},${Math.round(a.y ?? 0)}`);
	}
	const DELTAS = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	] as const;
	let free = 0;
	for (const [dx, dy] of DELTAS) {
		const nx = x + dx,
			ny = y + dy;
		if (!inBounds(map, nx, ny)) continue;
		const tile = map.tiles.get(`${nx},${ny}`);
		if (!tile || tile.type === "0") continue;
		if (occupiedXY.has(`${nx},${ny}`)) continue;
		free++;
	}
	return free >= 2;
}

/**
 * Find the best drop-tile D: reachable by both agents, ≥2 free neighbors,
 * not a delivery tile. Returns argmin dist from bfsA.
 * Returns null when no feasible tile found.
 */
export function findDropTile(
	map: StaticMap,
	beliefs: BeliefStore,
	bfsA: BfsFromSelf,
	bfsB: BfsFromSelf,
): XY | null {
	const deliverySet = new Set(map.deliveryTileIds);
	let bestDist = Infinity;
	let best: XY | null = null;

	for (const [, tile] of map.tiles) {
		const id = tileId(map, tile.x, tile.y);
		if (deliverySet.has(id)) continue;
		const dA = bfsA.dist[id];
		const dB = bfsB.dist[id];
		if (dA === undefined || dA < 0) continue;
		if (dB === undefined || dB < 0) continue;
		if (!hasTwoFreeNeighbors(map, beliefs, tile.x, tile.y)) continue;
		if (dA < bestDist) {
			bestDist = dA;
			best = { x: tile.x, y: tile.y };
		}
	}
	return best;
}

// ── Role assignment (§5.9) ───────────────────────────────────────────────────

export type Roles = { carrier: string; receiver: string };

/**
 * carrier = agent closer to any free parcel (bfs dist to nearest parcel).
 * receiver = other agent. tie = lex id.
 */
export function assignRoles(
	map: StaticMap,
	beliefs: BeliefStore,
	posA: XY,
	posB: XY,
	idA: string,
	idB: string,
): Roles | null {
	const bfsA = bfsFromSelf(map, posA.x, posA.y);
	const bfsB = bfsFromSelf(map, posB.x, posB.y);

	let nearestParcelA = Infinity,
		nearestParcelB = Infinity;
	for (const p of beliefs.parcels.values()) {
		if (p.carriedBy) continue;
		const id = tileId(map, p.x, p.y);
		const dA = bfsA.dist[id] ?? -1;
		const dB = bfsB.dist[id] ?? -1;
		if (dA >= 0 && dA < nearestParcelA) nearestParcelA = dA;
		if (dB >= 0 && dB < nearestParcelB) nearestParcelB = dB;
	}

	if (nearestParcelA === Infinity && nearestParcelB === Infinity) return null;

	let carrierId: string, receiverId: string;
	if (
		nearestParcelA < nearestParcelB ||
		(nearestParcelA === nearestParcelB && idA < idB)
	) {
		carrierId = idA;
		receiverId = idB;
	} else {
		carrierId = idB;
		receiverId = idA;
	}

	return { carrier: carrierId, receiver: receiverId };
}

// ── EV formulas (§5.9) ───────────────────────────────────────────────────────

function computeStealRisk(
	decayRate: number,
	M: number,
	serialSteps: number,
	dropTile: XY,
	map: StaticMap,
	beliefs: BeliefStore,
	parkedReward: number,
): number {
	const exposeMs = serialSteps * M;
	const decayTerm = decayRate * exposeMs;
	let hasThreat = false;
	const bfsFromDrop = bfsFromSelf(map, dropTile.x, dropTile.y);
	for (const a of beliefs.agents.values()) {
		if (!a.inView) continue;
		const aId = tileId(map, Math.round(a.x ?? 0), Math.round(a.y ?? 0));
		const d = bfsFromDrop.dist[aId] ?? -1;
		if (d >= 0 && d <= serialSteps) {
			hasThreat = true;
			break;
		}
	}
	return decayTerm + (hasThreat ? STEAL_PROB * parkedReward : 0);
}

export type HandoffParams = {
	missionBonus: number;
	relayReward: number;
	oppRate: number;
	carrierCarryN: number;
	decayRate: number;
	M: number;
	setupSteps: number;
	serialSteps: number;
	dropTile: XY;
	map: StaticMap;
	beliefs: BeliefStore;
	parkedReward: number;
};

export function evalHandoff(p: HandoffParams): number {
	const setupMs = p.setupSteps * p.M;
	const stealRisk = computeStealRisk(
		p.decayRate,
		p.M,
		p.serialSteps,
		p.dropTile,
		p.map,
		p.beliefs,
		p.parkedReward,
	);
	return (
		p.missionBonus +
		p.relayReward -
		p.oppRate * setupMs -
		p.carrierCarryN * p.decayRate * setupMs -
		(p.oppRate + p.carrierCarryN * p.decayRate) * p.M * p.serialSteps -
		stealRisk
	);
}

export type RendezvousParams = {
	missionBonus: number;
	oppRate: number;
	carrierCarryN: number;
	decayRate: number;
	M: number;
	setupSteps: number;
	dropTile: XY;
	map: StaticMap;
	beliefs: BeliefStore;
	parkedReward: number;
};

export function evalRendezvous(p: RendezvousParams): number {
	const setupMs = p.setupSteps * p.M;
	const stealRisk = computeStealRisk(
		p.decayRate,
		p.M,
		1,
		p.dropTile,
		p.map,
		p.beliefs,
		p.parkedReward,
	);
	return (
		p.missionBonus -
		p.oppRate * setupMs -
		p.carrierCarryN * p.decayRate * setupMs -
		stealRisk
	);
}

// ── L3Executor ────────────────────────────────────────────────────────────────

export class L3Executor {
	private running = false;

	constructor(
		private readonly bus: AgentBus,
		private readonly coordinator: Coordinator,
		private readonly beliefs: BeliefStore,
		private readonly map: StaticMap,
		private readonly clientBdi: GameClient,
	) {}

	/**
	 * Attempt to dispatch a handoff or rendezvous job.
	 * Returns false if mutex is busy (caller should defer).
	 */
	dispatch(record: MissionRecord, missionId: string): boolean {
		if (this.running) {
			log.warn(
				"l3_executor",
				`mutex busy — deferring missionId=${missionId}`,
			);
			return false;
		}
		this.running = true;
		void this.execute(record, missionId).finally(() => {
			this.running = false;
		});
		return true;
	}

	private async execute(
		record: MissionRecord,
		missionId: string,
	): Promise<void> {
		const config = this.clientBdi.config;
		if (!config)
			throw new Error(
				"l3_executor: onConfig not received before execute()",
			);
		const M = config.GAME.player.movement_duration;
		const decayIntervalMs = parseDecayInterval(
			config.GAME.parcels.decaying_event,
		);
		const decayRate = decayIntervalMs > 0 ? 1 / decayIntervalMs : 0;
		const oppRate = this.coordinator.getL();
		const missionBonus = record.bonus ?? 0;

		const idA = "bdi",
			idB = "llm";
		const posA = this.coordinator.posOf(idA);
		const posB = this.coordinator.posOf(idB);
		if (!posA || !posB) {
			log.warn("l3_executor", "cannot get agent positions — aborting");
			return;
		}

		const bfsA = bfsFromSelf(this.map, posA.x, posA.y);
		const bfsB = bfsFromSelf(this.map, posB.x, posB.y);

		const roles = assignRoles(this.map, this.beliefs, posA, posB, idA, idB);
		if (!roles) {
			log.warn(
				"l3_executor",
				"no free parcels for role assignment — aborting",
			);
			return;
		}

		const dropTile = findDropTile(this.map, this.beliefs, bfsA, bfsB);
		if (!dropTile) {
			log.warn("l3_executor", "no feasible drop-tile — aborting");
			return;
		}

		const bfsCarrier = roles.carrier === idA ? bfsA : bfsB;
		const dropTileId = tileId(this.map, dropTile.x, dropTile.y);
		const setupSteps = Math.max(bfsCarrier.dist[dropTileId] ?? 0, 0);
		const serialSteps = 1;

		const carrierCarry = this.coordinator.carryOf(roles.carrier);
		if (!carrierCarry) {
			log.warn(
				"l3_executor",
				"cannot get carrier carry state — aborting",
			);
			return;
		}

		let ev: number;
		if (record.opType === "handoff") {
			const relayReward =
				carrierCarry.reward *
				Math.max(0, 1 - decayRate * M * setupSteps);
			ev = evalHandoff({
				missionBonus,
				relayReward,
				oppRate,
				carrierCarryN: carrierCarry.count,
				decayRate,
				M,
				setupSteps,
				serialSteps,
				dropTile,
				map: this.map,
				beliefs: this.beliefs,
				parkedReward: relayReward,
			});
		} else {
			ev = evalRendezvous({
				missionBonus,
				oppRate,
				carrierCarryN: carrierCarry.count,
				decayRate,
				M,
				setupSteps,
				dropTile,
				map: this.map,
				beliefs: this.beliefs,
				parkedReward: carrierCarry.reward,
			});
		}

		const threshold = HYSTERESIS_PCT * Math.abs(missionBonus);
		if (ev <= threshold) {
			log.info(
				"l3_executor",
				`EV=${ev.toFixed(1)} ≤ threshold=${threshold.toFixed(1)} — not dispatching`,
			);
			return;
		}

		log.info(
			"l3_executor",
			`dispatching ${record.opType} carrier=${roles.carrier} receiver=${roles.receiver} drop=(${dropTile.x},${dropTile.y}) EV=${ev.toFixed(1)}`,
		);

		this.bus.emitDirective(roles.carrier, {
			kind: "OVERRIDE",
			op: "STAGE",
			target: [dropTile],
			thenAct: "putDown",
			missionId,
		});
		this.bus.emitDirective(roles.receiver, {
			kind: "OVERRIDE",
			op: "STAGE",
			target: [dropTile],
			thenAct: "pickUp",
			missionId,
		});

		try {
			await this.waitForConfirm(missionId, roles.carrier, "dropped");
			log.info(
				"l3_executor",
				`carrier dropped at drop-tile missionId=${missionId}`,
			);
			await this.waitForConfirm(missionId, roles.receiver, "reached");
			log.info(
				"l3_executor",
				`receiver picked up missionId=${missionId}`,
			);
		} catch (err) {
			log.warn(
				"l3_executor",
				`CONFIRM timeout — aborting missionId=${missionId}: ${String(err)}`,
			);
			return;
		}

		const scope =
			record.target === "both"
				? ("global" as const)
				: ("per-agent" as const);
		this.bus.emitRelease({ missionId, scope });
		log.info(
			"l3_executor",
			`${record.opType} complete — RELEASE missionId=${missionId}`,
		);
	}

	private waitForConfirm(
		missionId: string,
		agentId: string,
		expectedResult: ConfirmPayload["result"],
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeoutMs = 60_000;
			const timer = setTimeout(() => {
				this.bus.off("CONFIRM", handler);
				reject(
					new Error(
						`l3 timeout waiting for ${agentId} CONFIRM missionId=${missionId}`,
					),
				);
			}, timeoutMs);

			const handler = (payload: ConfirmPayload) => {
				if (payload.missionId !== missionId) return;
				if (payload.agentId !== agentId) return;
				if (payload.result !== expectedResult) return;
				clearTimeout(timer);
				this.bus.off("CONFIRM", handler);
				resolve();
			};
			this.bus.on("CONFIRM", handler);
		});
	}
}
