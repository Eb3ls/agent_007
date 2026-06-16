import type { Condition, Directive, XY } from "../team/directives.js";
import type { AgentBus } from "../team/agent_bus.js";
import type { GameClient } from "../game_client.js";
import type { MissionRecord } from "./extractor.js";
import type { L3Executor } from "./l3_executor.js";
import type { L1Executor } from "./l1_executor.js";
import type { Extractor } from "./extractor.js";
import type { Listener } from "./listener.js";
import { log } from "../logger.js";

export class Assembler {
	private missionSeq = 0;

	constructor(
		private readonly bus: AgentBus,
		private readonly bdiClient: GameClient,
		private readonly listener: Listener,
		private readonly extractor: Extractor,
		private readonly l1Executor?: L1Executor,
		private readonly l3Executor?: L3Executor,
	) {}

	/** Call once per tick to process pending messages from the listener queue. */
	async processPending(): Promise<void> {
		const messages = this.listener.drain();
		for (const msg of messages) {
			await this.handleMessage(msg.text, msg.senderId, msg.replyFn);
		}
	}

	private async handleMessage(
		text: string,
		senderId: string,
		replyFn: ((msg: string) => void) | null,
	): Promise<void> {
		void replyFn; // available for future use
		const record = await this.extractor.extract(text);
		if (!record) {
			log.warn(
				"assembler",
				`extraction returned null for: ${text.slice(0, 60)}`,
			);
			return;
		}

		// Q&A: answer immediately via say.
		if (record.opType === "qa" || record.answer) {
			if (record.answer) {
				await this.bdiClient.say(senderId, record.answer);
				log.info(
					"assembler",
					`qa reply: ${record.answer.slice(0, 60)}`,
				);
			}
			if (record.opType === "qa") return;
		}

		// STATE_QUERY: L1 non-physical — no answer, no coords → l1_executor
		if (
			record.level === "L1" &&
			!record.answer &&
			(!record.selector.coords || record.selector.coords.length === 0) &&
			this.l1Executor
		) {
			void this.l1Executor.run(record).then((result) => {
				if (result.kind === "modifier" && result.coords.length > 0) {
					const mid = `m${++this.missionSeq}`;
					const dir = this.buildModifier(
						{
							...record,
							selector: {
								...record.selector,
								coords: result.coords,
							},
						},
						mid,
						record.target === "both" ? "both" : record.target,
					);
					if (dir) {
						this.bus.emitDirective("bdi", dir);
						this.bus.emitDirective("llm", dir);
						log.info(
							"assembler",
							`l1 resolved coords → MODIFIER missionId=${mid}`,
						);
					}
				}
			});
			log.info("assembler", "routed to l1_executor (STATE_QUERY)");
			return;
		}

		const missionId = `m${++this.missionSeq}`;
		const scope = record.target === "both" ? "global" : "per-agent";
		const agentTarget: string | "both" =
			record.target === "both" ? "both" : record.target;

		switch (record.opType) {
			case "PAUSE": {
				this.bus.emitDirective("bdi", {
					kind: "OVERRIDE",
					op: "PAUSE",
					missionId,
				});
				this.bus.emitDirective("llm", {
					kind: "OVERRIDE",
					op: "PAUSE",
					missionId,
				});
				if (record.token) {
					const token = record.token.toLowerCase();
					this.listener.armToken(token);
					this.bus.armSignal(token);
					this.bus.onSignal((t) => {
						if (t !== token) return;
						this.bus.emitDirective("bdi", {
							kind: "OVERRIDE",
							op: "RESUME",
							missionId,
						});
						this.bus.emitDirective("llm", {
							kind: "OVERRIDE",
							op: "RESUME",
							missionId,
						});
						this.bus.emitRelease({ missionId, scope });
						log.info(
							"assembler",
							`SIGNAL(${token}) → RESUME + RELEASE missionId=${missionId}`,
						);
					});
				}
				log.info("assembler", `PAUSE missionId=${missionId}`);
				break;
			}

			case "RESUME":
				this.bus.emitDirective("bdi", {
					kind: "OVERRIDE",
					op: "RESUME",
					missionId,
				});
				this.bus.emitDirective("llm", {
					kind: "OVERRIDE",
					op: "RESUME",
					missionId,
				});
				log.info("assembler", `RESUME missionId=${missionId}`);
				break;

			case "STAGE": {
				const targets: XY[] = record.selector.coords ?? [];
				if (targets.length > 0) {
					this.bus.emitDirective("bdi", {
						kind: "OVERRIDE",
						op: "STAGE",
						target: targets,
						missionId,
					});
					this.bus.emitDirective("llm", {
						kind: "OVERRIDE",
						op: "STAGE",
						target: targets,
						missionId,
					});
				} else {
					log.warn(
						"assembler",
						`STAGE has no resolved coords — pausing in place missionId=${missionId}`,
					);
				}
				// Always pause: navigation target may be unresolvable but agent must stop.
				this.bus.emitDirective("bdi", {
					kind: "OVERRIDE",
					op: "PAUSE",
					missionId,
				});
				this.bus.emitDirective("llm", {
					kind: "OVERRIDE",
					op: "PAUSE",
					missionId,
				});
				if (record.token) {
					const token = record.token.toLowerCase();
					this.listener.armToken(token);
					this.bus.armSignal(token);
					this.bus.onSignal((t) => {
						if (t !== token) return;
						this.bus.emitDirective("bdi", {
							kind: "OVERRIDE",
							op: "RESUME",
							missionId,
						});
						this.bus.emitDirective("llm", {
							kind: "OVERRIDE",
							op: "RESUME",
							missionId,
						});
						this.bus.emitRelease({ missionId, scope });
						log.info(
							"assembler",
							`SIGNAL(${token}) → RESUME + RELEASE missionId=${missionId}`,
						);
					});
				}
				log.info(
					"assembler",
					`red-light STAGE+PAUSE+arm(${record.token ?? "none"}) missionId=${missionId}`,
				);
				break;
			}

			case "handoff":
			case "rendezvous": {
				if (!this.l3Executor) {
					log.warn(
						"assembler",
						`${record.opType} received but l3Executor not wired`,
					);
					break;
				}
				const dispatched = this.l3Executor.dispatch(record, missionId);
				if (!dispatched) {
					log.warn(
						"assembler",
						`${record.opType} deferred — mutex busy`,
					);
				}
				log.info(
					"assembler",
					`${record.opType} missionId=${missionId} dispatched=${dispatched}`,
				);
				break;
			}

			case "MODIFIER":
			default: {
				const directive = this.buildModifier(
					record,
					missionId,
					agentTarget,
				);
				if (!directive) {
					log.warn(
						"assembler",
						`could not build directive for op=${record.opType}`,
					);
					break;
				}
				// Send to both agents (coordinator handles per-agent scope via RELEASE).
				this.bus.emitDirective("bdi", directive);
				this.bus.emitDirective("llm", directive);
				log.info(
					"assembler",
					`MODIFIER on=${record.selector.on} missionId=${missionId} lifetime=${record.lifetime} scope=${scope}`,
				);
				break;
			}
		}
	}

	private buildModifier(
		record: MissionRecord,
		missionId: string,
		target: string | "both",
	): Directive | null {
		const sel = record.selector;
		const effect = { ...record.effect };
		if (!effect.add && !effect.mult && record.bonus !== null) {
			effect.add = record.bonus;
		}

		// Validate selector has required coords/tiles.
		if (sel.on === "goto" && (!sel.coords || sel.coords.length === 0))
			return null;
		if (sel.on === "cross" && (!sel.tiles || sel.tiles.length === 0))
			return null;

		// Build condition from the record's optional flat object into a union Condition type.
		let condition: Condition | undefined = undefined;
		if (record.condition) {
			const c = record.condition;
			if (c.carryCountEquals !== undefined)
				condition = { carryCountEquals: c.carryCountEquals };
			else if (c.carryCountAtLeast !== undefined)
				condition = { carryCountAtLeast: c.carryCountAtLeast };
			else if (c.carryCountOver !== undefined)
				condition = { carryCountOver: c.carryCountOver };
			else if (c.carryRewardAtMost !== undefined)
				condition = { carryRewardAtMost: c.carryRewardAtMost };
		}

		return {
			kind: "MODIFIER",
			selector: sel as Extract<
				Directive,
				{ kind: "MODIFIER" }
			>["selector"],
			effect,
			...(condition !== undefined ? { condition } : {}),
			lifetime: record.lifetime,
			missionId,
			target,
		} as Directive;
	}
}
