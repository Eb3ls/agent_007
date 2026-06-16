import {
	createBeliefStore,
	evictStale,
	markAgentDisconnected,
	recordCompetitorPositions,
	seedCrateOccupancy,
	updateCrateOccupancy,
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
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import type { Direction } from "./pathfinder.js";
import { cfg as appCfg } from "./config.js";

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

	private confirmedSelf(): { x: number; y: number } | null {
		const self = this.perception.self;
		if (
			self?.x === undefined ||
			self?.y === undefined ||
			!Number.isInteger(self.x) ||
			!Number.isInteger(self.y)
		)
			return null;
		return { x: self.x, y: self.y };
	}

	private async recoverableAction<T>(
		action: string,
		execute: () => Promise<T>,
		fallback: () => T,
	): Promise<T> {
		try {
			return await execute();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			const isTimeout =
				error instanceof Error && /timed out/i.test(error.message);
			this.logEvent(
				`${action}-error`,
				isTimeout
					? `${action} timed out: ${message}`
					: `${action} failed: ${message}`,
			);
			return fallback();
		}
	}

	public async move(
		direction: Direction,
	): Promise<{ x: number; y: number } | false> {
		const before = this.confirmedSelf();
		return this.recoverableAction(
			"move",
			() => this.api.emitMove(direction),
			() => {
				const after = this.confirmedSelf();
				if (
					after &&
					(!before || after.x !== before.x || after.y !== before.y)
				)
					return after;
				return false;
			},
		);
	}

	public async pickup(): Promise<{ id: string }[]> {
		return this.recoverableAction(
			"pickup",
			() => this.api.emitPickup(),
			() => [],
		);
	}

	/** Puts down parcels. If ids provided, puts down only those parcel ids; otherwise all. */
	public async putdown(ids?: string[]): Promise<{ id: string }[]> {
		return this.recoverableAction(
			"putdown",
			() => this.api.emitPutdown(ids ?? []),
			() => [],
		);
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
			seedCrateOccupancy(this.beliefs, this.staticMap);
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
			updateCrateOccupancy(this.beliefs, this.staticMap, sensing);
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
					movMs * appCfg.belief.parcel_ttl_mult,
					movMs * appCfg.belief.agent_ttl_mult,
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
