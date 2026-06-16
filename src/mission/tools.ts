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

export async function executeTool(
	call: ToolCall,
	ctx: L1Ctx,
): Promise<unknown> {
	switch (call.tool) {
		case "calculate": {
			const expr = String(
				(call.args as { expr?: string }).expr ?? call.args,
			);
			// Only allow arithmetic (digits, operators, parens, dots, spaces).
			if (/[a-df-wyz_$]/i.test(expr))
				throw {
					error: "Non-arithmetic identifier in expr",
					recoverable: true,
				} satisfies ToolError;
			let result: number;
			try {
				// eslint-disable-next-line no-new-func
				result = Function(`"use strict"; return (${expr})`)() as number;
			} catch (e) {
				throw {
					error: `Arithmetic eval error: ${String(e)}`,
					recoverable: true,
				} satisfies ToolError;
			}
			return result;
		}
		case "map_query": {
			const a = call.args as {
				query: string;
				x?: number;
				y?: number;
			};
			switch (a.query) {
				case "spawn_tiles":
					return ctx.map.spawnTileIds.map((id) =>
						idToXY(ctx.map, id),
					);
				case "delivery_tiles":
					return ctx.map.deliveryTileIds.map((id) =>
						idToXY(ctx.map, id),
					);
				case "tile_at":
					if (a.x === undefined || a.y === undefined)
						throw {
							error: "tile_at requires x and y",
							recoverable: true,
						} satisfies ToolError;
					return ctx.map.tiles.get(`${a.x},${a.y}`)?.type ?? null;
				case "bounds":
					return {
						width: ctx.map.gridWidth,
						height: ctx.map.gridHeight,
						minX: ctx.map.minX,
						minY: ctx.map.minY,
					};
				default:
					throw {
						error: `Unknown map query: ${a.query}`,
						recoverable: true,
					} satisfies ToolError;
			}
		}
		case "resolve_tile": {
			const label = String(
				(call.args as { label?: string }).label ?? call.args,
			);
			const resolved = resolveLabel(label, ctx.map);
			return resolved;
		}
		case "send_message": {
			const a = call.args as { to?: string; msg: string };
			await ctx.bdiClient.say(a.to ?? ctx.senderId, a.msg);
			return "sent";
		}
		case "done":
			// Terminal — l1_executor handles this directly; return the args.
			return call.args;
		default:
			throw {
				error: `Unknown tool: ${call.tool}`,
				recoverable: false,
			} satisfies ToolError;
	}
}
