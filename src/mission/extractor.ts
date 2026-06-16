import { buildSystemPrompt, buildExtractionPrompt } from "./prompts.js";
import { resolveLabel } from "./tile_resolver.js";
import type { StaticMap } from "../static_map.js";
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
	raw: string;
};

type ParsedResponse = Partial<MissionRecord> & {
	coords?: Array<XY | string> | null;
	selector?: Partial<MissionRecord["selector"]> & {
		coords?: Array<XY | string> | null;
	};
};

function cacheKey(text: string): string {
	return createHash("sha1")
		.update(text.trim().replace(/\s+/g, " "))
		.digest("hex")
		.slice(0, 16);
}

export class Extractor {
	private readonly cache = new Map<string, MissionRecord | null>();

	constructor(
		private readonly llm: LlmClient,
		private readonly map: StaticMap,
	) {}

	async extract(text: string): Promise<MissionRecord | null> {
		const key = cacheKey(text);
		if (this.cache.has(key)) {
			log.debug("extractor", `cache hit: ${text.slice(0, 60)}`);
			return this.cache.get(key)!;
		}

		let record: MissionRecord | null = null;
		try {
			const response = await this.llm.complete([
				{ role: "system", content: buildSystemPrompt() },
				{ role: "user", content: buildExtractionPrompt(text) },
			]);
			const parsed = JSON.parse(response) as ParsedResponse;

			const rawCoords: Array<XY | string> =
				(parsed.coords?.length
					? parsed.coords
					: parsed.selector?.coords) ?? [];
			const resolvedCoords = rawCoords
				.map((c) =>
					typeof c === "string" ? resolveLabel(c, this.map) : c,
				)
				.filter((c): c is XY => c !== null);

			record = {
				level: (parsed.level as MissionRecord["level"]) ?? "L2",
				opType:
					(parsed.opType as MissionRecord["opType"]) ?? "MODIFIER",
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
					"persistent",
				target: parsed.target ?? "both",
				bonus: parsed.bonus ?? null,
				answer: parsed.answer ?? null,
				token: parsed.token ?? null,
				raw: text,
			};

			log.info(
				"extractor",
				`op=${record.opType} on=${record.selector.on} coords=${resolvedCoords.length} lifetime=${record.lifetime} bonus=${record.bonus}${record.token ? ` token=${record.token}` : ""}${record.condition ? " condition=yes" : ""}`,
			);
		} catch (err) {
			log.error("extractor", `parse failed: ${String(err)}`);
			record = null;
		}

		this.cache.set(key, record);
		return record;
	}
}
