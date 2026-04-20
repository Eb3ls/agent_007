import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

export class GameClient {
	private api: DeliverooApi;

	constructor(
		private readonly host: string,
		private readonly token: string,
	) {
		this.api = new DeliverooApi(host, token, false);
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
		this.api.onConnect(() => {
			this.logEvent("connect");
		});

		this.api.onDisconnect(() => {
			this.logEvent("disconnect");
		});

		this.api.onConfig((config) => {
			this.logEvent("config", config);
		});

		this.api.onMap((width, height, tiles) => {
			this.logEvent(
				"map",
				{ width, height, tilesCount: tiles.length },
				tiles,
			);
		});

		this.api.onTile((tile) => {
			this.logEvent("tile", tile);
		});

		this.api.onAgentConnected((status, agent) => {
			this.logEvent("agent-connected", { status, agent });
		});

		this.api.onYou((agent) => {
			this.logEvent("you", agent);
		});

		this.api.onceYou((agent) => {
			this.logEvent("once-you", agent);
		});

		this.api.onAgentsSensing((agents, timestamp) => {
			this.logEvent("agents-sensing", { agents, timestamp });
		});

		this.api.onParcelsSensing((parcels, timestamp) => {
			this.logEvent("parcels-sensing", { parcels, timestamp });
		});

		this.api.onMsg((id, name, msg, replyAcknowledgmentCallback) => {
			this.logEvent("msg", { from: { id, name }, msg });
			replyAcknowledgmentCallback({ received: true });
		});

	}
}
