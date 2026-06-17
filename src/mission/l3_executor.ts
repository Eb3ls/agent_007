import { DIRS, inBounds, tileId, TILE, type StaticMap } from "../static_map.js";
import type { AgentBus, ConfirmPayload } from "../team/agent_bus.js";
import { bfsFromSelf, type BfsFromSelf } from "../pathfinder.js";
import type { Coordinator } from "../team/coordinator.js";
import { cfg, parseDecayInterval } from "../config.js";
import type { BeliefStore } from "../belief_store.js";
import type { GameClient } from "../game_client.js";
import type { MissionRecord } from "./extractor.js";
import { scopeOf } from "../team/directives.js";
import { log } from "../logger.js";

export type XY = { x: number; y: number };

const AGENT_BDI = "bdi";
const AGENT_LLM = "llm";
// rendezvous agents converge in one relay step; no sequential handoff phase
const RENDEZVOUS_SERIAL_STEPS = 1;
const CONFIRM_TIMEOUT_MS = 60_000;
const RENDEZVOUS_MAX_DIST = 3;

// ── Drop-tile feasibility ──────────────────────────────────────────────────────

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
	let free = 0;
	for (const [dx, dy] of DIRS) {
		const nx = x + dx,
			ny = y + dy;
		if (!inBounds(map, nx, ny)) continue;
		const tile = map.tiles.get(`${nx},${ny}`);
		if (!tile || tile.type === TILE.EMPTY) continue;
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

/**
 * Returns all walkable tiles reachable from `target` within `maxDist` BFS steps.
 * If `target` is not a walkable tile, returns an empty array.
 */
export function findRendezvousTiles(
	map: StaticMap,
	target: XY,
	maxDist: number,
): XY[] {
	const bfs = bfsFromSelf(map, target.x, target.y);
	const tiles: XY[] = [];
	for (const [, tile] of map.tiles) {
		const id = tileId(map, tile.x, tile.y);
		const d = bfs.dist[id];
		if (d !== undefined && d >= 0 && d <= maxDist) {
			tiles.push({ x: tile.x, y: tile.y });
		}
	}
	return tiles;
}

// ── Role assignment ───────────────────────────────────────────────────────────

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

// ── EV formulas ───────────────────────────────────────────────────────────────

type StealRiskParams = {
	decayRate: number;
	M: number;
	serialSteps: number;
	dropTile: XY;
	map: StaticMap;
	beliefs: BeliefStore;
	parkedReward: number;
};

// Steal risk = decay during exposure at the drop tile + probability that a nearby
// competitor reaches the tile and steals the parcel before the receiver picks it up.
function computeStealRisk(p: StealRiskParams): number {
	const exposeMs = p.serialSteps * p.M;
	const decayTerm = p.decayRate * exposeMs;
	let hasThreat = false;
	const bfsFromDrop = bfsFromSelf(p.map, p.dropTile.x, p.dropTile.y);
	for (const a of p.beliefs.agents.values()) {
		if (!a.inView) continue;
		const aId = tileId(p.map, Math.round(a.x ?? 0), Math.round(a.y ?? 0));
		const d = bfsFromDrop.dist[aId] ?? -1;
		if (d >= 0 && d <= p.serialSteps) {
			hasThreat = true;
			break;
		}
	}
	return (
		decayTerm + (hasThreat ? cfg.intention.steal_prob * p.parkedReward : 0)
	);
}

type BaseEvParams = {
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

export type HandoffParams = BaseEvParams & {
	relayReward: number;
	serialSteps: number;
};
export type RendezvousParams = BaseEvParams;

// EV of a handoff = mission bonus + relay reward the receiver earns at delivery
// minus carrier opportunity cost, decay on carried parcels during setup, and steal risk.
export function evalHandoff(p: HandoffParams): number {
	const setupMs = p.setupSteps * p.M;
	const stealRisk = computeStealRisk({
		decayRate: p.decayRate,
		M: p.M,
		serialSteps: p.serialSteps,
		dropTile: p.dropTile,
		map: p.map,
		beliefs: p.beliefs,
		parkedReward: p.parkedReward,
	});
	return (
		p.missionBonus +
		p.relayReward -
		p.oppRate * setupMs -
		p.carrierCarryN * p.decayRate * setupMs -
		(p.oppRate + p.carrierCarryN * p.decayRate) * p.M * p.serialSteps -
		stealRisk
	);
}

// EV of a rendezvous = mission bonus minus opportunity cost and decay during
// setup; no relay reward because neither agent delivers for the other.
export function evalRendezvous(p: RendezvousParams): number {
	const setupMs = p.setupSteps * p.M;
	const stealRisk = computeStealRisk({
		decayRate: p.decayRate,
		M: p.M,
		serialSteps: RENDEZVOUS_SERIAL_STEPS,
		dropTile: p.dropTile,
		map: p.map,
		beliefs: p.beliefs,
		parkedReward: p.parkedReward,
	});
	return (
		p.missionBonus -
		p.oppRate * setupMs -
		p.carrierCarryN * p.decayRate * setupMs -
		stealRisk
	);
}

// ── L3Executor ────────────────────────────────────────────────────────────────

type EvContext = {
	M: number;
	decayRate: number;
	oppRate: number;
};

type HandoffSite = {
	roles: Roles;
	dropTile: XY;
	setupSteps: number;
	carrierCarry: { count: number; reward: number };
};

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
		if (record.opType === "rendezvous") {
			await this.executeRendezvous(record, missionId);
		} else {
			await this.executeHandoff(record, missionId);
		}
	}

	private async executeHandoff(
		record: MissionRecord,
		missionId: string,
	): Promise<void> {
		const ctx = this.resolveContext();

		const site = this.selectHandoffSite();
		if (!site) return;

		const missionBonus = record.bonus ?? 0;
		const ev = this.computeEV(record, ctx, site, missionBonus);
		// Hysteresis: only dispatch if EV exceeds a fraction of the mission bonus,
		// preventing oscillation when EV is marginally positive.
		const threshold = cfg.intention.hysteresis_pct * Math.abs(missionBonus);
		if (ev <= threshold) {
			log.info(
				"l3_executor",
				`EV=${ev.toFixed(1)} ≤ threshold=${threshold.toFixed(1)} — not dispatching`,
			);
			return;
		}

		log.info(
			"l3_executor",
			`dispatching ${record.opType} carrier=${site.roles.carrier} receiver=${site.roles.receiver} drop=(${site.dropTile.x},${site.dropTile.y}) EV=${ev.toFixed(1)}`,
		);
		this.emitDirectives(site.roles, site.dropTile, missionId);

		try {
			await this.awaitHandshake(missionId, site.roles);
		} catch (err) {
			log.warn(
				"l3_executor",
				`CONFIRM timeout — aborting missionId=${missionId}: ${String(err)}`,
			);
			return;
		}

		const scope = scopeOf(record.target);
		this.bus.emitRelease({ missionId, scope });
		log.info(
			"l3_executor",
			`${record.opType} complete — RELEASE missionId=${missionId}`,
		);
	}

	// Moves both agents to any tile within RENDEZVOUS_MAX_DIST of the target and
	// waits for both to confirm arrival before releasing the mission.
	private async executeRendezvous(
		record: MissionRecord,
		missionId: string,
	): Promise<void> {
		const target = record.selector.coords?.[0];
		if (!target) {
			log.warn(
				"l3_executor",
				`rendezvous: no target coords in record — aborting missionId=${missionId}`,
			);
			return;
		}

		const posA = this.coordinator.posOf(AGENT_BDI);
		const posB = this.coordinator.posOf(AGENT_LLM);
		if (!posA || !posB) {
			log.warn(
				"l3_executor",
				"rendezvous: cannot get agent positions — aborting",
			);
			return;
		}

		const nearbyTiles = findRendezvousTiles(
			this.map,
			target,
			RENDEZVOUS_MAX_DIST,
		);
		if (nearbyTiles.length === 0) {
			log.warn(
				"l3_executor",
				`rendezvous: no walkable tiles near (${target.x},${target.y}) — aborting missionId=${missionId}`,
			);
			return;
		}

		const ctx = this.resolveContext();
		const bfsA = bfsFromSelf(this.map, posA.x, posA.y);
		const bfsB = bfsFromSelf(this.map, posB.x, posB.y);

		const minDistA = nearbyTiles.reduce((min, t) => {
			const d = bfsA.dist[tileId(this.map, t.x, t.y)] ?? -1;
			return d >= 0 && d < min ? d : min;
		}, Infinity);
		const minDistB = nearbyTiles.reduce((min, t) => {
			const d = bfsB.dist[tileId(this.map, t.x, t.y)] ?? -1;
			return d >= 0 && d < min ? d : min;
		}, Infinity);

		if (minDistA === Infinity && minDistB === Infinity) {
			log.warn(
				"l3_executor",
				`rendezvous: neighborhood unreachable by both agents — aborting missionId=${missionId}`,
			);
			return;
		}

		const setupSteps = Math.max(
			minDistA === Infinity ? 0 : minDistA,
			minDistB === Infinity ? 0 : minDistB,
		);
		const missionBonus = record.bonus ?? 0;
		const carryA = this.coordinator.carryOf(AGENT_BDI) ?? {
			count: 0,
			reward: 0,
		};

		const ev = evalRendezvous({
			missionBonus,
			oppRate: ctx.oppRate,
			carrierCarryN: carryA.count,
			decayRate: ctx.decayRate,
			M: ctx.M,
			setupSteps,
			dropTile: target,
			map: this.map,
			beliefs: this.beliefs,
			parkedReward: 0,
		});

		const threshold = cfg.intention.hysteresis_pct * Math.abs(missionBonus);
		if (ev <= threshold) {
			log.info(
				"l3_executor",
				`rendezvous EV=${ev.toFixed(1)} ≤ threshold=${threshold.toFixed(1)} — not dispatching missionId=${missionId}`,
			);
			return;
		}

		log.info(
			"l3_executor",
			`dispatching rendezvous to (${target.x},${target.y}) tiles=${nearbyTiles.length} EV=${ev.toFixed(1)} missionId=${missionId}`,
		);

		this.bus.emitDirective(AGENT_BDI, {
			kind: "OVERRIDE",
			op: "STAGE",
			target: nearbyTiles,
			missionId,
		});
		this.bus.emitDirective(AGENT_LLM, {
			kind: "OVERRIDE",
			op: "STAGE",
			target: nearbyTiles,
			missionId,
		});

		try {
			await this.awaitBothReachedAndHold(missionId);
		} catch (err) {
			log.warn(
				"l3_executor",
				`rendezvous CONFIRM timeout — aborting missionId=${missionId}: ${String(err)}`,
			);
			return;
		}

		const scope = scopeOf(record.target);
		this.bus.emitRelease({ missionId, scope });
		log.info(
			"l3_executor",
			`rendezvous complete — RELEASE missionId=${missionId}`,
		);
	}

	// Reads game config and returns movement duration, parcel decay rate, and opportunity cost rate.
	private resolveContext(): EvContext {
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
		return { M, decayRate, oppRate };
	}

	// Runs BFS from both agent positions, assigns carrier/receiver roles, finds the best
	// drop tile, and returns carrier travel distance and current carry state.
	private selectHandoffSite(): HandoffSite | null {
		const posA = this.coordinator.posOf(AGENT_BDI);
		const posB = this.coordinator.posOf(AGENT_LLM);
		if (!posA || !posB) {
			log.warn("l3_executor", "cannot get agent positions — aborting");
			return null;
		}

		const bfsA = bfsFromSelf(this.map, posA.x, posA.y);
		const bfsB = bfsFromSelf(this.map, posB.x, posB.y);

		const roles = assignRoles(
			this.map,
			this.beliefs,
			posA,
			posB,
			AGENT_BDI,
			AGENT_LLM,
		);
		if (!roles) {
			log.warn(
				"l3_executor",
				"no free parcels for role assignment — aborting",
			);
			return null;
		}

		const dropTile = findDropTile(this.map, this.beliefs, bfsA, bfsB);
		if (!dropTile) {
			log.warn("l3_executor", "no feasible drop-tile — aborting");
			return null;
		}

		const bfsCarrier = roles.carrier === AGENT_BDI ? bfsA : bfsB;
		const dropTileId = tileId(this.map, dropTile.x, dropTile.y);
		const setupSteps = Math.max(bfsCarrier.dist[dropTileId] ?? 0, 0);

		const carrierCarry = this.coordinator.carryOf(roles.carrier);
		if (!carrierCarry) {
			log.warn(
				"l3_executor",
				"cannot get carrier carry state — aborting",
			);
			return null;
		}

		return { roles, dropTile, setupSteps, carrierCarry };
	}

	// Computes the expected value of a handoff or rendezvous: mission bonus minus
	// opportunity cost, decay loss during setup, and steal risk at the drop tile.
	private computeEV(
		record: MissionRecord,
		ctx: EvContext,
		site: HandoffSite,
		missionBonus: number,
	): number {
		const { M, decayRate, oppRate } = ctx;
		const { dropTile, setupSteps, carrierCarry } = site;
		if (record.opType === "handoff") {
			const relayReward =
				carrierCarry.reward *
				Math.max(0, 1 - decayRate * M * setupSteps);
			return evalHandoff({
				missionBonus,
				relayReward,
				oppRate,
				carrierCarryN: carrierCarry.count,
				decayRate,
				M,
				setupSteps,
				serialSteps: RENDEZVOUS_SERIAL_STEPS,
				dropTile,
				map: this.map,
				beliefs: this.beliefs,
				parkedReward: relayReward,
			});
		} else {
			return evalRendezvous({
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
	}

	// Sends STAGE directives to the carrier (putDown) and receiver (pickUp) at the drop tile.
	private emitDirectives(
		roles: Roles,
		dropTile: XY,
		missionId: string,
	): void {
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
	}

	// Waits for both agents to confirm "reached", pausing each immediately on arrival
	// so neither wanders off before the second one gets there.
	private awaitBothReachedAndHold(missionId: string): Promise<void> {
		return new Promise((resolve, reject) => {
			let confirmedCount = 0;
			const timer = setTimeout(() => {
				this.bus.off("CONFIRM", handler);
				reject(
					new Error(
						`l3 rendezvous timeout waiting for both agents missionId=${missionId}`,
					),
				);
			}, CONFIRM_TIMEOUT_MS);

			const handler = (payload: ConfirmPayload) => {
				if (payload.missionId !== missionId) return;
				if (payload.result !== "reached") return;
				confirmedCount++;
				if (confirmedCount === 1) {
					// First to arrive: hold in place until the other gets here.
					// RELEASE (emitted after the second confirm) will clear this pause.
					this.bus.emitDirective(payload.agentId, {
						kind: "OVERRIDE",
						op: "PAUSE",
						missionId,
					});
				} else {
					// Second to arrive: resolve immediately — no PAUSE needed because
					// RELEASE is emitted synchronously by the caller before this agent's
					// next tick, so there is nothing to un-pause.
					clearTimeout(timer);
					this.bus.off("CONFIRM", handler);
					resolve();
				}
			};
			this.bus.on("CONFIRM", handler);
		});
	}

	// Waits for the carrier to confirm it dropped, then waits for the receiver to confirm
	// it reached the drop tile. Order is enforced: carrier must drop before receiver picks up.
	private async awaitHandshake(
		missionId: string,
		roles: Roles,
	): Promise<void> {
		await this.waitForConfirm(missionId, roles.carrier, "dropped");
		log.info(
			"l3_executor",
			`carrier dropped at drop-tile missionId=${missionId}`,
		);
		await this.waitForConfirm(missionId, roles.receiver, "reached");
		log.info("l3_executor", `receiver picked up missionId=${missionId}`);
	}

	private waitForConfirm(
		missionId: string,
		agentId: string,
		expectedResult: ConfirmPayload["result"],
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.bus.off("CONFIRM", handler);
				reject(
					new Error(
						`l3 timeout waiting for ${agentId} CONFIRM missionId=${missionId}`,
					),
				);
			}, CONFIRM_TIMEOUT_MS);

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
