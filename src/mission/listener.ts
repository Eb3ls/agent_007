import type { AgentBus } from "../team/agent_bus.js";
import type { GameClient } from "../game_client.js";
import { log } from "../logger.js";

export type QueuedMessage = {
	text: string;
	senderId: string;
	replyFn: ((msg: string) => void) | null;
};

export class Listener {
	private readonly queue: QueuedMessage[] = [];
	private readonly seen = new Set<string>(); // dedup by hash(text+senderId)
	private readonly armedTokens = new Set<string>();
	private readonly allowlist: string; // SERVER_AGENT_NAME

	constructor(
		private readonly bus: AgentBus,
		allowedSenderName: string,
	) {
		this.allowlist = allowedSenderName.toLowerCase();
	}

	/** Subscribe to msg/shout events on both clients. */
	attachClient(client: GameClient): void {
		client.onMsg((id, name, msg, reply) => {
			this.handleIncoming(id, name, msg, reply);
		});
	}

	armToken(token: string): void {
		this.armedTokens.add(token.toLowerCase());
	}

	drain(): QueuedMessage[] {
		return this.queue.splice(0);
	}

	private handleIncoming(
		senderId: string,
		senderName: string,
		text: string,
		reply: ((response: string) => void) | null,
	): void {
		if (senderName.toLowerCase() !== this.allowlist) return;

		const dedupeKey = `${senderId}:${text}`;
		if (this.seen.has(dedupeKey)) return;
		this.seen.add(dedupeKey);

		const textLower = text.toLowerCase();
		for (const token of this.armedTokens) {
			if (textLower.includes(token)) {
				this.armedTokens.delete(token);
				this.bus.emitSignal(token);
				log.info("listener", `signal emitted token=${token}`);
				return; // signal message consumed; don't enqueue
			}
		}

		log.info("listener", `queued from=${senderName} len=${text.length}`);
		this.queue.push({ text, senderId, replyFn: reply });
	}
}
