import {
	AGENT_TTL_MULT,
	PARCEL_TTL_MULT,
	createBeliefStore,
	evictStale,
	markAgentDisconnected,
	updateFromSensing,
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
import type { Direction } from "./pathfinder.js";
import type {
	DjsClientSocket,
	IOGameConfig,
} from "@unitn-asa/deliveroo-js-sdk";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

export class GameClient {
	private api: DjsClientSocket;
	public readonly staticMap: StaticMap = createStaticMap();
	public readonly perception: Perception = createPerception();
	public readonly beliefs: BeliefStore = createBeliefStore();
	public config: IOGameConfig | null = null;

	constructor(
		private readonly host: string,
		private readonly token: string,
	) {
		this.api = DjsConnect(host, token, undefined, false);
		this.wireUpEvents();
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

	public async putdown(): Promise<{ id: string }[]> {
		return this.api.emitPutdown();
	}

	private logEvent(eventName: string, ...payload: unknown[]): void {
		console.log(`[${eventName}]`, ...payload);
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
			this.logEvent("tile", tile);
		});

		this.api.onYou((agent) => {
			setSelf(this.perception, agent);
			this.logEvent("you", agent);
		});

		this.api.onceYou((agent) => {
			setSelf(this.perception, agent);
		});

		this.api.onSensing((sensing) => {
			setSensing(this.perception, sensing);
			updateFromSensing(this.beliefs, sensing);
			if (this.config) {
				const movMs = this.config.GAME.player.movement_duration;
				evictStale(this.beliefs, movMs * PARCEL_TTL_MULT, movMs * AGENT_TTL_MULT);
			}
			this.logEvent("sensing", {
				agents: sensing.agents.length,
				parcels: sensing.parcels.length,
				crates: sensing.crates.length,
			});
		});

		this.api.onMsg((id, name, msg, reply) => {
			this.logEvent("msg", { from: { id, name }, msg });
			reply({ received: true });
		});

		this.api.onAgentConnected((status, agent) => {
			if (status === "disconnected")
				markAgentDisconnected(this.beliefs, agent.id);
			this.logEvent("agent-connected", { status, agent });
		});
	}
}
