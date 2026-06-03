import chalk, { type ChalkInstance } from "chalk";
import { LOG_LEVEL } from "./config.js";

const tag = (label: string, color: ChalkInstance) => color.bold(`[${label}]`);
const noop = (_label: string, _msg: string) => {};
const silent = LOG_LEVEL === "silent";
const debugEnabled = LOG_LEVEL === "debug";

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
