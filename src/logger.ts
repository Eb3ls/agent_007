import chalk, { type ChalkInstance } from "chalk";

const tag = (label: string, color: ChalkInstance) => color.bold(`[${label}]`);

export const log = {
	// Startup / structural events — always visible
	info: (label: string, msg: string) =>
		console.log(tag(label, chalk.cyan) + " " + msg),

	// Positive outcomes: move ok, pickup, deliver
	ok: (label: string, msg: string) =>
		console.log(tag(label, chalk.green) + " " + msg),

	// State changes worth watching: replan, reconsider, stall, wait
	warn: (label: string, msg: string) =>
		console.log(tag(label, chalk.yellow) + " " + msg),

	// Failures and errors: move failed, target unreachable
	error: (label: string, msg: string) =>
		console.log(tag(label, chalk.red) + " " + msg),

	// High-frequency ticks: intent commit, plan step — dim to reduce noise
	debug: (label: string, msg: string) =>
		console.log(chalk.dim(`[${label}] ${msg}`)),
};
