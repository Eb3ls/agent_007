// ============================================================
// src/client/game-client.ts — Typed wrapper around @unitn-asa/deliveroo-js-client
// This is the ONLY file that imports the JS client directly.
// ============================================================

import { DeliverooApi } from '@unitn-asa/deliveroo-js-client';
import type { GameConfig } from '@unitn-asa/deliveroo-js-client';
import { EventBuffer, type BufferedEvent } from './event-buffer.js';
import type {
  Tile,
  TileType,
  Direction,
  RawSelfSensing,
  RawParcelSensing,
  RawAgentSensing,
  InterAgentMessage,
} from '../types.js';

// --- Callback types ---

type MapCallback = (tiles: ReadonlyArray<Tile>, width: number, height: number) => void;
type YouCallback = (self: RawSelfSensing) => void;
type ParcelsCallback = (parcels: ReadonlyArray<RawParcelSensing>) => void;
type AgentsCallback = (agents: ReadonlyArray<RawAgentSensing>) => void;
type MessageCallback = (from: string, msg: InterAgentMessage) => void;
type VoidCallback = () => void;

// --- Tile type mapping ---

function parseTileType(raw: string | number): TileType {
  const s = String(raw).trim();
  if (s === "↑") return 4; // one-way up    (enter moving up)
  if (s === "↓") return 5; // one-way down  (enter moving down)
  if (s === "←") return 6; // one-way left  (enter moving left)
  if (s === "→") return 7; // one-way right (enter moving right)
  const n = parseInt(s, 10);
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  if (n === 4) return 1; // base/spawn tile — parcel-spawning (same as internal type 1)
  if (n === 5) return 5; // one-way ↓ — covers "5" and "5!" (parseInt strips suffix)
  return 0; // unknown — treat as non-walkable
}

export class GameClient {
  private api: DeliverooApi;
  private eventBuffer: EventBuffer;

  // Callbacks
  private mapCallbacks: MapCallback[] = [];
  private youCallbacks: YouCallback[] = [];
  private parcelsCallbacks: ParcelsCallback[] = [];
  private agentsCallbacks: AgentsCallback[] = [];
  private messageCallbacks: MessageCallback[] = [];
  private disconnectCallbacks: VoidCallback[] = [];
  private reconnectCallbacks: VoidCallback[] = [];

  // Action duration measurement
  private moveDurations: number[] = [];
  private measuredActionDurationMs = 500; // default fallback

  // Reply callbacks stored when messages arrive via emitAsk (keyed by msg.seq)
  private readonly pendingReplies = new Map<number, (data: unknown) => void>();

  // Server config (populated after connect)
  private serverConfig: GameConfig | null = null;

  constructor(
    private readonly host: string,
    private readonly token: string,
  ) {
    // Create the API client but don't auto-connect — we'll call connect() explicitly
    this.api = new DeliverooApi(host, token, false);
    this.eventBuffer = new EventBuffer();

    this.wireUpEvents();
  }

  private wireUpEvents(): void {
    // Map event: received once on connection
    this.api.onMap((width, height, rawTiles) => {
      const tiles: Tile[] = rawTiles.map(t => ({
        x: t.x,
        y: t.y,
        type: parseTileType(t.type),
      }));
      // Server reports width/height as max coordinate index (0-based),
      // so actual grid dimensions are (width+1) × (height+1).
      const gridWidth  = width  + 1;
      const gridHeight = height + 1;
      const event: BufferedEvent = { kind: 'map', tiles, width: gridWidth, height: gridHeight };
      if (!this.eventBuffer.isDrained()) {
        this.eventBuffer.push(event);
      } else {
        this.dispatchMap(tiles, gridWidth, gridHeight);
      }
    });

    // Self updates
    this.api.onYou((agent, _info) => {
      const self: RawSelfSensing = {
        id: agent.id,
        name: agent.name,
        x: agent.x,
        y: agent.y,
        score: agent.score,
        penalty: agent.penalty,
      };
      const event: BufferedEvent = { kind: 'you', self };
      if (!this.eventBuffer.isDrained()) {
        this.eventBuffer.push(event);
      } else {
        this.dispatchYou(self);
      }
    });

    // Parcel sensing
    // The server sends all sensed tiles; only tiles with a parcel have the `parcel` field.
    this.api.onParcelsSensing((entries) => {
      const parcels: RawParcelSensing[] = entries
        .filter(e => e.parcel != null)
        .map(e => {
          const p = e.parcel!;
          return {
            id: p.id,
            x: p.x,
            y: p.y,
            carriedBy: p.carriedBy ?? null,
            reward: p.reward,
          };
        });
      const event: BufferedEvent = { kind: 'parcels', parcels };
      if (!this.eventBuffer.isDrained()) {
        this.eventBuffer.push(event);
      } else {
        this.dispatchParcels(parcels);
      }
    });

    // Agent sensing
    this.api.onAgentsSensing((entries) => {
      const agents: RawAgentSensing[] = entries
        .filter(e => e.agent != null)
        .map(e => {
          const a = e.agent!;
          return {
            id: a.id,
            name: a.name,
            x: a.x,
            y: a.y,
            score: a.score,
          };
        });
      const event: BufferedEvent = { kind: 'agents', agents };
      if (!this.eventBuffer.isDrained()) {
        this.eventBuffer.push(event);
      } else {
        this.dispatchAgents(agents);
      }
    });

    // Inter-agent messages
    this.api.onMsg((id, _name, msg, reply) => {
      // Attempt to parse as InterAgentMessage
      if (msg && typeof msg === 'object' && 'type' in msg) {
        const typedMsg = msg as InterAgentMessage;
        // Store the reply fn (present when message was sent via emitAsk)
        if (typeof reply === 'function' && 'seq' in typedMsg) {
          this.pendingReplies.set((typedMsg as { seq: number }).seq, reply);
        }
        const event: BufferedEvent = {
          kind: 'message',
          from: id,
          msg: typedMsg,
        };
        if (!this.eventBuffer.isDrained()) {
          this.eventBuffer.push(event);
        } else {
          this.dispatchMessage(id, typedMsg);
        }
      }
    });

    // Disconnect / reconnect
    this.api.onDisconnect(() => {
      for (const cb of this.disconnectCallbacks) cb();
    });

    this.api.onConnect(() => {
      // onConnect fires on initial connect AND reconnects.
      // Only treat as reconnect if we've already drained (i.e., were previously connected).
      if (this.eventBuffer.isDrained()) {
        for (const cb of this.reconnectCallbacks) cb();
      }
    });
  }

  // --- Dispatch helpers ---

  private dispatchMap(tiles: ReadonlyArray<Tile>, width: number, height: number): void {
    for (const cb of this.mapCallbacks) cb(tiles, width, height);
  }

  private dispatchYou(self: RawSelfSensing): void {
    for (const cb of this.youCallbacks) cb(self);
  }

  private dispatchParcels(parcels: ReadonlyArray<RawParcelSensing>): void {
    for (const cb of this.parcelsCallbacks) cb(parcels);
  }

  private dispatchAgents(agents: ReadonlyArray<RawAgentSensing>): void {
    for (const cb of this.agentsCallbacks) cb(agents);
  }

  private dispatchMessage(from: string, msg: InterAgentMessage): void {
    for (const cb of this.messageCallbacks) cb(from, msg);
  }

  // --- Public: Connection ---

  async connect(): Promise<void> {
    this.api.connect();

    // Wait for initial data to arrive
    const [serverConfig] = await Promise.all([
      this.api.config,
      this.api.map,
      this.api.me,
    ]);

    this.serverConfig = serverConfig;

    // Use MOVEMENT_DURATION from server config if available
    if (serverConfig.MOVEMENT_DURATION != null) {
      this.measuredActionDurationMs = serverConfig.MOVEMENT_DURATION;
    }
  }

  disconnect(): void {
    this.api.disconnect();
  }

  // --- Public: Actions ---

  async move(direction: Direction): Promise<boolean> {
    const start = Date.now();
    const result = await this.api.emitMove(direction);
    const duration = Date.now() - start;

    // Measure action duration from first moves
    if (this.moveDurations.length < 5) {
      this.moveDurations.push(duration);
      if (this.moveDurations.length >= 3) {
        const sum = this.moveDurations.reduce((a, b) => a + b, 0);
        this.measuredActionDurationMs = Math.round(sum / this.moveDurations.length);
      }
    }

    return result !== false;
  }

  async pickup(): Promise<ReadonlyArray<RawParcelSensing>> {
    const result = await this.api.emitPickup();
    // The server returns [{id}], but we need RawParcelSensing.
    // Pickup returns minimal data — map to what we have.
    return result.map(p => ({
      id: p.id,
      x: 0, // position not returned by pickup
      y: 0,
      carriedBy: null,
      reward: 0,
    }));
  }

  async putdown(): Promise<ReadonlyArray<RawParcelSensing>> {
    const result = await this.api.emitPutdown();
    return result.map(p => ({
      id: p.id,
      x: 0,
      y: 0,
      carriedBy: null,
      reward: 0,
    }));
  }

  // --- Public: Messaging ---

  sendMessage(toId: string, msg: InterAgentMessage): void {
    this.api.emitSay(toId, msg);
  }

  broadcastMessage(msg: InterAgentMessage): void {
    this.api.emitShout(msg);
  }

  askMessage(toId: string, msg: InterAgentMessage): Promise<unknown> {
    return this.api.emitAsk(toId, msg);
  }

  consumeReply(seq: number): ((data: unknown) => void) | undefined {
    const fn = this.pendingReplies.get(seq);
    this.pendingReplies.delete(seq);
    return fn;
  }

  // --- Public: Event subscriptions ---

  onMap(cb: MapCallback): void {
    this.mapCallbacks.push(cb);
  }

  onYou(cb: YouCallback): void {
    this.youCallbacks.push(cb);
  }

  onParcelsSensing(cb: ParcelsCallback): void {
    this.parcelsCallbacks.push(cb);
  }

  onAgentsSensing(cb: AgentsCallback): void {
    this.agentsCallbacks.push(cb);
  }

  onMessage(cb: MessageCallback): void {
    this.messageCallbacks.push(cb);
  }

  onDisconnect(cb: VoidCallback): void {
    this.disconnectCallbacks.push(cb);
  }

  onReconnect(cb: VoidCallback): void {
    this.reconnectCallbacks.push(cb);
  }

  // --- Public: Event buffer ---

  drainPending(): void {
    this.eventBuffer.drain((event) => {
      switch (event.kind) {
        case 'map':
          this.dispatchMap(event.tiles, event.width, event.height);
          break;
        case 'you':
          this.dispatchYou(event.self);
          break;
        case 'parcels':
          this.dispatchParcels(event.parcels);
          break;
        case 'agents':
          this.dispatchAgents(event.agents);
          break;
        case 'message':
          this.dispatchMessage(event.from, event.msg);
          break;
      }
    });
  }

  // --- Public: Metrics ---

  getMeasuredActionDurationMs(): number {
    return this.measuredActionDurationMs;
  }

  getServerConfig(): GameConfig | null {
    return this.serverConfig;
  }

  getServerCapacity(): number {
    // Server sends capacity at GAME.player.capacity (nested under the GAME sub-object).
    const game = this.serverConfig?.['GAME'] as { player?: { capacity?: unknown } } | null | undefined;
    const cap = game?.player?.capacity;
    return typeof cap === 'number' && cap > 0 ? cap : Infinity;
  }

  getParcelsObservationDistance(): number {
    const dist = this.serverConfig?.PARCELS_OBSERVATION_DISTANCE;
    return typeof dist === 'number' && dist > 0 ? dist : 0;
  }
}
