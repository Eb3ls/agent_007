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
	private readonly armedTokens = new Set<string>();
	private readonly allowlist: string; // SERVER_AGENT_NAME

	constructor(
		private readonly bus: AgentBus,
		allowedSenderName: string,
	) {
		this.allowlist = allowedSenderName.toLowerCase();
	}

	/** Register msg/shout handler on the given client. */
	attachClient(client: GameClient): void {
		client.onMsg((id, name, msg, reply) => {
			this.handleIncoming(id, name, msg, reply);
		});
	}

	// Registers a word; the next message containing it fires a signal instead of being queued.
	armToken(token: string): void {
		this.armedTokens.add(token.toLowerCase());
	}

	// Returns and clears all pending messages.
	drain(): QueuedMessage[] {
		return this.queue.splice(0);
	}

	// Filters by allowlist, checks armed tokens, then queues or fires a signal.
	private handleIncoming(
		senderId: string,
		senderName: string,
		text: string,
		reply: ((response: string) => void) | null,
	): void {
		if (senderName.toLowerCase() !== this.allowlist) return;

		// token fires only if it matches the entire message (ignoring case), to avoid false positives on common words
		const textLower = text.toLowerCase();
		for (const token of this.armedTokens) {
			if (textLower === token) {
				this.armedTokens.delete(token);
				this.bus.emitSignal(token);
				log.info("listener", `signal emitted token=${token}`);
				return; // signal message consumed; don't enqueue
			}
		}

		this.queue.push({ text, senderId, replyFn: reply });
	}
}
