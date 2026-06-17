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
		private readonly chatClient: GameClient,
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

	// Extracts a MissionRecord from the raw message text and routes it to the appropriate per-opType handler.
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

		if (await this.handleQa(record, senderId)) return;
		if (this.handleStateQuery(record)) return;

		const missionId = `m${++this.missionSeq}`;
		const scope = record.target === "both" ? "global" : "per-agent";
		const agentTarget: string | "both" =
			record.target === "both" ? "both" : record.target;

		switch (record.opType) {
			case "PAUSE":
				this.handlePause(record, missionId, scope);
				break;
			case "RESUME":
				this.handleResume(missionId);
				break;
			case "STAGE":
				this.handleStage(record, missionId, scope);
				break;
			case "handoff":
			case "rendezvous":
				this.handleChoreography(record, missionId);
				break;
			case "MODIFIER":
			default:
				this.handleModifier(record, missionId, agentTarget);
				break;
		}
	}

	// --- per-opType handlers ---

	// Sends the LLM-generated answer back to the sender and returns true to stop further processing.
	private async handleQa(
		record: MissionRecord,
		senderId: string,
	): Promise<boolean> {
		if (record.opType !== "qa" && !record.answer) return false;
		if (record.answer) {
			await this.chatClient.say(senderId, record.answer);
			log.info("assembler", `qa reply: ${record.answer.slice(0, 60)}`);
		}
		return record.opType === "qa";
	}

	// Fires L1 resolution asynchronously: returns true immediately so the caller can reply "working on it",
	// then re-injects the resolved MODIFIER once the LLM finishes.
	private handleStateQuery(record: MissionRecord): boolean {
		if (
			record.level !== "L1" ||
			record.answer ||
			(record.selector.coords && record.selector.coords.length > 0) ||
			!this.l1Executor
		)
			return false;

		void this.l1Executor.run(record).then((result) => {
			if (result.kind !== "modifier" || result.coords.length === 0)
				return;
			const mid = `m${++this.missionSeq}`;
			const dir = this.buildModifier(
				{
					...record,
					selector: { ...record.selector, coords: result.coords },
				},
				mid,
				record.target === "both" ? "both" : record.target,
			);
			if (dir) {
				this.emitBoth(dir);
				log.info(
					"assembler",
					`l1 resolved coords → MODIFIER missionId=${mid}`,
				);
			}
		});
		log.info("assembler", "routed to l1_executor (STATE_QUERY)");
		return true;
	}

	// Emits PAUSE to both agents and optionally arms a resume token.
	private handlePause(
		record: MissionRecord,
		missionId: string,
		scope: "global" | "per-agent",
	): void {
		this.emitBoth({ kind: "OVERRIDE", op: "PAUSE", missionId });
		if (record.token) this.armResume(record.token, missionId, scope);
		log.info(
			"assembler",
			`PAUSE missionId=${missionId}${record.token ? ` arm(${record.token})` : ""}`,
		);
	}

	// Emits RESUME to both agents.
	private handleResume(missionId: string): void {
		this.emitBoth({ kind: "OVERRIDE", op: "RESUME", missionId });
		log.info("assembler", `RESUME missionId=${missionId}`);
	}

	// Emits STAGE + PAUSE to both agents and arms a resume token if provided.
	private handleStage(
		record: MissionRecord,
		missionId: string,
		scope: "global" | "per-agent",
	): void {
		const coords: XY[] = record.selector.coords ?? [];
		const predicate = record.predicate ?? [];
		if (coords.length > 0) {
			this.emitBoth({
				kind: "OVERRIDE",
				op: "STAGE",
				target: coords,
				missionId,
			});
		} else if (predicate.length > 0) {
			this.emitBoth({
				kind: "OVERRIDE",
				op: "STAGE",
				target: predicate,
				missionId,
			});
		} else {
			log.warn(
				"assembler",
				`STAGE has no target — pausing in place missionId=${missionId}`,
			);
		}
		// Always pause: agent must stop regardless of whether target resolved.
		this.emitBoth({ kind: "OVERRIDE", op: "PAUSE", missionId });
		if (record.token) this.armResume(record.token, missionId, scope);
		log.info(
			"assembler",
			`red-light STAGE+PAUSE+arm(${record.token ?? "none"}) missionId=${missionId}`,
		);
	}

	// Delegates handoff/rendezvous to L3Executor; warns if mutex busy.
	private handleChoreography(record: MissionRecord, missionId: string): void {
		if (!this.l3Executor) {
			log.warn(
				"assembler",
				`${record.opType} received but l3Executor not wired`,
			);
			return;
		}
		const dispatched = this.l3Executor.dispatch(record, missionId);
		if (!dispatched) {
			log.warn("assembler", `${record.opType} deferred — mutex busy`);
		}
		log.info(
			"assembler",
			`${record.opType} missionId=${missionId} dispatched=${dispatched}`,
		);
	}

	// Builds a MODIFIER directive from the record and emits it to both agents.
	private handleModifier(
		record: MissionRecord,
		missionId: string,
		agentTarget: string | "both",
	): void {
		const directive = this.buildModifier(record, missionId, agentTarget);
		if (!directive) {
			log.warn(
				"assembler",
				`could not build directive for op=${record.opType}`,
			);
			return;
		}
		this.emitBoth(directive);
		log.info(
			"assembler",
			`MODIFIER on=${record.selector.on} missionId=${missionId} lifetime=${record.lifetime} scope=${record.target === "both" ? "global" : "per-agent"}`,
		);
	}

	// --- shared helpers ---

	// Sends the same directive to both bdi and llm agents.
	private emitBoth(d: Directive): void {
		this.bus.emitDirective("bdi", d);
		this.bus.emitDirective("llm", d);
	}

	// Registers a one-shot signal handler: fires RESUME + RELEASE when the token word is received,
	// then removes itself to prevent duplicate triggers on subsequent messages.
	private armResume(
		token: string,
		missionId: string,
		scope: "global" | "per-agent",
	): void {
		const t = token.toLowerCase();
		this.listener.armToken(t);
		this.bus.armSignal(t);
		const off = this.bus.onSignal((signalled) => {
			if (signalled !== t) return;
			off();
			this.emitBoth({ kind: "OVERRIDE", op: "RESUME", missionId });
			this.bus.emitRelease({ missionId, scope });
			log.info(
				"assembler",
				`SIGNAL(${t}) → RESUME + RELEASE missionId=${missionId}`,
			);
		});
	}

	// Builds a MODIFIER directive from a MissionRecord, normalising selector, effect, and condition fields.
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

		// LLM emits conditions as a flat object; reconstruct the typed union before forwarding to directives.
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
