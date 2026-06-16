import {
	createBeliefStore,
	evictStale,
	markAgentDisconnected,
	recordCompetitorPositions,
	updateFromSensing,
	updateObservedEmptySpawns,
	type BeliefStore,
} from "./belief_store.js";
import {
	createPerception,
	setSelf,
	setSensing,
	type Perception,
} from "./perception.js";
import {
	createStaticMap,
	setMap,
	updateTile,
	type StaticMap,
} from "./static_map.js";
import type {
	DjsClientSocket,
	IOGameConfig,
} from "@unitn-asa/deliveroo-js-sdk";
import { AGENT_TTL_MULT, PARCEL_TTL_MULT } from "./config.js";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import type { Direction } from "./pathfinder.js";

export type MsgCallback = (
	id: string,
	name: string,
	msg: string,
	reply: ((response: string) => void) | null,
) => void;

export class GameClient {
	private api: DjsClientSocket;
	public readonly staticMap: StaticMap = createStaticMap();
	public readonly perception: Perception = createPerception();
	public readonly beliefs: BeliefStore;
	public config: IOGameConfig | null = null;

	private friendlyAgentIds: Set<string> = new Set();
	private msgCallbacks: MsgCallback[] = [];
	private connectResolvers: ((v: { id: string; teamId: string }) => void)[] =
		[];

	public addFriendlyAgent(id: string): void {
		this.friendlyAgentIds.add(id);
	}

	constructor(
		private readonly agentId: string,
		private readonly host: string,
		private readonly token: string,
		beliefs?: BeliefStore,
	) {
		this.beliefs = beliefs ?? createBeliefStore();
		this.api = DjsConnect(host, token, undefined, false);
		this.wireUpEvents();
	}

	/** Resolves on first onYou event (identity confirmed). Safe to call multiple times. */
	public waitForConnect(): Promise<{ id: string; teamId: string }> {
		const self = this.perception.self;
		if (self) return Promise.resolve({ id: self.id, teamId: self.teamId });
		return new Promise((resolve) => this.connectResolvers.push(resolve));
	}

	public connect(): void {
		this.api.connect();
	}

	public disconnect(): void {
		this.api.disconnect();
	}

	public async move(
		direction: Direction,
	): Promise<{ x: number; y: number } | false> {
		return this.api.emitMove(direction);
	}

	public async pickup(): Promise<{ id: string }[]> {
		return this.api.emitPickup();
	}

	/** Puts down parcels. If ids provided, puts down only those parcel ids; otherwise all. */
	public async putdown(ids?: string[]): Promise<{ id: string }[]> {
		return this.api.emitPutdown(ids ?? []);
	}

	public async say(toId: string, msg: string): Promise<void> {
		await this.api.emitSay(toId, msg);
	}

	public async shout(msg: string): Promise<void> {
		await this.api.emitShout(msg);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public async ask(toId: string, msg: string): Promise<unknown> {
		return this.api.emitAsk(toId, msg);
	}

	/** Subscribe to incoming msg/shout/ask events from the server. */
	public onMsg(cb: MsgCallback): void {
		this.msgCallbacks.push(cb);
	}

	private logEvent(eventName: string, ...payload: unknown[]): void {
		console.log(`[${this.agentId}][${eventName}]`, ...payload);
	}

	private wireUpEvents(): void {
		this.api.onConfig((cfg) => {
			this.config = cfg;
			this.logEvent("config", {
				title: cfg.GAME.title,
				movementDuration: cfg.GAME.player.movement_duration,
				decayingEvent: cfg.GAME.parcels.decaying_event,
				capacity: cfg.GAME.player.capacity,
			});
		});

		this.api.onMap((width, height, tiles) => {
			setMap(this.staticMap, tiles);
			this.logEvent("map", {
				tilesCount: tiles.length,
				hasMovingWalls: this.staticMap.hasMovingWalls,
			});
		});

		this.api.onTile((tile) => {
			updateTile(this.staticMap, tile);
		});

		this.api.onYou((agent) => {
			setSelf(this.perception, agent);
		});

		this.api.onceYou((agent) => {
			setSelf(this.perception, agent);
			for (const resolve of this.connectResolvers)
				resolve({ id: agent.id, teamId: agent.teamId });
			this.connectResolvers = [];
		});

		this.api.onSensing((sensing) => {
			setSensing(this.perception, sensing);
			updateFromSensing(this.beliefs, sensing, this.agentId);
			updateObservedEmptySpawns(
				this.beliefs,
				this.staticMap,
				sensing,
				Date.now(),
			);
			if (this.config) {
				const movMs = this.config.GAME.player.movement_duration;
				evictStale(
					this.beliefs,
					movMs * PARCEL_TTL_MULT,
					movMs * AGENT_TTL_MULT,
				);
				recordCompetitorPositions(
					this.beliefs,
					sensing.agents,
					Date.now(),
					movMs,
					this.friendlyAgentIds,
				);
			}
		});

		this.api.onMsg((id, name, msg, reply) => {
			this.logEvent("msg", { from: { id, name }, msg });
			for (const cb of this.msgCallbacks)
				cb(id, name, msg, reply ?? null);
		});

		this.api.onAgentConnected((status, agent) => {
			if (status === "disconnected")
				markAgentDisconnected(this.beliefs, agent.id);
			this.logEvent("agent-connected", { status, agent });
		});
	}
}
