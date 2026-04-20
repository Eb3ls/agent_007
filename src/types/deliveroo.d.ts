declare module "@unitn-asa/deliveroo-js-sdk" {
	export type IOTileType =
		| "0"
		| "1"
		| "2"
		| "3"
		| "4"
		| "5"
		| "5!"
		| "←"
		| "↑"
		| "→"
		| "↓";

	export interface IOTile {
		x: number;
		y: number;
		type: IOTileType;
	}

	export interface IOAgent {
		id: string;
		name: string;
		teamId: string;
		teamName: string;
		x?: number;
		y?: number;
		score: number;
		penalty: number;
	}

	export interface IOParcel {
		id: string;
		x: number;
		y: number;
		carriedBy?: string;
		reward: number;
	}

	export interface IOCrate {
		id: string;
		x: number;
		y: number;
	}

	export interface IOSensing {
		positions: { x: number; y: number }[];
		agents: IOAgent[];
		parcels: IOParcel[];
		crates: IOCrate[];
	}

	export class DjsClientSocket {
		token: Promise<string>;
		me: Promise<IOAgent>;
		config: Promise<any>;
		map: Promise<{ width: number; height: number; tiles: IOTile[] }>;

		connect(): void;
		disconnect(): void;

		onConnect(callback: () => void): void;
		onDisconnect(callback: () => void): void;
		onConfig(callback: (config: any) => void): void;
		onMap(
			callback: (width: number, height: number, tiles: IOTile[]) => void,
		): void;
		onTile(callback: (tile: IOTile) => void): void;
		onAgentConnected(
			callback: (
				status: "connected" | "disconnected",
				agent: Omit<IOAgent, "x" | "y" | "penalty">,
			) => void,
		): void;
		onYou(callback: (agent: IOAgent) => void): void;
		onceYou(callback: (agent: IOAgent) => void): void;
		onSensing(callback: (sensing: IOSensing) => void): void;
		onMsg(
			callback: (
				id: string,
				name: string,
				msg: any,
				reply: (r: any) => void,
			) => void,
		): void;
		onLog(
			callback: (
				src: "server" | { socket: string; id: string; name: string },
				...args: any[]
			) => void,
		): void;

		emitMove(
			direction: "up" | "right" | "left" | "down",
		): Promise<{ x: number; y: number } | false>;
		emitPickup(): Promise<{ id: string }[]>;
		emitPutdown(selected?: string[]): Promise<{ id: string }[]>;
		emitSay(toId: string, msg: any): Promise<"successful" | "failed">;
		emitAsk(toId: string, msg: any): Promise<any>;
		emitShout(msg: any): Promise<any>;
		emitLog(...message: any[]): void;
	}

	export function DjsConnect(
		host?: string,
		token?: string,
		name?: string,
		autoconnect?: boolean,
	): DjsClientSocket;
}
