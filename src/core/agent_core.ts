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
	conditionMet,
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
	DirectiveHandler,
	scopeOf,
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
import { bfsFromSelf, DELTA_OF, type BfsFromSelf } from "../pathfinder.js";
import { cfg as appCfg, parseDecayInterval } from "../config.js";
import type { Coordinator } from "../team/coordinator.js";
import { checkIntentionViability } from "./reconsider.js";
import type { AgentBus } from "../team/agent_bus.js";
import type { GameClient } from "../game_client.js";
import { intentSig } from "./intention_rules.js";
import type { Intention } from "./intention.js";
import { deliberate } from "./deliberation.js";
import { makeIntention } from "./intention.js";
import { log } from "../logger.js";

// Resolves a predicate token array to concrete XY positions on the map.
// Tokens: "center", "delivery", "spawn", corner/edge shorthands, and parity filters (odd/even x|y).
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
	private lastIntentSig: string | null = null;
	private intentRebuilds = 0;

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

	// Polls until the server has sent a valid integer position and the static map is populated.
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

	// Builds per-tick computation context: blocked tiles, passable crates, BFS from self,
	// carry state, and optional cross-tile cost context for priced-cross directives.
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

		// Secondary BFS excludes priced tiles so scorePickup can compare avoid-vs-cross path costs.
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

	// Assembles ValuatorMetrics from the current M-EMA and coordinator throughput rate.
	private metrics(cfg: TickConfig): ValuatorMetrics {
		return {
			M: this.M,
			L: this.coordinator?.getL() ?? 0,
			decayIntervalMs: cfg.decayIntervalMs,
		};
	}

	// Reflex: putdown if standing on the best delivery tile and no batch option scores higher.
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
		this.completeOneShotDeliverModifiers(state, ctx.carry, selfX, selfY);
		if (intention?.kind === "deliver" && intention.missionId) {
			this.bus?.emitRelease({
				missionId: intention.missionId,
				scope: intention.releaseScope ?? "global",
			});
			intention = null;
		}
		return { skip: true, intention, deliveryCount };
	}

	// Reflex: drops carried parcels whose reward exceeds the hard cap threshold (mult=0 modifier).
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

	// Reflex: picks up a free parcel underfoot if adding it improves the carry portfolio value.
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

	// Runs all reflexes in priority order: deliver → cap-drop → grab. Returns on the first that fires.
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

	// Handles an active STAGE directive: routes toward the nearest reachable target tile and executes thenAct on arrival.
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
			let pickedCount = 0;
			if (stage.thenAct === "pickUp") {
				const picked = await this.client.pickup();
				pickedCount = picked.length;
				applyPickupResult(this.beliefs, picked, cfg.myId);
				clearUncarriedParcelsAt(this.beliefs, selfX, selfY);
				this.bus?.emitCarryChange(this.id);
			} else if (stage.thenAct === "putDown") {
				await this.client.putdown();
				applyDelivery(this.beliefs, cfg.myId);
				this.bus?.emitCarryChange(this.id);
			}
			const confirmResult =
				stage.thenAct === "putDown"
					? "dropped"
					: stage.thenAct === "pickUp" && pickedCount === 0
						? "failed"
						: "reached";
			this.bus?.emitConfirm({
				missionId: stage.missionId ?? "stage",
				directiveType: "STAGE",
				result: confirmResult,
				agentId: this.id,
			});
			log.ok(
				"stage",
				`reached (${selfX},${selfY}) thenAct=${stage.thenAct ?? "none"}${stage.thenAct === "pickUp" ? ` picked=${pickedCount}` : ""}`,
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

	// Runs the two-gate deliberation pipeline (viability, soundness) + regime split (PDDL run-to-completion vs deliberate-every-tick) and crate PDDL fallback,
	// then logs intention transitions and returns the selected intention.
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
		let terminatedThisTick = false;
		let terminatedSig = "";
		let terminatedReason = "";
		let deliberateWhy = "";

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
				state,
			);
			if (!viability.viable) {
				terminatedThisTick = true;
				terminatedSig = intentSig(intention);
				terminatedReason =
					viability.reason +
					("detail" in viability && viability.detail
						? `:${viability.detail}`
						: "");
				log.debug(
					`${this.id}:intent`,
					`terminal kind=${intention.kind} reason=${terminatedReason}`,
				);
				if (
					viability.reason === "succeeded" &&
					intention.kind === "goto" &&
					intention.missionId
				) {
					log.ok(
						this.id,
						`mission complete missionId=${intention.missionId}`,
					);
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
						`${this.id}:intent`,
						`PDDL crate nav: ${navPath.length} steps`,
					);
				} else {
					log.warn(
						`${this.id}:intent`,
						`sound-fail kind=${intention.kind} reason=unreachable`,
					);
					intention = null;
				}
			}
		}

		// Gate 3: regime split. A committed PDDL plan runs to completion (the
		// expensive solve is the only thing worth amortizing). A BFS intention is
		// re-deliberated every tick — buildPlan is O(path), nothing to gate — with
		// the current intention as a candidate so the switch margin (now inside
		// selectBestIntention) provides the anti-thrash hysteresis.
		const metrics = this.metrics(cfg);
		const teamExclusions = this.coordinator?.exclusionsFor(this.id);

		if (!intention?.usedPDDL) {
			const prev = intention;
			const result = deliberate({
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
				intention,
				directives: state,
				metrics,
				rewardAvg: cfg.rewardAvg,
				...(teamExclusions && { teamExclusions }),
				...(ctx.crossCtx && { crossCtx: ctx.crossCtx }),
			});
			intention = result.intention;
			deliberateWhy = result.why;

			if (intention) {
				const changed =
					!prev ||
					intention.kind !== prev.kind ||
					intention.targetXY.x !== prev.targetXY.x ||
					intention.targetXY.y !== prev.targetXY.y;
				if (changed) {
					const missionPart = intention.missionId
						? ` mission=${intention.missionId}`
						: "";
					log.debug(
						`${this.id}:intent`,
						`${prev ? "switch" : "new"} kind=${intention.kind} carrying=${ctx.carry.n > 0} target=(${intention.targetXY.x},${intention.targetXY.y}) plan=${intention.plan.length}steps${missionPart}`,
					);
				}
			}
		}

		// Crate fallback via PDDL. Only when occupied crates exist and we're not
		// already running a PDDL plan (those run to completion). Two legs:
		//  (a) DELIVERY leg — carrying, every delivery tile sealed off by crates, and
		//      nothing reachable left to grab → push the carry to the nearest delivery.
		//  (b) COLLECT leg — empty-handed while the parcel source is sealed behind
		//      crates → solve the FULL collect-then-deliver route (so delivery stays
		//      reachable, no self-block) but drive only to the spawn. There the agent
		//      gathers parcels via normal deliberation; once nothing reachable is left,
		//      leg (a) delivers. Leg (a) is suppressed while a pickup is deliberated so
		//      the whole spawn cluster is collected before heading to delivery.
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
			// A freshly deliberated pickup means a parcel is still reachable to grab —
			// keep collecting before committing the delivery leg.
			const deliberatedPickup = intention?.kind === "pickup";

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

			let target: { x: number; y: number } | null = null;
			let plan: any[] = [];
			let label = "";

			if (carryingUndeliverable && !deliberatedPickup) {
				// Delivery leg: nothing reachable left to collect, so push the carried
				// parcels straight to the nearest (sealed) delivery tile.
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
					if (plan.length > 0) {
						// A delivery-bound crate push must run to completion: built as
						// a usedPDDL plan so Gate 3's regime split runs it to completion
						// (no BFS intention preempts a committed PDDL plan — §9.1),
						// instead of swapping it for a nearby pickup while it carries
						// undeliverable parcels.
						intention = makeIntention("push", target, ctx.now);
						intention.plan = plan;
						intention.usedPDDL = true;
						label = `deliver → (${target.x},${target.y})`;
						log.warn(
							`${this.id}:intent`,
							`PDDL crate fallback ${label}`,
						);
					}
				}
			} else if (
				ctx.carry.n === 0 &&
				spawnsBlocked &&
				(!intention || intention.kind === "explore")
			) {
				// Collect leg: solve the full collect-then-deliver (proves delivery
				// stays reachable) but drive ONLY to the spawn, then collect there.
				const pickup = nearest(map.spawnTileIds, true);
				const delivery = nearest(map.deliveryTileIds, false);
				if (pickup && delivery) {
					target = pickup;
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
						true, // stopAtPickup: return only the agent→spawn leg
					);
					label = `collect leg → spawn (${pickup.x},${pickup.y})`;
				}
			}

			if (target && plan.length > 0) {
				// Both legs run to completion: kind "push" so the BFS-based viability
				// gate can't abort a solver-verified crate plan mid-route.
				// Parcels are still picked up via the position reflexes along the way.
				intention = makeIntention("push", target, ctx.now);
				intention.plan = plan;
				intention.usedPDDL = true;
				log.warn("intent", `PDDL crate fallback ${label}`);
			}
			if (intention) {
				this.lastIntentSig = intentSig(intention);
				this.intentRebuilds = 0;
			}
		}

		return intention;
	}

	// Waits for server ready, parses game config, seeds the coordinator L-value, and creates the crate planner context.
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

	// Broadcasts the finalized intention summary to the coordinator so teammates can exclude the same target.
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

	// Executes one movement step: rebuilds an empty plan, defers a push if a competitor
	// is near the crate, then issues the move and updates the M-EMA on success.
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
					`${this.id}:intent`,
					`no plan for kind=${intention.kind} — dropping`,
				);
				return { selfX, selfY, intention: null };
			}
			intention.plan = plan;
		}

		// Push defer: yield if an opponent is close to the crate being pushed.
		if (intention.kind === "push" && intention.plan.length > 0) {
			const nextDir = intention.plan[0]!;
			const [ddx, ddy] = DELTA_OF[nextDir];
			const nx = selfX + ddx;
			const ny = selfY + ddy;
			const nextType = map.tiles.get(`${nx},${ny}`)?.type ?? "";
			if (
				nextType === TILE.CRATE_SLIDE ||
				nextType === TILE.CRATE_SLIDE_MOVING
			) {
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
			const failContext = `kind=${intention.kind}${intention.targetXY ? ` target=(${intention.targetXY.x},${intention.targetXY.y})` : ""}${intention.missionId ? ` mission=${intention.missionId}` : ""}`;
			log.error(
				"move",
				`${step} → FAILED fails=${intention.moveFailStreak} ${failContext}`,
			);
			await sleep(cfg.movementDurationMs);
		}
		return { selfX, selfY, intention };
	}

	// Fires RELEASE for any one-shot deliver modifiers whose selector condition was satisfied by this delivery.
	private completeOneShotDeliverModifiers(
		state: ActiveDirectives,
		carry: CarryState,
		tileX: number,
		tileY: number,
	): void {
		for (const m of state.modifiers) {
			if (m.lifetime !== "one-shot") continue;
			const sel = m.selector;
			if (sel.on === "deliver") {
				if (sel.tile && (sel.tile.x !== tileX || sel.tile.y !== tileY))
					continue;
				if (!conditionMet(m.condition, carry)) continue;
			} else if (sel.on === "deliver-parcel") {
				const thr = sel.rewardOver ?? 0;
				if (!carry.rewards.some((r) => r > thr)) continue;
			} else {
				continue;
			}
			log.ok(this.id, `mission complete missionId=${m.missionId}`);
			this.bus?.emitRelease({
				missionId: m.missionId,
				scope: scopeOf(m.target),
			});
		}
	}

	// Main BDI loop: drains directives, runs reflexes, deliberates or stages, publishes intention, and moves.
	async run(): Promise<void> {
		const { cfg, crateCtx, selfX: initX, selfY: initY } = await this.init();
		let selfX = initX,
			selfY = initY;

		let intention: Intention | null = null;
		let loopCount = 0;
		let deliveryCount = 0;

		while (true) {
			loopCount++;

			// Drain bus directives and apply them.
			let directiveCount = 0;
			if (this.bus) {
				for (const d of this.bus.drainDirectives(this.id)) {
					this.directives.enqueue(d);
					directiveCount++;
				}
			}
			this.directives.apply();
			const state = this.directives.state;

			if (directiveCount > 0) {
				const activeModifiers = state.modifiers.length;
				const activeMissions = new Set(
					state.modifiers.map((m) => m.missionId),
				).size;
				log.info(
					`${this.id}:directives`,
					`received=${directiveCount} active-modifiers=${activeModifiers} active-missions=${activeMissions}${state.paused ? " [PAUSED]" : ""}${state.stage ? " [STAGE]" : ""}`,
				);
			}

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
			// A fired reflex skips the rest of the tick, so deliberation never runs
			// the same tick — reflex and deliberate never double-score.
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
				await sleep(appCfg.loop.no_step_wait_ms);
				continue;
			}

			if (intention.plan.length === 0) {
				const modContext =
					state.modifiers.length > 0
						? ` mods=[${state.modifiers.map((m) => `${m.missionId}:${m.selector.on}`).join(",")}]`
						: "";
				log.debug(
					`${this.id}:plan`,
					`building: kind=${intention.kind} target=(${intention.targetXY.x},${intention.targetXY.y})${intention.missionId ? ` mission=${intention.missionId}` : ""}${modContext}`,
				);
			}

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
