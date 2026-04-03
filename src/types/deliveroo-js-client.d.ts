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
        carriedBy?: string;
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

    export class DeliverooApi {
        /**
         * Initialize the API client
         * @param host Server URL to connect to
         * @param token Optional token for authentication. If not provided, it will fallback to name from CLI options
         * @param autoconnect Whether to automatically connect on instantiation. Default is true.
         */
        constructor(host: string, token?: string | null, autoconnect?: boolean);

        // Promises
        /** Promise that resolves with the authentication token assigned to this agent */
        token: Promise<string>;
        /** Promise that resolves with the agent's own data (id, name, score, etc.) when received */
        me: Promise<Agent>;
        /** Promise that resolves with the server configuration when received */
        config: Promise<any>;
        /** Promise that resolves with the static map data (width, height, and tiles) when received */
        map: Promise<{ width: number; height: number; tiles: Tile[] }>;

        // Connections
        /** Connect socket to the server manually */
        connect(): any;
        /** Disconnect socket from the server */
        disconnect(): any;

        // Event Listeners
        /** Listen for when the socket successfully connects to the server */
        onConnect(callback: () => void): void;
        /** Listen for when the socket disconnects from the server */
        onDisconnect(callback: () => void): void;
        /** Listen for server configuration updates */
        onConfig(callback: (config: any) => void): void;
        /** Listen for map data updates */
        onMap(callback: (width: number, height: number, tiles: Tile[]) => void): void;
        /** Listen for updates on an individual tile on the map */
        onTile(callback: (tile: Tile) => void): void;
        /** Listen for when another agent connects or disconnects */
        onAgentConnected(callback: (status: 'connected' | 'disconnected', agent: Omit<Agent, 'x' | 'y' | 'penalty'>) => void): void;
        /** Listen continuously for updates to the agent's own state (score, position, etc.) */
        onYou(callback: (agent: Agent) => void): void;
        /** Listen once for an update to the agent's own state */
        onceYou(callback: (agent: Agent) => void): void;
        /** Listen for unified sensing event (agents + parcels + crates + positions). Replaces onAgentsSensing / onParcelsSensing / onCratesSensing. */
        onSensing(callback: (data: { positions: Array<{x:number;y:number}>; agents: Agent[]; parcels: Parcel[]; crates: Array<{id:string;x:number;y:number}> }) => void): void;
        /** Clock/timing info emitted every frame (formerly bundled with 'you'/'tile'). */
        onInfo(callback: (info: Info) => void): void;
        /** Listen for incoming messages from other agents */
        onMsg(callback: (id: string, name: string, msg: any, replyAcknowledgmentCallback: (reply: any) => void) => void): void;
        /** Listen for log events broadcasted by either the server or other clients */
        onLog(callback: (info: LogInfo, ...msgArgs: any[]) => void): void;

        // Event Emitters
        /** 
         * Send a direct message to another agent by ID.
         * Resolves to 'successful' when the message is delivered.
         */
        emitSay(toId: string, msg: any): Promise<'successful'>;
        /**
         * Send a direct message to another agent and wait for their reply.
         * Resolves to the data returned in their reply acknowledgment.
         */
        emitAsk(toId: string, msg: any): Promise<any>;
        /**
         * Broadcast a message to all agents.
         * Resolves when the server acknowledges the broadcast.
         */
        emitShout(msg: any): Promise<any>;
        /**
         * Attempt to move the agent.
         * @param directionOrXy Can be a direction string ('up', 'right', 'left', 'down') or a coordinate object {x,y}
         * @returns Promise resolving to the new {x,y} coordinates on success, or false if the move failed (e.g., hit a wall)
         */
        emitMove(direction: 'up' | 'right' | 'left' | 'down'): Promise<{ x: number; y: number } | false>;
        /**
         * Pick up all parcels located on the agent's current tile.
         * @returns Promise resolving to an array of picked up parcel objects
         */
        emitPickup(): Promise<{ id: string }[]>;
        /**
         * Put down parcels from the agent's inventory.
         * @param selected Optional array of parcel IDs to drop. If nothing is provided, all carried parcels are dropped.
         * @returns Promise resolving to an array of dropped parcel objects
         */
        emitPutdown(selected?: string[] | null): Promise<{ id: string }[]>;
        /**
         * Broadcast a custom log message to the server, which then broadcasts it to other connected clients.
         */
        emitLog(...message: any[]): void;
    }

    export function sleep(ms: number): Promise<void>;
}
