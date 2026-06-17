import {
	scopeOf,
	type Condition,
	type Directive,
	type XY,
} from "../team/directives.js";
import { resolvePredicateTokens, type StaticMap } from "../static_map.js";
import { formatMissionRecord } from "./mission_log.js";
import type { AgentBus } from "../team/agent_bus.js";
import type { GameClient } from "../game_client.js";
import type { MissionRecord } from "./extractor.js";
import type { L3Executor } from "./l3_executor.js";
import type { Extractor } from "./extractor.js";
import type { Resolver } from "./resolver.js";
import type { Listener } from "./listener.js";
import { log } from "../logger.js";

export class Assembler {
	private missionSeq = 0;

	constructor(
		private readonly bus: AgentBus,
		private readonly chatClient: GameClient,
		private readonly listener: Listener,
		private readonly extractor: Extractor,
		private readonly map: StaticMap,
		private readonly resolver?: Resolver,
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

		log.debug("assembler", `missionRecord: ${JSON.stringify(record)}`);

		if (await this.handleQa(record, senderId)) return;
		if (this.resolveAndRoute(record)) return;

		const missionId = `m${++this.missionSeq}`;
		const scope = scopeOf(record.target);
		const agentTarget: string | "both" = record.target;

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

	// Deterministic-first resolution for coord-consuming missions (MODIFIER, rendezvous).
	// Returns true when the mission was resolved (sync via predicate) or handed to the async
	// resolver loop; false when there is nothing to resolve and the caller should dispatch as-is.
	private resolveAndRoute(record: MissionRecord): boolean {
		if (record.answer) return false;
		if (record.opType !== "MODIFIER" && record.opType !== "rendezvous")
			return false;

		// Explicit override: the target isn't vocab-expressible → tool-based resolver loop.
		if (record.needsResolve) {
			if (!this.resolver) return false;
			this.runResolver(record);
			return true;
		}

		// Deterministic fast path: resolve predicate tokens to tiles with no LLM call.
		if (record.predicate && record.predicate.length > 0) {
			const tiles = resolvePredicateTokens(record.predicate, this.map);
			if (tiles.length > 0) {
				this.dispatchResolved(record, tiles);
				return true;
			}
			// Deterministic resolution found nothing → fall back to the resolver loop.
			if (this.resolver) {
				this.runResolver(record);
				return true;
			}
		}
		return false;
	}

	// Runs the LLM resolver loop asynchronously and dispatches the resolved coords on completion.
	private runResolver(record: MissionRecord): void {
		if (!this.resolver) return;
		void this.resolver.run(record).then((result) => {
			if (result.kind !== "modifier" || result.coords.length === 0)
				return;
			this.dispatchResolved(record, result.coords);
		});
		log.info("assembler", "routed to resolver loop");
	}

	// Injects resolved tiles into the record's selector (per opType) and routes the resolved
	// record to its normal handler. Clears resolution flags to prevent re-triggering.
	private dispatchResolved(record: MissionRecord, tiles: XY[]): void {
		const mid = `m${++this.missionSeq}`;
		// Drop predicate so the resolved record can't re-trigger resolution.
		const { predicate: _resolved, ...rest } = record;
		void _resolved;
		const resolved: MissionRecord = {
			...rest,
			selector: this.injectCoords(record, tiles),
			needsResolve: false,
		};
		if (resolved.opType === "rendezvous" || resolved.opType === "handoff") {
			this.handleChoreography(resolved, mid);
		} else {
			this.handleModifier(resolved, mid, resolved.target);
		}
		log.info(
			"assembler",
			`resolved → ${resolved.opType} missionId=${mid} tiles=${tiles.length}`,
		);
	}

	// Maps resolved tiles into the selector field appropriate for the selector kind:
	// deliver → single tile, cross → forbidden set, goto/rendezvous → coords.
	private injectCoords(
		record: MissionRecord,
		tiles: XY[],
	): MissionRecord["selector"] {
		const sel = record.selector;
		if (sel.on === "deliver")
			return { on: "deliver", tile: tiles[0] ?? null };
		if (sel.on === "cross") return { on: "cross", tiles };
		return { ...sel, coords: tiles };
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
		if (directive.kind === "MODIFIER") {
			log.info(
				"assembler",
				`MODIFIER ${formatMissionRecord(record)} missionId=${missionId} scope=${scopeOf(record.target)}`,
			);
		}
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
	// Converts negative-bonus goto missions into cross (avoidance) modifiers so agents actively avoid them.
	private buildModifier(
		record: MissionRecord,
		missionId: string,
		target: string | "both",
	): Directive | null {
		let sel = record.selector;
		const effect = { ...record.effect };
		// Check for undefined explicitly: a legitimate effect.mult=0 (e.g. "0 of the
		// standard reward") is falsy but must NOT be treated as an absent multiplier.
		if (
			effect.add === undefined &&
			effect.mult === undefined &&
			record.bonus !== null
		) {
			effect.add = record.bonus;
		}

		// Convert negative-bonus goto coords to cross (avoidance) modifiers.
		// This makes agents actively avoid those coords in pathfinding instead of just not pursuing them as a goto target.
		// Negate the effect so that negative bonus becomes positive penalty (hard forbidden tile).
		if (
			sel.on === "goto" &&
			sel.coords &&
			sel.coords.length > 0 &&
			(effect.add ?? 0) < 0
		) {
			sel = { on: "cross", tiles: sel.coords };
			if (effect.add !== undefined) effect.add = -effect.add;
			if (effect.mult !== undefined) effect.mult = 1 / effect.mult;
			log.info(
				"assembler",
				`converted goto→cross (negated effect) missionId=${missionId}`,
			);
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
