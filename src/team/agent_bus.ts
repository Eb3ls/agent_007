import type { Directive } from "./directives.js";
import { EventEmitter } from "node:events";

export type ConfirmPayload = {
	missionId: string;
	directiveType: string;
	result: "reached" | "dropped" | "paused";
	agentId: string;
};

export type ReleasePayload = {
	missionId: string;
	scope: "global" | "per-agent";
};

export class AgentBus extends EventEmitter {
	private readonly queue = new Map<string, Directive[]>(); // agentId → directives
	private readonly armedSignals = new Set<string>();

	emitDirective(agentId: string, d: Directive): void {
		let q = this.queue.get(agentId);
		if (!q) {
			q = [];
			this.queue.set(agentId, q);
		}
		q.push(d);
		this.emit("directive", agentId, d);
	}

	drainDirectives(agentId: string): Directive[] {
		const q = this.queue.get(agentId);
		return q ? q.splice(0, q.length) : [];
	}

	emitCarryChange(agentId: string): void {
		this.emit("carry_change", agentId);
	}

	onCarryChange(cb: (agentId: string) => void): void {
		this.on("carry_change", cb);
	}

	emitConfirm(payload: ConfirmPayload): void {
		this.emit("CONFIRM", payload);
	}

	onConfirm(cb: (payload: ConfirmPayload) => void): void {
		this.on("CONFIRM", cb);
	}

	armSignal(token: string): void {
		this.armedSignals.add(token.toLowerCase());
	}

	disarmSignal(token: string): void {
		this.armedSignals.delete(token.toLowerCase());
	}

	emitSignal(token: string): void {
		const t = token.toLowerCase();
		this.armedSignals.delete(t);
		this.emit("SIGNAL", t);
	}

	onSignal(cb: (token: string) => void): void {
		this.on("SIGNAL", cb);
	}

	emitRelease(payload: ReleasePayload): void {
		this.emit("RELEASE", payload);
	}

	onRelease(cb: (payload: ReleasePayload) => void): void {
		this.on("RELEASE", cb);
	}
}
