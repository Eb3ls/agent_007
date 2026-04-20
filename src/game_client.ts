import {
	createPerception,
	setSelf,
	setSensing,
	type Perception,
} from "./perception.js";
import { createWorld, setMap, updateTile, type World } from "./world.js";
import type { DjsClientSocket } from "@unitn-asa/deliveroo-js-sdk";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";

export class GameClient {
	private api: DjsClientSocket;
	public readonly world: World = createWorld();
	public readonly perception: Perception = createPerception();

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

	private logEvent(eventName: string, ...payload: unknown[]): void {
		console.log(`[${eventName}]`, ...payload);
	}

	private wireUpEvents(): void {
		this.api.onMap((width, height, tiles) => {
			setMap(this.world, tiles);
			this.logEvent("map", { tilesCount: tiles.length });
		});

		this.api.onTile((tile) => {
			updateTile(this.world, tile);
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
			this.logEvent("sensing", sensing.positions);
		});

		this.api.onMsg((id, name, msg, reply) => {
			this.logEvent("msg", { from: { id, name }, msg });
			reply({ received: true });
		});

		this.api.onAgentConnected((status, agent) => {
			this.logEvent("agent-connected", { status, agent });
		});
	}
}
