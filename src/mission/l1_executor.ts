import { buildL1SystemPrompt, buildL1UserPrompt } from "./prompts.js";
import type { L1Ctx, L1DoneShape, ToolCall } from "./tools.js";
import type { LlmClient, ChatMessage } from "./llm_client.js";
import type { MissionRecord } from "./extractor.js";
import { executeTool } from "./tools.js";
import { log } from "../logger.js";
import { cfg } from "../config.js";

export type L1Result = L1DoneShape;

// Included in error feedback so the model knows exactly what to fix.
const FORMAT_HINT =
	`Reply with exactly one JSON object {"thought":string,"action":{"tool":string,"args":object|null}}. ` +
	`No markdown, no prose. Valid tools: calculate, map_query, resolve_tile, send_message, done.`;

function errorObservation(msg: string): ChatMessage {
	return {
		role: "user",
		content: JSON.stringify({ observation: { error: msg } }),
	};
}

export class L1Executor {
	constructor(
		private readonly llm: LlmClient,
		private readonly ctx: L1Ctx,
	) {}

	// ReAct loop: each step asks the LLM for a thought + action, runs the tool, feeds the observation back.
	// Bounded by cfg.maxSteps; parse errors are fed back as observations so the model can self-correct.
	async run(record: MissionRecord): Promise<L1Result> {
		log.info("l1_executor", `started on: ${record.raw.slice(0, 60)}`);
		const history: ChatMessage[] = [
			{ role: "system", content: buildL1SystemPrompt() },
			{ role: "user", content: buildL1UserPrompt(record.raw) },
		];

		let messageSent = false;

		log.info("l1_executor", `starting exec loop for mission${record.raw}`);

		for (let step = 0; step < cfg.mission.l1_max_steps; step++) {
			let raw: string;
			try {
				raw = await this.llm.complete(history);
			} catch (err) {
				log.warn(
					"l1_executor",
					`step ${step}: LLM error — ${String(err)}`,
				);
				break;
			}

			let parsed: { thought?: string; action: ToolCall };
			try {
				parsed = JSON.parse(raw) as typeof parsed;
			} catch {
				log.warn("l1_executor", `step ${step}: JSON parse failed`);
				history.push({ role: "assistant", content: raw });
				history.push(
					errorObservation(
						`Invalid response: not JSON. ${FORMAT_HINT}`,
					),
				);
				continue;
			}

			// Shape guard: catches missing/non-object action or non-string tool.
			if (
				typeof parsed.action !== "object" ||
				parsed.action === null ||
				typeof (parsed.action as { tool?: unknown }).tool !== "string"
			) {
				log.warn("l1_executor", `step ${step}: bad action shape`);
				history.push({ role: "assistant", content: raw });
				history.push(
					errorObservation(`Invalid action shape. ${FORMAT_HINT}`),
				);
				continue;
			}

			history.push({ role: "assistant", content: raw });

			// "done" exits the loop: model signals it has enough information or cannot proceed further.
			if (parsed.action.tool === "done") {
				const doneArgs = parsed.action.args as
					| { resolvedCoords?: { x: number; y: number }[] }
					| null
					| undefined;
				if (messageSent) {
					log.info("l1_executor", "done: answered");
					return { kind: "answered" };
				}
				if (!doneArgs) {
					log.warn("l1_executor", "done: no args");
					return { kind: "failed" };
				}
				const coords = doneArgs.resolvedCoords;
				if (coords && coords.length > 0) {
					log.ok("l1_executor", `done: resolved ${coords.length} coords`);
					return { kind: "modifier", coords };
				}
				log.warn("l1_executor", "done: no coords");
				return { kind: "failed" };
			}

			let obs: unknown;
			try {
				obs = { output: await executeTool(parsed.action, this.ctx) };
				if (parsed.action.tool === "send_message") messageSent = true;
			} catch (e) {
				const err = e as { error?: string; recoverable?: boolean };
				obs = {
					error: err.error ?? String(e),
					recoverable: err.recoverable ?? true,
				};
			}

			history.push({
				role: "user",
				content: JSON.stringify({ observation: obs }),
			});
		}

		if (messageSent) {
			log.info("l1_executor", "max steps exhausted: answered");
			return { kind: "answered" };
		}
		log.error("l1_executor", `max steps exhausted (${cfg.mission.l1_max_steps}) — failing`);
		return { kind: "failed" };
	}
}
