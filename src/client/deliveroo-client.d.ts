// Type declarations for @unitn-asa/deliveroo-js-client
// Consolidated from src/types/deliveroo-client.d.ts during T03

declare module '@unitn-asa/deliveroo-js-client' {
    export interface Agent {
        id: string;
        name: string;
        teamId: string;
        teamName: string;
        x: number;
        y: number;
        score: number;
        penalty: number;
    }

    export interface Parcel {
        id: string;
        x: number;
        y: number;
        carriedBy?: string | null;
        reward: number;
    }

    export interface Tile {
        x: number;
        y: number;
        type: string;
    }

    export interface Info {
        ms: number;
        frame: number;
        fps: number;
        heapUsed: number;
        heapTotal: number;
    }

    export interface LogInfo {
        src: 'server' | 'client';
        ms: number;
        frame: number;
        socket: string;
        id: string;
        name: string;
    }

    export interface GameConfig {
        PARCELS_GENERATION_INTERVAL?: string;
        PARCELS_MAX?: number;
        PARCEL_REWARD_AVG?: number;
        PARCEL_REWARD_VARIANCE?: number;
        PARCEL_DECADING_INTERVAL?: string;
        PENALTY?: number;
        MOVEMENT_STEPS?: number;
        MOVEMENT_DURATION?: number;
        AGENTS_OBSERVATION_DISTANCE?: number;
        PARCELS_OBSERVATION_DISTANCE?: number;
        CLOCK?: number;
        [key: string]: unknown;
    }

    export class DeliverooApi {
        constructor(host: string, token?: string | null, autoconnect?: boolean);

        // Promises
        token: Promise<string>;
        me: Promise<Agent>;
        config: Promise<GameConfig>;
        map: Promise<{ width: number; height: number; tiles: Tile[] }>;

        // Connections
        connect(): any;
        disconnect(): any;

        // Event Listeners
        onConnect(callback: () => void): void;
        onDisconnect(callback: () => void): void;
        onConfig(callback: (config: GameConfig) => void): void;
        onMap(callback: (width: number, height: number, tiles: Tile[]) => void): void;
        onTile(callback: (tile: Tile, info: Info) => void): void;
        onAgentConnected(callback: (status: 'connected' | 'disconnected', agent: Omit<Agent, 'x' | 'y' | 'penalty'>) => void): void;
        onYou(callback: (agent: Agent, info: Info) => void): void;
        onceYou(callback: (agent: Agent, info: Info) => void): void;
        onAgentsSensing(callback: (agents: Agent[]) => void): void;
        onParcelsSensing(callback: (parcels: Parcel[]) => void): void;
        onMsg(callback: (id: string, name: string, msg: any, replyAcknowledgmentCallback: (reply: any) => void) => void): void;
        onLog(callback: (info: LogInfo, ...msgArgs: any[]) => void): void;

        // Event Emitters
        emitSay(toId: string, msg: any): Promise<'successful'>;
        emitAsk(toId: string, msg: any): Promise<any>;
        emitShout(msg: any): Promise<any>;
        emitMove(directionOrXy: 'up' | 'right' | 'left' | 'down' | { x: number; y: number }): Promise<{ x: number; y: number } | false>;
        emitPickup(): Promise<{ id: string }[]>;
        emitPutdown(selected?: string[] | null): Promise<{ id: string }[]>;
        emitLog(...message: any[]): void;
    }

    export function sleep(ms: number): Promise<void>;
}
