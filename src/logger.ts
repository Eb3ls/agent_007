import chalk, { type ChalkInstance } from "chalk";
import { appendFileSync } from "fs";
import { cfg } from "./config.js";

const tag = (label: string, color: ChalkInstance) => color.bold(`[${label}]`);
const noop = (_label: string, _msg: string) => {};
const silent = cfg.log.level === "silent";
const debugEnabled = cfg.log.level === "debug";

export const log = {
	// Startup / structural events — always visible
	info: silent
		? noop
		: (label: string, msg: string) =>
				console.log(tag(label, chalk.cyan) + " " + msg),

	// Positive outcomes: move ok, pickup, deliver
	ok: silent
		? noop
		: (label: string, msg: string) =>
				console.log(tag(label, chalk.green) + " " + msg),

	// State changes worth watching: replan, reconsider, stall, wait
	warn: silent
		? noop
		: (label: string, msg: string) =>
				console.log(tag(label, chalk.yellow) + " " + msg),

	// Failures and errors: move failed, target unreachable
	error: silent
		? noop
		: (label: string, msg: string) =>
				console.log(tag(label, chalk.red) + " " + msg),

	// High-frequency ticks: intent commit, plan step — only shown in debug mode
	debug:
		silent || !debugEnabled
			? noop
			: (label: string, msg: string) =>
					console.log(chalk.dim(`[${label}] ${msg}`)),
};

// JSONL decision log — one record per line, appended to decisions.jsonl.
// Used for graded BDI report evidence and post-match analysis.
let jsonlBuffer: string[] = [];

export function logDecision(
	agentId: string,
	record: Record<string, unknown>,
): void {
	jsonlBuffer.push(
		JSON.stringify({ ts: Date.now(), agent: agentId, ...record }),
	);
}

export function flushDecisionLog(path = "decisions.jsonl"): void {
	if (jsonlBuffer.length === 0) return;
	appendFileSync(path, jsonlBuffer.join("\n") + "\n", "utf8");
	jsonlBuffer = [];
}

// Flush on process exit so no records are lost.
process.on("exit", () => flushDecisionLog());
process.on("SIGINT", () => {
	flushDecisionLog();
	process.exit(0);
});
