import {
	CRATES_COOLDOWN_MS,
	CRATES_ENABLED,
	L_SEED_EFFICIENCY,
	NO_STEP_WAIT_MS,
	OPPONENT_DEFER_STEPS,
	READY_POLL_MS,
	parseDecayInterval,
} from "../config.js";
import {
	buildPlan,
	computeBlockedTiles,
	deriveCarryState,
	isSoundPlan,
	parcelHere,
	passableCrateTileSet,
	shouldDrop,
} from "./planner.js";
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
import type { Coordinator } from "../team/coordinator.js";
import { DirectiveHandler } from "../team/directives.js";
import type { AgentBus } from "../team/agent_bus.js";
import type { ValuatorMetrics } from "./valuator.js";
import type { GameClient } from "../game_client.js";
import type { Intention } from "./intention.js";
import { deliberate } from "./deliberation.js";
import { bfsFromSelf } from "../pathfinder.js";
import { makeIntention } from "./intention.js";
import { tileId } from "../static_map.js";
import { log } from "../logger.js";

const M_EMA_ALPHA = 0.1;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
			await sleep(READY_POLL_MS);
		}
	}

	async run(): Promise<void> {
		const { id: myId, x: startX, y: startY } = await this.waitForReady();
		let selfX = startX,
			selfY = startY;

		const map = this.client.staticMap;
		log.info(
			"map",
			`tiles=${map.tiles.size} delivery_zones=${map.deliveryTileIds.length}`,
		);
		log.info(this.id, `starting loop at (${selfX},${selfY})`);

		if (!this.client.config)
			throw new Error(
				`[${this.id}] onConfig not received before loop start`,
			);
		const serverCfg = this.client.config.GAME;
		const movementDurationMs = serverCfg.player.movement_duration;
		const observationDistance = serverCfg.player.observation_distance;
		const rewardAvg = serverCfg.parcels.reward_avg;
		const maxPlayers = this.client.config.GAME.maxPlayers;
		const decayIntervalMs = parseDecayInterval(
			serverCfg.parcels.decaying_event,
		);
		const generationIntervalMs = parseDecayInterval(
			serverCfg.parcels.generation_event,
		);
		this.M = movementDurationMs;
		if (this.coordinator && rewardAvg > 0 && generationIntervalMs > 0) {
			this.coordinator.setSeedL(
				(rewardAvg * L_SEED_EFFICIENCY) /
					(generationIntervalMs * maxPlayers),
			);
		}

		let intention: Intention | null = null;
		let intentionMissing = false;
		let loopCount = 0;
		let deliveryCount = 0;

		const crateCtx: CratePlannerContext | null = CRATES_ENABLED
			? createCratePlannerContext(CRATES_COOLDOWN_MS)
			: null;

		while (true) {
			loopCount++;
			const selfId = tileId(map, selfX, selfY);

			// Step 1: drain bus directives and apply them.
			if (this.bus) {
				for (const d of this.bus.drainDirectives(this.id))
					this.directives.enqueue(d);
			}
			this.directives.apply(Date.now());

			const state = this.directives.state;

			// Step 1 post: pause-orphan assert — paused with no missionId tracking.
			if (state.paused && state.pauseMissionId === null) {
				log.warn(
					"pause",
					"orphan pause — no missionId (RESUME required)",
				);
			}

			// Step 2: blocked set (agents + hard-forbidden tiles from on:"cross" modifiers).
			const blocked = computeBlockedTiles(
				map,
				this.beliefs,
				movementDurationMs,
			);
			for (const xy of state.hardForbiddenTileCoords) {
				const id = tileId(map, xy.x, xy.y);
				if (id !== -1) blocked.add(id);
			}
			const passableCrates =
				this.beliefs.crates.size > 0
					? passableCrateTileSet(map, this.beliefs)
					: undefined;
			const bfs = bfsFromSelf(map, selfX, selfY, blocked, passableCrates);
			const carry = deriveCarryState(
				this.beliefs.parcels,
				myId,
				map,
				bfs,
				decayIntervalMs,
				Date.now(),
			);
			const now = Date.now();

			// Pause: idle this tick.
			if (state.paused) {
				await sleep(NO_STEP_WAIT_MS);
				continue;
			}

			// Step 3: publish position + current target for team coordination.
			const intentionKind = intention?.kind ?? "idle";
			const spawnerIds =
				intentionKind === "explore" && intention
					? [tileId(map, intention.targetXY.x, intention.targetXY.y)]
					: undefined;
			this.coordinator?.publish(this.id, {
				pos: { x: selfX, y: selfY },
				carry: {
					count: carry.n,
					reward: carry.rewards.reduce((a, b) => a + b, 0),
					ids: carry.ids,
				},
				intentionSummary: {
					kind: intentionKind,
					...(spawnerIds && { spawnerIds }),
				},
			});

			// Step 4a: deliver if on delivery tile.
			if (shouldDrop(map, selfId, carry.n > 0)) {
				const deliveredPts = carry.rewards.reduce((a, b) => a + b, 0);
				const dropped = await this.client.putdown();
				applyDelivery(this.beliefs, myId);
				this.bus?.emitCarryChange(this.id);
				this.coordinator?.recordDelivery(this.id, deliveredPts);
				deliveryCount += dropped.length;
				log.ok(
					"deliver",
					`putdown=${dropped.length} cleared=${carry.n} total_delivered=${deliveryCount}`,
				);
				// If current intention was a mission-driven deliver-at, emit RELEASE.
				if (intention?.kind === "deliver" && intention.missionId) {
					this.bus?.emitRelease({
						missionId: intention.missionId,
						scope: intention.releaseScope ?? "global",
					});
					intention = null;
				}
				continue;
			}

			// Step 4b: score-cap selective putdown — drop parcels over the active cap anywhere.
			const capMod = state.modifiers.find(
				(m) =>
					m.selector.on === "deliver-parcel" &&
					(
						m.selector as {
							on: "deliver-parcel";
							rewardOver?: number;
						}
					).rewardOver !== undefined,
			);
			if (capMod) {
				const cap = (
					capMod.selector as {
						on: "deliver-parcel";
						rewardOver: number;
					}
				).rewardOver;
				const overCapIds = carry.ids.filter((id) => {
					const p = this.beliefs.parcels.get(id);
					return p && p.reward > cap;
				});
				if (overCapIds.length > 0) {
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
						`dropped ${overCapIds.length} over-cap parcels (cap=${cap})`,
					);
					continue;
				}
			}

			// Step 4c: pickup at feet if not forbidden.
			const parcelAtFeet = parcelHere(this.beliefs.parcels, selfX, selfY);
			if (
				parcelAtFeet &&
				!state.forbiddenPickupParcelIds.has(parcelAtFeet.id)
			) {
				const picked = await this.client.pickup();
				applyPickupResult(this.beliefs, picked, myId);
				clearUncarriedParcelsAt(this.beliefs, selfX, selfY);
				this.bus?.emitCarryChange(this.id);
				log.ok("pickup", `picked=${picked.length}`);
				continue;
			}

			// Step 5: OVERRIDE STAGE — install goto intention; skip Gate3+deliberate while active.
			if (state.stage) {
				const stage = state.stage;
				const stageTargets = Array.isArray(stage.target)
					? stage.target
					: [];

				// Check if already at a target tile (stage complete).
				const atTarget = stageTargets.some(
					(t) => t.x === selfX && t.y === selfY,
				);
				if (atTarget) {
					if (stage.thenAct === "pickUp") {
						const picked = await this.client.pickup();
						applyPickupResult(this.beliefs, picked, myId);
						clearUncarriedParcelsAt(this.beliefs, selfX, selfY);
						this.bus?.emitCarryChange(this.id);
					} else if (stage.thenAct === "putDown") {
						await this.client.putdown();
						applyDelivery(this.beliefs, myId);
						this.bus?.emitCarryChange(this.id);
					}
					this.bus?.emitConfirm({
						missionId: stage.missionId ?? "stage",
						directiveType: "STAGE",
						result:
							stage.thenAct === "putDown" ? "dropped" : "reached",
						agentId: this.id,
					});
					log.ok(
						"stage",
						`reached (${selfX},${selfY}) thenAct=${stage.thenAct ?? "none"}`,
					);
					this.directives.clearStage();
					intention = null;
					continue;
				}

				// Install goto intention toward nearest reachable stage target.
				if (stageTargets.length > 0) {
					let nearestTarget: { x: number; y: number } | null = null;
					let nearestDist = Infinity;
					for (const t of stageTargets) {
						const id = tileId(map, t.x, t.y);
						const dist = bfs.dist[id];
						if (
							dist === undefined ||
							dist === -1 ||
							dist >= nearestDist
						)
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
						intention = makeIntention("goto", nearestTarget, now);
					}
				}
			} else {
				// Normal deliberation path (no STAGE active).

				// Gate 1: viability.
				if (intention) {
					const viability = checkIntentionViability(
						myId,
						intention,
						this.beliefs,
						map,
						bfs,
						selfX,
						selfY,
						now,
						movementDurationMs,
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
							// Mission-driven goto completed: emit RELEASE.
							this.bus?.emitRelease({
								missionId: intention.missionId,
								scope: intention.releaseScope ?? "global",
							});
						}
						this.coordinator?.releaseTarget(this.id);
						if (intention.kind === "goto")
							this.coordinator?.releaseGotoTarget(this.id);
						intention = null;
					}
				}

				// Gate 2: soundness. PDDL crate plans push through crate tiles that
				// plain BFS rejects, so they are exempt — re-running buildPlan would
				// flatten the push plan every tick.
				if (
					intention &&
					!intention.usedPDDL &&
					!isSoundPlan(intention.plan, selfX, selfY, map, blocked)
				) {
					intention.plan = buildPlan(
						map,
						bfs,
						intention.targetXY.x,
						intention.targetXY.y,
					);
					if (intention.plan.length === 0) {
						// BFS can't reach the target. If crates block the way, try a
						// crate-pushing plan via the PDDL solver (anonymous occupancy).
						const navPath =
							crateCtx && this.beliefs.crates.size > 0
								? await buildPlanWithCrateHandling(
										map,
										bfs,
										intention.targetXY.x,
										intention.targetXY.y,
										this.beliefs,
										selfX,
										selfY,
										crateCtx,
									)
								: [];
						if (navPath.length > 0) {
							// Push intention so the opponent-defer guard below applies;
							// usedPDDL exempts it from BFS soundness/viability aborts.
							const pushIntention = makeIntention(
								"push",
								intention.targetXY,
								now,
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
							this.coordinator?.releaseTarget(this.id);
							if (intention.kind === "goto")
								this.coordinator?.releaseGotoTarget(this.id);
							intention = null;
						}
					}
				}

				// Gate 3 / deliberation. PDDL plans only yield to a better parcel and
				// only when exploring, so committed crate pushes run to completion.
				const reconsider =
					intention !== null &&
					(intention.usedPDDL
						? shouldReconsiderPDDLForParcel(
								intention,
								map,
								bfs,
								this.beliefs,
								carry,
								decayIntervalMs,
								movementDurationMs,
							)
						: shouldReconsider(
								intention,
								map,
								bfs,
								this.beliefs,
								carry,
								decayIntervalMs,
								movementDurationMs,
							));

				const teamAdvice = this.coordinator?.assignFor(this.id);

				if (!intention || reconsider) {
					const prev = intention;
					const metrics: ValuatorMetrics = {
						M: this.M,
						L: this.coordinator?.getL() ?? 0,
						decayIntervalMs,
					};
					intention = deliberate({
						myId,
						map,
						beliefs: this.beliefs,
						bfs,
						selfX,
						selfY,
						now,
						movementDurationMs,
						observationDistance,
						decayIntervalMs,
						carry,
						intention: reconsider ? intention : null,
						directives: state,
						metrics,
						...(teamAdvice && { teamAdvice }),
					});

					// Register new target synchronously after commit.
					this.coordinator?.registerTarget(
						this.id,
						intention?.targetId ?? null,
					);
					if (intention?.kind === "goto") {
						this.coordinator?.registerGotoTarget(
							this.id,
							intention.targetXY,
						);
					} else {
						this.coordinator?.releaseGotoTarget(this.id);
					}

					if (intention) {
						const changed =
							!prev ||
							intention.kind !== prev.kind ||
							intention.targetXY.x !== prev.targetXY.x ||
							intention.targetXY.y !== prev.targetXY.y;
						if (changed)
							log.warn(
								"intent",
								`${reconsider && prev ? "reconsider→replan" : "new"} kind=${intention.kind} carrying=${carry.n > 0} target=(${intention.targetXY.x},${intention.targetXY.y}) plan=${intention.plan.length}steps`,
							);
					}
				}
			}

			if (loopCount % 50 === 0) {
				const top = topCompetitorTiles(
					this.beliefs,
					5,
					now,
					movementDurationMs,
				);
				if (top.length > 0) {
					log.info(
						"memory",
						`competitor top5: ${top.map((t) => `(${t.x},${t.y})=${t.weight.toFixed(1)}`).join(" ")}`,
					);
				}
			}

			if (!intention) {
				if (!intentionMissing) {
					log.warn(
						"wait",
						`no intention — carrying=${carry.n > 0} pos=(${selfX},${selfY})`,
					);
					intentionMissing = true;
				}
				await sleep(NO_STEP_WAIT_MS);
				continue;
			}

			intentionMissing = false;
			if (intention.plan.length === 0) {
				const plan = buildPlan(
					map,
					bfs,
					intention.targetXY.x,
					intention.targetXY.y,
				);
				if (plan.length === 0) {
					log.warn(
						"intent",
						`no plan for kind=${intention.kind} — dropping`,
					);
					intention = null;
					continue;
				}
				intention.plan = plan;
			}

			if (intention.kind === "push" && intention.plan.length > 0) {
				const nextDir = intention.plan[0]!;
				const nx =
					selfX +
					(nextDir === "right" ? 1 : nextDir === "left" ? -1 : 0);
				const ny =
					selfY +
					(nextDir === "up" ? 1 : nextDir === "down" ? -1 : 0);
				const nextType = map.tiles.get(`${nx},${ny}`)?.type ?? "";
				if (nextType.startsWith("5")) {
					const bfsFromCrate = bfsFromSelf(
						map,
						nx,
						ny,
						blocked,
						passableCrates,
					);
					const oppClose = [...this.beliefs.agents.values()].some(
						(a) => {
							if (a.x === undefined || a.y === undefined)
								return false;
							const oppId = tileId(
								map,
								Math.round(a.x),
								Math.round(a.y),
							);
							const d = bfsFromCrate.dist[oppId];
							return (
								d !== undefined &&
								d >= 0 &&
								d <= OPPONENT_DEFER_STEPS
							);
						},
					);
					if (oppClose) {
						log.debug(
							"push",
							`deferring push step — opp within ${OPPONENT_DEFER_STEPS} tiles of crate`,
						);
						await sleep(movementDurationMs);
						continue;
					}
				}
			}

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
				await sleep(movementDurationMs);
			}
		}
	}
}
