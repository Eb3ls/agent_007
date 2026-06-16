import { resolveLabel, type XY } from "./tile_resolver.js";
import { idToXY, type StaticMap } from "../static_map.js";
import type { GameClient } from "../game_client.js";

export type { XY } from "./tile_resolver.js";

export type ToolName =
	| "calculate"
	| "map_query"
	| "resolve_tile"
	| "send_message"
	| "done";

export type ToolCall = { tool: ToolName; args: unknown };

export type ToolError = { error: string; recoverable: boolean };

export type L1DoneShape =
	| { kind: "answered" }
	| { kind: "modifier"; coords: XY[] }
	| { kind: "failed" };

export type L1Ctx = {
	map: StaticMap;
	bdiClient: GameClient;
	senderId: string;
};

function toolError(error: string, recoverable = true): never {
	throw { error, recoverable } satisfies ToolError;
}

function requireString(args: unknown, key: string, tool: string): string {
	const v = (args as Record<string, unknown> | null)?.[key];
	if (typeof v !== "string")
		toolError(`${tool} requires args.${key} (string)`);
	return v;
}

function execCalculate(args: unknown): number {
	const expr = requireString(args, "expr", "calculate");
	// Only allow arithmetic (digits, operators, parens, dots, spaces).
	if (/[a-df-wyz_$]/i.test(expr))
		toolError("Non-arithmetic identifier in expr");
	try {
		// eslint-disable-next-line no-new-func
		return Function(`"use strict"; return (${expr})`)() as number;
	} catch (e) {
		toolError(`Arithmetic eval error: ${String(e)}`);
	}
}

function execMapQuery(args: unknown, ctx: L1Ctx): unknown {
	const a = args as { query: string; x?: number; y?: number };
	switch (a.query) {
		case "spawn_tiles":
			return ctx.map.spawnTileIds.map((id) => idToXY(ctx.map, id));
		case "delivery_tiles":
			return ctx.map.deliveryTileIds.map((id) => idToXY(ctx.map, id));
		case "tile_at":
			if (a.x === undefined || a.y === undefined)
				toolError("tile_at requires x and y");
			return ctx.map.tiles.get(`${a.x},${a.y}`)?.type ?? null;
		case "bounds":
			return {
				width: ctx.map.gridWidth,
				height: ctx.map.gridHeight,
				minX: ctx.map.minX,
				minY: ctx.map.minY,
			};
		default:
			toolError(`Unknown map query: ${a.query}`);
	}
}

function execResolveTile(args: unknown, ctx: L1Ctx): XY | null {
	const label = requireString(args, "label", "resolve_tile");
	return resolveLabel(label, ctx.map);
}

async function execSendMessage(args: unknown, ctx: L1Ctx): Promise<string> {
	const a = args as { to?: string; msg: string };
	await ctx.bdiClient.say(a.to ?? ctx.senderId, a.msg);
	return "sent";
}

export async function executeTool(
	call: ToolCall,
	ctx: L1Ctx,
): Promise<unknown> {
	switch (call.tool) {
		case "calculate":
			return execCalculate(call.args);
		case "map_query":
			return execMapQuery(call.args, ctx);
		case "resolve_tile":
			return execResolveTile(call.args, ctx);
		case "send_message":
			return execSendMessage(call.args, ctx);
		default:
			toolError(
				`Unknown tool "${call.tool}". Valid tools: calculate, map_query, resolve_tile, send_message, done.`,
			);
	}
}
