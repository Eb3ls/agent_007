import {
	idToXY,
	resolvePredicateTokens,
	type StaticMap,
} from "../static_map.js";
import type { PredicateToken } from "../team/directives.js";
import type { GameClient } from "../game_client.js";

export type XY = { x: number; y: number };

export type ToolName =
	| "calculate"
	| "map_query"
	| "resolve_tile"
	| "send_message"
	| "done";

export type ToolCall = { tool: ToolName; args: unknown };

export type ToolError = { error: string; recoverable: boolean };

export type ResolveDoneShape =
	| { kind: "answered" }
	| { kind: "modifier"; coords: XY[] }
	| { kind: "failed" };

export type ResolverCtx = {
	map: StaticMap;
	chatClient: GameClient;
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
	// Allowlist: digits, +-*/^().,spaces, and 'e'/'E' (exponents like 1e3). All other letters rejected.
	// Function() eval is safe here because the allowlist blocks identifiers — no globals can be named.
	if (/[a-df-wyz_$]/i.test(expr))
		toolError("Non-arithmetic identifier in expr");
	try {
		// eslint-disable-next-line no-new-func
		return Function(`"use strict"; return (${expr})`)() as number;
	} catch (e) {
		toolError(`Arithmetic eval error: ${String(e)}`);
	}
}

// Answers spawn_tiles, delivery_tiles, tile_at, or bounds queries against the static map.
function execMapQuery(args: unknown, ctx: ResolverCtx): unknown {
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

// Resolves a predicate token array (e.g. ["delivery","leftmost"]) to map tiles.
function execResolveTile(args: unknown, ctx: ResolverCtx): XY[] {
	const tokens = (args as { tokens?: unknown } | null)?.tokens;
	if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== "string"))
		toolError("resolve_tile requires args.tokens (string array)");
	return resolvePredicateTokens(tokens as PredicateToken[], ctx.map);
}

// Sends a chat message; defaults to replying to the current sender when no recipient is specified.
async function execSendMessage(
	args: unknown,
	ctx: ResolverCtx,
): Promise<string> {
	const a = args as { to?: string; msg: string };
	await ctx.chatClient.say(a.to ?? ctx.senderId, a.msg);
	return "sent";
}

// Dispatches a tool call to its implementation; throws ToolError for unknown tool names.
export async function executeTool(
	call: ToolCall,
	ctx: ResolverCtx,
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
		// "done" is terminal — handled by the resolver loop before executeTool is called; never reaches here.
		default:
			toolError(
				`Unknown tool "${call.tool}". Valid tools: calculate, map_query, resolve_tile, send_message, done.`,
			);
	}
}
