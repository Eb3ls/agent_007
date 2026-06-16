import type { L1Ctx, L1DoneShape, ToolCall } from "./tools.js";
import type { LlmClient, ChatMessage } from "./llm_client.js";
import type { MissionRecord } from "./extractor.js";
import { L1_MAX_STEPS } from "../config.js";
import { executeTool } from "./tools.js";
import { log } from "../logger.js";

export type L1Result = L1DoneShape;

const SYSTEM_PROMPT = `You are an agent assistant. Execute tasks step by step using tools.
Each response must be valid JSON: {"thought":"<reasoning>","action":{"tool":"<name>","args":<args>}}
Tools:
- calculate: {tool:"calculate",args:{expr:"<arithmetic>"}} → number
- map_query: {tool:"map_query",args:{query:"spawn_tiles"|"delivery_tiles"|"bounds"|"tile_at",x?,y?}} → data
- resolve_tile: {tool:"resolve_tile",args:{label:"<semantic label>"}} → {x,y}|null
- send_message: {tool:"send_message",args:{to:"<id>",msg:"<text>"}} → "sent"
- done: terminal. After send_message: {tool:"done",args:null}. Coords resolved: {tool:"done",args:{resolvedCoords:[{x,y}]}}. Cannot complete: {tool:"done",args:null}`;

function buildUserPrompt(record: MissionRecord): string {
	return `Mission text: "${record.raw}"\nTask: resolve unknown coordinates or answer the question. Use tools step by step.`;
}

export class L1Executor {
	constructor(
		private readonly llm: LlmClient,
		private readonly ctx: L1Ctx,
	) {}

	async run(record: MissionRecord): Promise<L1Result> {
		const history: ChatMessage[] = [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: buildUserPrompt(record) },
		];

		let messageSent = false;
		let lastActionKey: string | null = null;

		for (let step = 0; step < L1_MAX_STEPS; step++) {
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
				break;
			}

			// Loop detection: same tool+args as previous step → exit.
			const actionKey = JSON.stringify(parsed.action);
			if (actionKey === lastActionKey) {
				log.warn(
					"l1_executor",
					`step ${step}: loop detected — exiting`,
				);
				break;
			}
			lastActionKey = actionKey;

			history.push({ role: "assistant", content: raw });

			if (parsed.action.tool === "done") {
				const doneArgs = parsed.action.args as
					| { resolvedCoords?: { x: number; y: number }[] }
					| null
					| undefined;
				if (messageSent) return { kind: "answered" };
				if (!doneArgs) return { kind: "failed" };
				const coords = doneArgs.resolvedCoords;
				if (coords && coords.length > 0)
					return { kind: "modifier", coords };
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

		if (messageSent) return { kind: "answered" };
		log.warn("l1_executor", "max steps exhausted — failing silently");
		return { kind: "failed" };
	}
}
