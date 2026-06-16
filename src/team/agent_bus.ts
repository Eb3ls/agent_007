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

	// Coordinator → Agent: push a directive into the agent's queue and notify
	emitDirective(agentId: string, d: Directive): void {
		let q = this.queue.get(agentId);
		if (!q) {
			q = [];
			this.queue.set(agentId, q);
		}
		q.push(d);
		this.emit("directive", agentId, d);
	}

	// Agent: pull all pending directives (called on "directive" event)
	drainDirectives(agentId: string): Directive[] {
		const q = this.queue.get(agentId);
		return q ? q.splice(0, q.length) : [];
	}

	// Agent → Coordinator: notify that carried parcels changed
	emitCarryChange(agentId: string): void {
		this.emit("carry_change", agentId);
	}

	// Coordinator: subscribe to carry-change notifications
	onCarryChange(cb: (agentId: string) => void): void {
		this.on("carry_change", cb);
	}

	// Agent → Coordinator: confirm mission outcome (reached / dropped / paused)
	emitConfirm(payload: ConfirmPayload): void {
		this.emit("CONFIRM", payload);
	}

	// Coordinator: subscribe to mission confirmations
	onConfirm(cb: (payload: ConfirmPayload) => void): void {
		this.on("CONFIRM", cb);
	}

	// Coordinator: mark a token as expected before firing emitSignal
	armSignal(token: string): void {
		this.armedSignals.add(token.toLowerCase());
	}

	// Coordinator: cancel a previously armed token without firing
	disarmSignal(token: string): void {
		this.armedSignals.delete(token.toLowerCase());
	}

	// Coordinator → Agent (broadcast): fire the token once and remove it from armed set
	emitSignal(token: string): void {
		const t = token.toLowerCase();
		this.armedSignals.delete(t);
		this.emit("SIGNAL", t);
	}

	// Agent: subscribe to signal broadcasts; returns a disposer to unsubscribe
	onSignal(cb: (token: string) => void): () => void {
		this.on("SIGNAL", cb);
		return () => this.off("SIGNAL", cb);
	}

	// Coordinator → Agent (broadcast): release agents from a mission
	emitRelease(payload: ReleasePayload): void {
		this.emit("RELEASE", payload);
	}

	// Agent: subscribe to release broadcasts
	onRelease(cb: (payload: ReleasePayload) => void): void {
		this.on("RELEASE", cb);
	}
}
