import { buildSystemPrompt, buildExtractionPrompt } from "./prompts.js";
import { resolveLabel } from "./tile_resolver.js";
import type { StaticMap } from "../static_map.js";
import type { LlmClient } from "./llm_client.js";
import { log } from "../logger.js";

export type XY = { x: number; y: number };

export type MissionRecord = {
	level: "L1" | "L2" | "L3";
	opType:
		| "MODIFIER"
		| "PAUSE"
		| "RESUME"
		| "STAGE"
		| "handoff"
		| "rendezvous"
		| "qa";
	selector: {
		on: "goto" | "deliver" | "deliver-parcel" | "cross" | "pickup";
		coords?: XY[];
		tile?: XY | null;
		rewardOver?: number | null;
		tiles?: XY[];
		parcelId?: string | null;
	};
	effect: { add?: number; mult?: number };
	condition?: {
		carryCountEquals?: number;
		carryCountAtLeast?: number;
		carryCountOver?: number;
		carryRewardAtMost?: number;
	} | null;
	lifetime: "one-shot" | "persistent";
	target: string;
	bonus: number | null;
	answer: string | null;
	token: string | null;
	raw: string;
};

function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16);
}

export class Extractor {
	private readonly cache = new Map<string, MissionRecord | null>();

	constructor(
		private readonly llm: LlmClient,
		private readonly map: StaticMap,
	) {}

	async extract(text: string): Promise<MissionRecord | null> {
		const key = hashText(text);
		if (this.cache.has(key)) return this.cache.get(key)!;

		let record: MissionRecord | null = null;
		try {
			const response = await this.llm.complete([
				{ role: "system", content: buildSystemPrompt() },
				{ role: "user", content: buildExtractionPrompt(text) },
			]);
			const parsed = JSON.parse(response) as Partial<MissionRecord> & {
				coords?: Array<{ x: number; y: number } | string> | null;
			};

			// Resolve any string-labeled coordinates via tile_resolver.
			const resolvedCoords = parsed.coords
				? parsed.coords
						.map((c) =>
							typeof c === "string"
								? resolveLabel(c, this.map)
								: c,
						)
						.filter((c): c is XY => c !== null)
				: undefined;

			record = {
				level: (parsed.level as MissionRecord["level"]) ?? "L2",
				opType:
					(parsed.opType as MissionRecord["opType"]) ?? "MODIFIER",
				selector: parsed.selector ?? { on: "deliver" },
				effect: parsed.effect ?? {},
				condition: parsed.condition ?? null,
				lifetime:
					(parsed.lifetime as MissionRecord["lifetime"]) ??
					"persistent",
				target: parsed.target ?? "both",
				bonus: parsed.bonus ?? null,
				answer: parsed.answer ?? null,
				token: parsed.token ?? null,
				raw: text,
			};

			if (resolvedCoords && resolvedCoords.length > 0) {
				record.selector = {
					...record.selector,
					coords: resolvedCoords,
				};
			}

			log.info(
				"extractor",
				`level=${record.level} op=${record.opType} bonus=${record.bonus}`,
			);
		} catch (err) {
			log.error("extractor", `parse failed: ${String(err)}`);
			record = null;
		}

		this.cache.set(key, record);
		return record;
	}
}
