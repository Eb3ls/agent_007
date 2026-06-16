import {
	createBeliefStore,
	updateFromSensing,
	updateObservedEmptySpawns,
	type BeliefStore,
} from "../../belief_store.js";
import type {
	IOAgent,
	IOGameConfig,
	IOSensing,
	IOTile,
} from "@unitn-asa/deliveroo-js-sdk";
import { createPerception as _cp, type Perception } from "../../perception.js";
import { createStaticMap, setMap, type StaticMap } from "../../static_map.js";
import { createPerception, setSelf } from "../../perception.js";
import type { MsgCallback } from "../../game_client.js";
import type { Direction } from "../../pathfinder.js";

export type StubMoveResult = { x: number; y: number } | false;

/**
 * In-process fake for GameClient. No network — events are injected via trigger*() helpers.
 * Implements the same public surface as GameClient so AgentCore can use it directly.
 */
export class StubGameClient {
	public readonly staticMap: StaticMap = createStaticMap();
	public readonly perception: Perception = createPerception();
	public readonly beliefs: BeliefStore;
	public config: IOGameConfig | null = null;

	private readonly msgCallbacks: MsgCallback[] = [];
	private moveResults: StubMoveResult[] = [];
	private pickupResults: { id: string }[][] = [];
	private putdownResults: { id: string }[][] = [];

	constructor(
		private readonly agentId: string,
		beliefs?: BeliefStore,
	) {
		this.beliefs = beliefs ?? createBeliefStore();
	}

	// ── GameClient API ─────────────────────────────────────────────────────────

	public connect(): void {}
	public disconnect(): void {}

	public waitForConnect(): Promise<{ id: string; teamId: string }> {
		const self = this.perception.self;
		return Promise.resolve({
			id: self?.id ?? this.agentId,
			teamId: self?.teamId ?? "team0",
		});
	}

	public async move(_dir: Direction): Promise<StubMoveResult> {
		return this.moveResults.shift() ?? false;
	}

	public async pickup(): Promise<{ id: string }[]> {
		return this.pickupResults.shift() ?? [];
	}

	public async putdown(_ids?: string[]): Promise<{ id: string }[]> {
		return this.putdownResults.shift() ?? [];
	}

	public async say(_toId: string, _msg: string): Promise<void> {}
	public async shout(_msg: string): Promise<void> {}
	public async ask(_toId: string, _msg: string): Promise<unknown> {
		return null;
	}

	public onMsg(cb: MsgCallback): void {
		this.msgCallbacks.push(cb);
	}

	// ── Trigger helpers ────────────────────────────────────────────────────────

	/** Set up a simple tile grid for tests. */
	public triggerMap(tiles: IOTile[]): void {
		setMap(this.staticMap, tiles);
	}

	/** Inject a self identity event. */
	public triggerSelf(agent: IOAgent): void {
		setSelf(this.perception, agent);
	}

	/** Inject a sensing event — updates beliefs and perception. */
	public triggerSensing(sensing: IOSensing): void {
		updateFromSensing(this.beliefs, sensing, this.agentId);
		updateObservedEmptySpawns(
			this.beliefs,
			this.staticMap,
			sensing,
			Date.now(),
		);
	}

	/** Queue move results to be returned in order. */
	public queueMoveResults(...results: StubMoveResult[]): void {
		this.moveResults.push(...results);
	}

	/** Queue pickup results. */
	public queuePickupResults(...results: { id: string }[][]): void {
		this.pickupResults.push(...results);
	}

	/** Queue putdown results. */
	public queuePutdownResults(...results: { id: string }[][]): void {
		this.putdownResults.push(...results);
	}

	/** Fire a scripted incoming msg event. */
	public triggerMsg(
		id: string,
		name: string,
		msg: string,
		reply: ((r: string) => void) | null = null,
	): void {
		for (const cb of this.msgCallbacks) cb(id, name, msg, reply);
	}
}
