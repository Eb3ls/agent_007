import { buildSystemPrompt, buildExtractionPrompt } from "./prompts.js";
import type { PredicateToken } from "../team/directives.js";
import type { LlmClient } from "./llm_client.js";
import { createHash } from "node:crypto";
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
	predicate?: PredicateToken[];
	raw: string;
};

type ParsedResponse = Partial<MissionRecord> & {
	coords?: Array<XY | string> | null;
	predicate?: PredicateToken[] | null;
	selector?: Partial<MissionRecord["selector"]> & {
		coords?: Array<XY | string> | null;
	};
};

// Collapse whitespace before hashing: equivalent prompts with different spacing share a cache entry.
function cacheKey(text: string): string {
	return createHash("sha1")
		.update(text.trim().replace(/\s+/g, " "))
		.digest("hex")
		.slice(0, 16);
}

export class Extractor {
	private readonly cache = new Map<string, MissionRecord | null>();

	constructor(private readonly llm: LlmClient) {}

	// Sends the text to the LLM, parses the JSON response into a MissionRecord, and caches by content hash.
	async extract(text: string): Promise<MissionRecord | null> {
		const key = cacheKey(text);
		if (this.cache.has(key)) {
			log.debug("extractor", `cache hit: ${text}`);
			return this.cache.get(key)!;
		}

		let record: MissionRecord | null = null;
		try {
			const response = await this.llm.complete([
				{ role: "system", content: buildSystemPrompt() },
				{ role: "user", content: buildExtractionPrompt(text) },
			]);
			const parsed = JSON.parse(response) as ParsedResponse;

			const opType = parsed.opType as MissionRecord["opType"] | undefined;
			const level = parsed.level as MissionRecord["level"] | undefined;
			if (!opType || !level) {
				log.warn(
					"extractor",
					`missing required fields opType=${opType} level=${level} for: ${text.slice(0, 60)}`,
				);
			} else {
				// Prefer top-level coords; fall back to selector coords. Filter strings — unresolved label placeholders
				// that the LLM emitted instead of numeric values.
				const rawCoords: Array<XY | string> =
					(parsed.coords?.length
						? parsed.coords
						: parsed.selector?.coords) ?? [];
				const resolvedCoords = rawCoords.filter(
					(c): c is XY => typeof c !== "string",
				);

				const predicate =
					parsed.predicate && parsed.predicate.length > 0
						? parsed.predicate
						: undefined;

				record = {
					level,
					opType,
					selector: {
						...(parsed.selector ?? { on: "deliver" }),
						...(resolvedCoords.length > 0
							? { coords: resolvedCoords }
							: {}),
					} as MissionRecord["selector"],
					effect: parsed.effect ?? {},
					condition: parsed.condition ?? null,
					lifetime:
						(parsed.lifetime as MissionRecord["lifetime"]) ??
						"one-shot",
					target: parsed.target ?? "both",
					bonus: parsed.bonus ?? null,
					answer: parsed.answer ?? null,
					token: parsed.token ?? null,
					...(predicate !== undefined ? { predicate } : {}),
					raw: text,
				};
				log.info(
					"extractor",
					`op=${record.opType} on=${record.selector.on} coords=${resolvedCoords.length} predicate=${predicate ? JSON.stringify(predicate) : "none"} lifetime=${record.lifetime} bonus=${record.bonus}${record.effect.mult !== undefined ? ` mult=${record.effect.mult}` : ""}${record.effect.add !== undefined ? ` add=${record.effect.add}` : ""}${record.token ? ` token=${record.token}` : ""}${record.condition ? ` condition=${JSON.stringify(record.condition)}` : ""}`,
				);
			}
		} catch (err) {
			log.error("extractor", `parse failed: ${String(err)}`);
			record = null;
		}

		this.cache.set(key, record);
		return record;
	}
}
