import {
	buildPlan,
	computeBlockedTiles,
	deriveCarryState,
	isSoundPlan,
	parcelHere,
	passableCrateTileSet,
	shouldDrop,
	sumRewards,
	type CarryState,
} from "./planner.js";
import {
	parcelCapEffect,
	batchCandidates,
	carryValue,
	maxBatchScore,
	scoreDeliver,
	type CrossCtx,
	type ValuatorMetrics,
} from "./valuator.js";
import {
	applyDelivery,
	applyPickupResult,
	clearUncarriedParcelsAt,
	topCompetitorTiles,
	type BeliefStore,
} from "../belief_store.js";
import {
	buildPlanWithCrateHandling,
	createCratePlannerContext,
	type CratePlannerContext,
} from "../mission/crate_planner.js";
import {
	checkIntentionViability,
	shouldReconsider,
	shouldReconsiderPDDLForParcel,
} from "./reconsider.js";
import {
	DirectiveHandler,
	type ActiveDirectives,
	type PredicateToken,
} from "../team/directives.js";
import {
	TILE,
	tileId,
	idToXY,
	spawnsWithinRadius,
	type StaticMap,
} from "../static_map.js";
import {
	bfsFromSelf,
	type BfsFromSelf,
	type Direction,
} from "../pathfinder.js";
import { cfg as appCfg, parseDecayInterval } from "../config.js";
import type { Coordinator } from "../team/coordinator.js";
import type { AgentBus } from "../team/agent_bus.js";
import type { GameClient } from "../game_client.js";
import type { Intention } from "./intention.js";
import { deliberate } from "./deliberation.js";
import { makeIntention } from "./intention.js";
import { log } from "../logger.js";

export function resolvePredicateTokens(
	tokens: PredicateToken[],
	map: StaticMap,
): { x: number; y: number }[] {
	if (tokens.includes("center")) {
		const cx = map.minX + Math.floor(map.gridWidth / 2);
		const cy = map.minY + Math.floor(map.gridHeight / 2);
		const tile = map.tiles.get(`${cx},${cy}`);
		if (!tile || tile.type === TILE.EMPTY) return [];
		return [{ x: cx, y: cy }];
	}

	let result: { x: number; y: number }[] = [];
	for (const [, t] of map.tiles) {
		if (t.type !== TILE.EMPTY) result.push({ x: t.x, y: t.y });
	}

	if (tokens.includes("delivery")) {
		result = result.filter(
			(p) => map.tiles.get(`${p.x},${p.y}`)?.type === TILE.DELIVERY,
		);
	}
	// "spawn" means type-"1" only (WALKABLE), excludes delivery and directional tiles
	if (tokens.includes("spawn")) {
		result = result.filter(
			(p) => map.tiles.get(`${p.x},${p.y}`)?.type === TILE.WALKABLE,
		);
	}

	// % preserves sign in JS — only matters on negative coords, not used by Deliveroo server
	if (tokens.includes("odd-row"))
		result = result.filter((p) => p.y % 2 !== 0);
	if (tokens.includes("even-row"))
		result = result.filter((p) => p.y % 2 === 0);
	if (tokens.includes("odd-col"))
		result = result.filter((p) => p.x % 2 !== 0);
	if (tokens.includes("even-col"))
		result = result.filter((p) => p.x % 2 === 0);
	if (tokens.includes("odd-tile"))
		result = result.filter((p) => p.x % 2 !== 0 && p.y % 2 !== 0);
	if (tokens.includes("even-tile"))
		result = result.filter((p) => p.x % 2 === 0 && p.y % 2 === 0);

	if (tokens.includes("leftmost"))
		return result.sort((a, b) => a.x - b.x).slice(0, 1);
	if (tokens.includes("rightmost"))
		return result.sort((a, b) => b.x - a.x).slice(0, 1);
	if (tokens.includes("topmost"))
		return result.sort((a, b) => a.y - b.y).slice(0, 1);
	if (tokens.includes("bottommost"))
		return result.sort((a, b) => b.y - a.y).slice(0, 1);

	return result;
}

const M_EMA_ALPHA = 0.1;
let mapLogged = false;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type TickConfig = {
	myId: string;
	movementDurationMs: number;
	decayIntervalMs: number;
	observationDistance: number;
	rewardAvg: number;
};

type TickContext = {
	blocked: Set<number>;
	passableCrates: Set<number> | undefined;
	bfs: BfsFromSelf;
	carry: CarryState;
	selfId: number;
	now: number;
	crossCtx?: CrossCtx;
};

type ReflexResult = {
	skip: boolean;
	intention: Intention | null;
	deliveryCount: number;
};

type StageResult = {
	skip: boolean;
	intention: Intention | null;
};

export class AgentCore {
	private readonly directives = new DirectiveHandler();
	private M = 0;

	constructor(
		private readonly id: string,
		private readonly client: GameClient,
		private readonly beliefs: BeliefStore,
		private readonly bus?: AgentBus,
		private readonly coordinator?: Coordinator,
	) {
		// Subscribe to RELEASE events: drop directives for the released mission.
		bus?.onRelease((payload) => {
			this.directives.releaseByMissionId(payload.missionId);
		});
	}

	private async waitForReady(): Promise<{
		id: string;
		x: number;
		y: number;
	}> {
		while (true) {
			const self = this.client.perception.self;
			if (
				this.client.staticMap.tiles.size > 0 &&
				self?.x !== undefined &&
				self?.y !== undefined &&
				Number.isInteger(self.x) &&
				Number.isInteger(self.y)
			) {
				return { id: self.id, x: self.x, y: self.y };
			}
			await sleep(appCfg.loop.ready_poll_ms);
		}
	}

	private buildTickContext(
		selfX: number,
		selfY: number,
		state: ActiveDirectives,
		cfg: TickConfig,
	): TickContext {
		const map = this.client.staticMap;
		const blocked = computeBlockedTiles(
			map,
			this.beliefs,
			cfg.movementDurationMs,
		);
		for (const xy of state.hardForbiddenTileCoords) {
			const id = tileId(map, xy.x, xy.y);
			if (id !== -1) blocked.add(id);
		}
		// Occupied crate tiles must be blocked so BFS routes around them and
		// isSoundPlan detects stale steps — otherwise PDDL is never triggered.
		for (const crateId of this.beliefs.crateOccupancy) {
			blocked.add(crateId);
		}
		const passableCrates =
			this.beliefs.crateOccupancy.size > 0
				? passableCrateTileSet(map, this.beliefs)
				: undefined;
		const bfs = bfsFromSelf(map, selfX, selfY, blocked, passableCrates);

		let crossCtx: CrossCtx | undefined;
		if (state.pricedCrossTiles.length > 0) {
			const blockedWithPriced = new Set(blocked);
			const pricedById = new Map<number, number>();
			for (const pt of state.pricedCrossTiles) {
				const id = tileId(map, pt.x, pt.y);
				if (id !== -1) {
					blockedWithPriced.add(id);
					pricedById.set(id, pt.penalty);
				}
			}
			crossCtx = {
				bfsAvoid: bfsFromSelf(
					map,
					selfX,
					selfY,
					blockedWithPriced,
					passableCrates,
				),
				pricedById,
			};
		}

		const carry = deriveCarryState(
			this.beliefs.parcels,
			cfg.myId,
			map,
			bfs,
			cfg.decayIntervalMs,
			Date.now(),
		);
		const now = Date.now();
		const selfId = tileId(map, selfX, selfY);
		return {
			blocked,
			passableCrates,
			bfs,
			carry,
			selfId,
			now,
			...(crossCtx && { crossCtx }),
		};
	}

	private metrics(cfg: TickConfig): ValuatorMetrics {
		return {
			M: this.M,
			L: this.coordinator?.getL() ?? 0,
			decayIntervalMs: cfg.decayIntervalMs,
		};
	}

	private async tryGuardedDeliver(
		ctx: TickContext,
		selfX: number,
		selfY: number,
		state: ActiveDirectives,
		intention: Intention | null,
		cfg: TickConfig,
		deliveryCount: number,
	): Promise<ReflexResult> {
		const map = this.client.staticMap;
		if (!shouldDrop(map, ctx.selfId, ctx.carry.n > 0) || state.stage)
			return { skip: false, intention, deliveryCount };

		const m = this.metrics(cfg);
		const deliverResult = scoreDeliver(map, ctx.bfs, ctx.carry, m, state);
		const onBestTile =
			deliverResult !== null &&
			deliverResult.tile.x === selfX &&
			deliverResult.tile.y === selfY;
		if (!onBestTile) return { skip: false, intention, deliveryCount };

		const batches = batchCandidates(
			map,
			ctx.bfs,
			this.beliefs,
			ctx.carry,
			m,
			state,
		);
		if (maxBatchScore(batches) > deliverResult.score)
			return { skip: false, intention, deliveryCount };

		const deliveredPts = sumRewards(ctx.carry);
		const dropped = await this.client.putdown();
		applyDelivery(this.beliefs, cfg.myId);
		this.bus?.emitCarryChange(this.id);
		this.coordinator?.recordDelivery(this.id, deliveredPts);
		deliveryCount += dropped.length;
		log.ok(
			"deliver",
			`putdown=${dropped.length} cleared=${ctx.carry.n} total_delivered=${deliveryCount}`,
		);
		if (intention?.kind === "deliver" && intention.missionId) {
			this.bus?.emitRelease({
				missionId: intention.missionId,
				scope: intention.releaseScope ?? "global",
			});
			intention = null;
		}
		return { skip: true, intention, deliveryCount };
	}

	private async tryDropOverCap(
		ctx: TickContext,
		state: ActiveDirectives,
		intention: Intention | null,
		deliveryCount: number,
	): Promise<ReflexResult> {
		const capFx = parcelCapEffect(state.modifiers);
		// Only force-drop when the cap is a hard block (mult=0); fractional caps
		// let the parcel score at reduced value — no immediate drop needed.
		if (capFx === null || capFx.mult !== 0)
			return { skip: false, intention, deliveryCount };

		const overCapIds = ctx.carry.ids.filter((id) => {
			const p = this.beliefs.parcels.get(id);
			return p && p.reward > capFx.rewardOver;
		});
		if (overCapIds.length === 0)
			return { skip: false, intention, deliveryCount };

		await this.client.putdown(overCapIds);
		for (const id of overCapIds) {
			const p = this.beliefs.parcels.get(id);
			if (p) {
				const { carriedBy: _dropped, ...rest } = p;
				this.beliefs.parcels.set(id, rest as typeof p);
			}
		}
		this.bus?.emitCarryChange(this.id);
		log.warn(
			"score-cap",
			`dropped ${overCapIds.length} over-cap parcels (rewardOver=${capFx.rewardOver})`,
		);
		return { skip: true, intention, deliveryCount };
	}

	private async tryGuardedGrab(
		ctx: TickContext,
		selfX: number,
		selfY: number,
		state: ActiveDirectives,
		intention: Intention | null,
		cfg: TickConfig,
		deliveryCount: number,
	): Promise<ReflexResult> {
		const map = this.client.staticMap;
		const capFx = parcelCapEffect(state.modifiers);
		const parcelAtFeet = parcelHere(this.beliefs.parcels, selfX, selfY);

		if (
			!parcelAtFeet ||
			state.stage ||
			state.forbiddenPickupParcelIds.has(parcelAtFeet.id) ||
			(capFx !== null &&
				parcelAtFeet.reward > capFx.rewardOver &&
				capFx.mult === 0) ||
			parcelAtFeet.reward <= 0
		)
			return { skip: false, intention, deliveryCount };

		const m = this.metrics(cfg);
		const carryAfterGrab: CarryState = {
			...ctx.carry,
			n: ctx.carry.n + 1,
			rewards: [...ctx.carry.rewards, parcelAtFeet.reward],
		};
		if (
			carryValue(map, ctx.bfs, this.beliefs, carryAfterGrab, m, state) <
			carryValue(map, ctx.bfs, this.beliefs, ctx.carry, m, state)
		)
			return { skip: false, intention, deliveryCount };

		const picked = await this.client.pickup();
		applyPickupResult(this.beliefs, picked, cfg.myId);
		clearUncarriedParcelsAt(this.beliefs, selfX, selfY);
		this.bus?.emitCarryChange(this.id);
		log.ok("pickup", `picked=${picked.length}`);
		return { skip: true, intention, deliveryCount };
	}

	private async runReflexes(
		ctx: TickContext,
		selfX: number,
		selfY: number,
		state: ActiveDirectives,
		intention: Intention | null,
		cfg: TickConfig,
		deliveryCount: number,
	): Promise<ReflexResult> {
		let r = await this.tryGuardedDeliver(
			ctx,
			selfX,
			selfY,
			state,
			intention,
			cfg,
			deliveryCount,
		);
		if (r.skip) return r;

		r = await this.tryDropOverCap(ctx, state, r.intention, r.deliveryCount);
		if (r.skip) return r;

		return this.tryGuardedGrab(
			ctx,
			selfX,
			selfY,
			state,
			r.intention,
			cfg,
			r.deliveryCount,
		);
	}

	private async runStagePhase(
		ctx: TickContext,
		selfX: number,
		selfY: number,
		state: ActiveDirectives,
		intention: Intention | null,
		cfg: TickConfig,
	): Promise<StageResult> {
		const map = this.client.staticMap;
		const stage = state.stage!;
		const stageTargets: { x: number; y: number }[] = (() => {
			const t = stage.target;
			if (t.length === 0) return [];
			if (typeof (t as unknown[])[0] === "string") {
				return resolvePredicateTokens(t as PredicateToken[], map);
			}
			return t as { x: number; y: number }[];
		})();

		// Check if already at a target tile (stage complete).
		const atTarget = stageTargets.some(
			(t) => t.x === selfX && t.y === selfY,
		);
		if (atTarget) {
			if (stage.thenAct === "pickUp") {
				const picked = await this.client.pickup();
				applyPickupResult(this.beliefs, picked, cfg.myId);
				clearUncarriedParcelsAt(this.beliefs, selfX, selfY);
				this.bus?.emitCarryChange(this.id);
			} else if (stage.thenAct === "putDown") {
				await this.client.putdown();
				applyDelivery(this.beliefs, cfg.myId);
				this.bus?.emitCarryChange(this.id);
			}
			this.bus?.emitConfirm({
				missionId: stage.missionId ?? "stage",
				directiveType: "STAGE",
				result: stage.thenAct === "putDown" ? "dropped" : "reached",
				agentId: this.id,
			});
			log.ok(
				"stage",
				`reached (${selfX},${selfY}) thenAct=${stage.thenAct ?? "none"}`,
			);
			this.directives.clearStage();
			return { skip: true, intention: null };
		}

		// Install goto intention toward nearest reachable stage target.
		if (stageTargets.length > 0) {
			let nearestTarget: { x: number; y: number } | null = null;
			let nearestDist = Infinity;
			for (const t of stageTargets) {
				const id = tileId(map, t.x, t.y);
				const dist = ctx.bfs.dist[id];
				if (dist === undefined || dist === -1 || dist >= nearestDist)
					continue;
				nearestDist = dist;
				nearestTarget = t;
			}
			if (
				nearestTarget &&
				(!intention ||
					intention.kind !== "goto" ||
					intention.targetXY.x !== nearestTarget.x ||
					intention.targetXY.y !== nearestTarget.y)
			) {
				intention = makeIntention("goto", nearestTarget, ctx.now);
			}
		}

		return { skip: false, intention };
	}

	private async runDeliberationPhase(
		ctx: TickContext,
		selfX: number,
		selfY: number,
		state: ActiveDirectives,
		intention: Intention | null,
		cfg: TickConfig,
		crateCtx: CratePlannerContext | null,
	): Promise<Intention | null> {
		const map = this.client.staticMap;

		// Gate 1: viability.
		if (intention) {
			const viability = checkIntentionViability(
				cfg.myId,
				intention,
				this.beliefs,
				map,
				ctx.bfs,
				selfX,
				selfY,
				ctx.now,
				cfg.movementDurationMs,
			);
			if (!viability.viable) {
				log.warn(
					"intent",
					`terminal kind=${intention.kind} reason=${viability.reason}`,
				);
				if (
					viability.reason === "succeeded" &&
					intention.kind === "goto" &&
					intention.missionId
				) {
					this.bus?.emitRelease({
						missionId: intention.missionId,
						scope: intention.releaseScope ?? "global",
					});
				}
				intention = null;
			}
		}

		// Gate 2: soundness. PDDL crate plans push through crate tiles that
		// plain BFS rejects, so they are exempt from this check.
		if (
			intention &&
			!intention.usedPDDL &&
			!isSoundPlan(intention.plan, selfX, selfY, map, ctx.blocked)
		) {
			intention.plan = buildPlan(
				map,
				ctx.bfs,
				intention.targetXY.x,
				intention.targetXY.y,
			);
			if (intention.plan.length === 0) {
				const navPath =
					crateCtx && this.beliefs.crateOccupancy.size > 0
						? await buildPlanWithCrateHandling(
								map,
								ctx.bfs,
								intention.targetXY.x,
								intention.targetXY.y,
								this.beliefs,
								selfX,
								selfY,
								crateCtx,
							)
						: [];
				if (navPath.length > 0) {
					const pushIntention = makeIntention(
						"push",
						intention.targetXY,
						ctx.now,
					);
					pushIntention.plan = navPath;
					pushIntention.usedPDDL = true;
					intention = pushIntention;
					log.info(
						"intent",
						`PDDL crate nav: ${navPath.length} steps`,
					);
				} else {
					log.warn(
						"intent",
						`sound-fail kind=${intention.kind} reason=unreachable`,
					);
					intention = null;
				}
			}
		}

		// Gate 3: reconsider + deliberate. PDDL plans only yield to a better
		// parcel and only when exploring — committed crate pushes run to completion.
		const reconsider =
			intention !== null &&
			(intention.usedPDDL
				? shouldReconsiderPDDLForParcel(
						intention,
						map,
						ctx.bfs,
						this.beliefs,
						ctx.carry,
						cfg.decayIntervalMs,
						cfg.movementDurationMs,
					)
				: shouldReconsider(
						intention,
						map,
						ctx.bfs,
						this.beliefs,
						ctx.carry,
						cfg.decayIntervalMs,
						cfg.movementDurationMs,
					));

		const teamExclusions = this.coordinator?.exclusionsFor(this.id);

		if (!intention || reconsider) {
			const prev = intention;
			const metrics: ValuatorMetrics = {
				M: this.M,
				L: this.coordinator?.getL() ?? 0,
				decayIntervalMs: cfg.decayIntervalMs,
			};
			intention = deliberate({
				myId: cfg.myId,
				map,
				beliefs: this.beliefs,
				bfs: ctx.bfs,
				selfX,
				selfY,
				now: ctx.now,
				movementDurationMs: cfg.movementDurationMs,
				observationDistance: cfg.observationDistance,
				decayIntervalMs: cfg.decayIntervalMs,
				carry: ctx.carry,
				intention: reconsider ? intention : null,
				directives: state,
				metrics,
				rewardAvg: cfg.rewardAvg,
				...(teamExclusions && { teamExclusions }),
				...(ctx.crossCtx && { crossCtx: ctx.crossCtx }),
			});

			if (intention) {
				const changed =
					!prev ||
					intention.kind !== prev.kind ||
					intention.targetXY.x !== prev.targetXY.x ||
					intention.targetXY.y !== prev.targetXY.y;
				if (changed)
					log.warn(
						"intent",
						`${reconsider && prev ? "reconsider→replan" : "new"} kind=${intention.kind} carrying=${ctx.carry.n > 0} target=(${intention.targetXY.x},${intention.targetXY.y}) plan=${intention.plan.length}steps`,
					);
			}
		}

		// Crate fallback via PDDL. Only when occupied crates exist and we're not
		// already running a PDDL plan (those run to completion). Two cases:
		//  (a) carrying but every delivery tile is sealed off by crates → push
		//      straight to the nearest delivery tile;
		//  (b) idle/exploring while the parcel source is sealed behind crates →
		//      plan the WHOLE collect-then-deliver route at once, so the crate
		//      pushes used to reach the parcel can never block the delivery tile.
		if (
			crateCtx &&
			this.beliefs.crateOccupancy.size > 0 &&
			intention?.usedPDDL !== true
		) {
			const carryingUndeliverable =
				ctx.carry.n > 0 &&
				!Number.isFinite(ctx.carry.nearestDeliveryDist);
			const spawnsBlocked = map.spawnTileIds.some(
				(id) => ctx.bfs.dist[id] === -1,
			);

			// Nearest tile (by manhattan) among ids; blockedOnly skips BFS-reachable ones.
			const nearest = (
				ids: number[],
				blockedOnly: boolean,
			): { x: number; y: number } | null => {
				let best: { x: number; y: number } | null = null;
				let bestDist = Infinity;
				for (const id of ids) {
					if (blockedOnly && ctx.bfs.dist[id] !== -1) continue;
					const { x, y } = idToXY(map, id);
					const d = Math.abs(x - selfX) + Math.abs(y - selfY);
					if (d < bestDist) {
						bestDist = d;
						best = { x, y };
					}
				}
				return best;
			};

			let plan: Direction[] = [];
			let target: { x: number; y: number } | null = null;
			let label = "";

			if (carryingUndeliverable) {
				target = nearest(map.deliveryTileIds, true);
				if (target) {
					plan = await buildPlanWithCrateHandling(
						map,
						ctx.bfs,
						target.x,
						target.y,
						this.beliefs,
						selfX,
						selfY,
						crateCtx,
					);
					label = `deliver → (${target.x},${target.y})`;
				}
			} else if (
				spawnsBlocked &&
				(!intention || intention.kind === "explore")
			) {
				const pickup = nearest(map.spawnTileIds, true);
				const delivery = nearest(map.deliveryTileIds, false);
				if (pickup && delivery) {
					target = delivery;
					plan = await buildPlanWithCrateHandling(
						map,
						ctx.bfs,
						delivery.x,
						delivery.y,
						this.beliefs,
						selfX,
						selfY,
						crateCtx,
						pickup,
					);
					label = `collect (${pickup.x},${pickup.y})→(${delivery.x},${delivery.y})`;
				}
			}

			if (target && plan.length > 0) {
				// Both fallbacks run to completion: kind "push" so the BFS-based
				// viability/reconsider gates can't abort a solver-verified crate plan
				// mid-route (which would leave the agent wandering). Parcels are still
				// picked up and delivered via the position reflexes along the route.
				intention = makeIntention("push", target, ctx.now);
				intention.plan = plan;
				intention.usedPDDL = true;
				log.warn("intent", `PDDL crate fallback ${label}`);
			}
		}

		return intention;
	}

	private async init(): Promise<{
		cfg: TickConfig;
		crateCtx: CratePlannerContext | null;
		selfX: number;
		selfY: number;
	}> {
		const { id: myId, x: selfX, y: selfY } = await this.waitForReady();

		const map = this.client.staticMap;
		if (!mapLogged) {
			mapLogged = true;
			log.info(
				"map",
				`tiles=${map.tiles.size} delivery_zones=${map.deliveryTileIds.length}`,
			);
		}
		log.info(this.id, `starting loop at (${selfX},${selfY})`);

		if (!this.client.config)
			throw new Error(
				`[${this.id}] onConfig not received before loop start`,
			);

		const serverCfg = this.client.config.GAME;
		const cfg: TickConfig = {
			myId,
			movementDurationMs: serverCfg.player.movement_duration,
			decayIntervalMs: parseDecayInterval(
				serverCfg.parcels.decaying_event,
			),
			observationDistance: serverCfg.player.observation_distance,
			rewardAvg: serverCfg.parcels.reward_avg,
		};
		const maxPlayers = this.client.config.GAME.maxPlayers;
		const generationIntervalMs = parseDecayInterval(
			serverCfg.parcels.generation_event,
		);
		this.M = cfg.movementDurationMs;
		if (this.coordinator && cfg.rewardAvg > 0 && generationIntervalMs > 0) {
			this.coordinator.setSeedL(
				(cfg.rewardAvg * appCfg.intention.l_seed_efficiency) /
					(generationIntervalMs * maxPlayers),
			);
		}

		const crateCtx: CratePlannerContext | null = appCfg.crates.enabled
			? createCratePlannerContext(appCfg.crates.cooldown_ms)
			: null;

		return { cfg, crateCtx, selfX, selfY };
	}

	private publishIntention(
		intention: Intention | null,
		ctx: TickContext,
		selfX: number,
		selfY: number,
		cfg: TickConfig,
	): void {
		const map = this.client.staticMap;
		const intentionKind = intention?.kind ?? "idle";
		const spawnerIds =
			intentionKind === "explore" && intention
				? spawnsWithinRadius(
						map,
						intention.targetXY,
						cfg.observationDistance,
					)
				: undefined;
		this.coordinator?.publish(this.id, {
			pos: { x: selfX, y: selfY },
			carry: {
				count: ctx.carry.n,
				reward: sumRewards(ctx.carry),
				ids: ctx.carry.ids,
			},
			intentionSummary: {
				kind: intentionKind,
				...(intention?.targetId !== undefined && {
					targetId: intention.targetId,
				}),
				...(intention?.targetXY !== undefined && {
					targetXY: intention.targetXY,
				}),
				...(spawnerIds && { spawnerIds }),
				...(intention?.missionId !== undefined && {
					missionId: intention.missionId,
				}),
			},
		});
	}

	private async runMovePhase(
		intention: Intention,
		ctx: TickContext,
		selfX: number,
		selfY: number,
		cfg: TickConfig,
	): Promise<{ selfX: number; selfY: number; intention: Intention | null }> {
		const map = this.client.staticMap;

		// Empty plan rebuild.
		if (intention.plan.length === 0) {
			const plan = buildPlan(
				map,
				ctx.bfs,
				intention.targetXY.x,
				intention.targetXY.y,
			);
			if (plan.length === 0) {
				log.warn(
					"intent",
					`no plan for kind=${intention.kind} — dropping`,
				);
				return { selfX, selfY, intention: null };
			}
			intention.plan = plan;
		}

		// Push defer: yield if an opponent is close to the crate being pushed.
		if (intention.kind === "push" && intention.plan.length > 0) {
			const nextDir = intention.plan[0]!;
			const nx =
				selfX + (nextDir === "right" ? 1 : nextDir === "left" ? -1 : 0);
			const ny =
				selfY + (nextDir === "up" ? 1 : nextDir === "down" ? -1 : 0);
			const nextType = map.tiles.get(`${nx},${ny}`)?.type ?? "";
			if (nextType.startsWith("5")) {
				const bfsFromCrate = bfsFromSelf(
					map,
					nx,
					ny,
					ctx.blocked,
					ctx.passableCrates,
				);
				const oppClose = [...this.beliefs.agents.values()].some((a) => {
					if (a.x === undefined || a.y === undefined) return false;
					const oppId = tileId(map, Math.round(a.x), Math.round(a.y));
					const d = bfsFromCrate.dist[oppId];
					return (
						d !== undefined &&
						d >= 0 &&
						d <= appCfg.intention.opponent_defer_steps
					);
				});
				if (oppClose) {
					log.debug(
						"push",
						`deferring push step — opp within ${appCfg.intention.opponent_defer_steps} tiles of crate`,
					);
					await sleep(cfg.movementDurationMs);
					return { selfX, selfY, intention };
				}
			}
		}

		// Execute move.
		const step = intention.plan.shift()!;
		log.debug(
			"plan",
			`step=${step} remaining=${intention.plan.length} kind=${intention.kind}`,
		);
		const moveStart = Date.now();
		const result = await this.client.move(step);
		if (result) {
			const latency = Date.now() - moveStart;
			this.M = M_EMA_ALPHA * latency + (1 - M_EMA_ALPHA) * this.M;
			selfX = result.x;
			selfY = result.y;
			intention.moveFailStreak = 0;
			log.debug(
				"move",
				`${step} → (${selfX},${selfY}) M=${Math.round(this.M)}ms`,
			);
		} else {
			intention.moveFailStreak++;
			intention.plan = [];
			log.error(
				"move",
				`${step} → FAILED fails=${intention.moveFailStreak}`,
			);
			await sleep(cfg.movementDurationMs);
		}
		return { selfX, selfY, intention };
	}

	async run(): Promise<void> {
		const { cfg, crateCtx, selfX: initX, selfY: initY } = await this.init();
		let selfX = initX,
			selfY = initY;

		let intention: Intention | null = null;
		let intentionMissing = false;
		let loopCount = 0;
		let deliveryCount = 0;

		while (true) {
			loopCount++;

			// Drain bus directives and apply them.
			if (this.bus) {
				for (const d of this.bus.drainDirectives(this.id))
					this.directives.enqueue(d);
			}
			this.directives.apply();
			const state = this.directives.state;

			const ctx = this.buildTickContext(selfX, selfY, state, cfg);

			// Pause: idle this tick.
			if (state.paused) {
				await sleep(appCfg.loop.no_step_wait_ms);
				continue;
			}

			// Reflexes: guarded deliver / score-cap drop / guarded grab.
			const reflex = await this.runReflexes(
				ctx,
				selfX,
				selfY,
				state,
				intention,
				cfg,
				deliveryCount,
			);
			deliveryCount = reflex.deliveryCount;
			intention = reflex.intention;
			if (reflex.skip) continue;

			// Stage override or deliberation.
			if (state.stage) {
				const stage = await this.runStagePhase(
					ctx,
					selfX,
					selfY,
					state,
					intention,
					cfg,
				);
				intention = stage.intention;
				if (stage.skip) continue;
			} else {
				intention = await this.runDeliberationPhase(
					ctx,
					selfX,
					selfY,
					state,
					intention,
					cfg,
					crateCtx,
				);
			}

			// Publish finalized intention for team coordination.
			this.publishIntention(intention, ctx, selfX, selfY, cfg);

			// Periodic competitor log.
			if (loopCount % 50 === 0) {
				const top = topCompetitorTiles(
					this.beliefs,
					5,
					ctx.now,
					cfg.movementDurationMs,
				);
				if (top.length > 0)
					log.info(
						"memory",
						`competitor top5: ${top.map((t) => `(${t.x},${t.y})=${t.weight.toFixed(1)}`).join(" ")}`,
					);
			}

			if (!intention) {
				if (!intentionMissing) {
					log.warn(
						"wait",
						`no intention — carrying=${ctx.carry.n > 0} pos=(${selfX},${selfY})`,
					);
					intentionMissing = true;
				}
				await sleep(appCfg.loop.no_step_wait_ms);
				continue;
			}
			intentionMissing = false;

			// Move: empty-plan rebuild + push-defer + execute.
			({ selfX, selfY, intention } = await this.runMovePhase(
				intention,
				ctx,
				selfX,
				selfY,
				cfg,
			));
		}
	}
}
