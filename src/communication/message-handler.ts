// ============================================================
// src/communication/message-handler.ts
// Typed message send/receive layer on top of GameClient.
// Handles teamId filtering and belief_share rate limiting.
// ============================================================

import type { GameClient, InterAgentMessage } from '../types.js';
import { isInterAgentMessage } from './message-protocol.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('msg-handler');

const BELIEF_SHARE_MIN_INTERVAL_MS = 1000; // max 1 broadcast/s

export class MessageHandler {
  private readonly client: GameClient;
  private readonly agentId: string;

  /** Only messages from these senderIds are delivered to callbacks (HelloMessage always passes). */
  private readonly allowedSenders = new Set<string>();

  private readonly messageCallbacks: Array<(from: string, msg: InterAgentMessage) => void> = [];

  private lastBeliefShareSentAt = 0;

  constructor(client: GameClient, agentId: string) {
    this.client = client;
    this.agentId = agentId;

    // Wire up the raw GameClient message event.
    this.client.onMessage((from, rawMsg) => {
      this._handleIncoming(from, rawMsg);
    });
  }

  // --- Sender allow-list (used for teamId filtering) ---

  /**
   * Allow messages from the given agentId to be delivered to onMessage callbacks.
   * HelloMessages are always allowed regardless of this list.
   */
  addAllowedSender(agentId: string): void {
    this.allowedSenders.add(agentId);
  }

  removeAllowedSender(agentId: string): void {
    this.allowedSenders.delete(agentId);
  }

  // --- Sending ---

  /**
   * Send a message directly to one agent.
   */
  sendTo(toId: string, msg: InterAgentMessage): void {
    this.client.sendMessage(toId, msg);
    logger.debug({ kind: 'message_sent', msgType: msg.type, to: toId });
  }

  /**
   * Send a targeted message and await a direct reply from the recipient.
   * Resolves with whatever the recipient passes to their reply callback.
   */
  askTo(toId: string, msg: InterAgentMessage): Promise<unknown> {
    logger.debug({ kind: 'message_sent', msgType: msg.type, to: toId });
    return this.client.askMessage(toId, msg);
  }

  /**
   * Consume and return the reply callback stored for a given message seq, if any.
   * Used by handlers to reply inline (via emitAsk) instead of sending a separate message.
   */
  consumeReply(seq: number): ((data: unknown) => void) | undefined {
    return this.client.consumeReply(seq);
  }

  /**
   * Broadcast a message to all agents.
   * `belief_share` messages are rate-limited to at most 1 per second.
   * Returns true if the message was sent, false if rate-limited.
   */
  broadcast(msg: InterAgentMessage): boolean {
    if (msg.type === 'belief_share') {
      const now = Date.now();
      if (now - this.lastBeliefShareSentAt < BELIEF_SHARE_MIN_INTERVAL_MS) {
        return false; // rate-limited
      }
      this.lastBeliefShareSentAt = now;
    }

    this.client.broadcastMessage(msg);
    logger.debug({ kind: 'message_sent', msgType: msg.type, to: 'broadcast' });
    return true;
  }

  // --- Receiving ---

  /**
   * Register a callback for incoming validated inter-agent messages.
   * HelloMessages are always delivered; other message types are filtered
   * to only those from senders added via addAllowedSender().
   */
  onMessage(cb: (from: string, msg: InterAgentMessage) => void): void {
    this.messageCallbacks.push(cb);
  }

  // --- Internal ---

  private _handleIncoming(from: string, rawMsg: unknown): void {
    // Validate message shape
    const msg = isInterAgentMessage(rawMsg) ? rawMsg : null;
    if (msg === null) {
      return; // silently drop malformed messages
    }

    // Skip own messages (can happen with broadcast on some servers)
    if (msg.agentId === this.agentId) {
      return;
    }

    // TeamId filtering: HelloMessages always pass; others require sender registration.
    if (msg.type !== 'hello' && !this.allowedSenders.has(from)) {
      return;
    }

    logger.debug({ kind: 'message_received', msgType: msg.type, from });

    for (const cb of this.messageCallbacks) {
      cb(from, msg);
    }
  }
}
