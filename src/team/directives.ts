export type XY = { x: number; y: number };

export type Predicate =
	| { rowParity: "odd" | "even" }
	| { row: number }
	| { col: number }
	| { nearXY: XY; radius: number };

export type TargetSelector =
	| { on: "goto"; coords: XY[] }
	| { on: "deliver"; tile?: XY }
	| { on: "deliver-parcel"; rewardOver?: number }
	| { on: "cross"; tiles: XY[] }
	| { on: "pickup"; parcelId?: string };

export type Condition =
	| { carryCountEquals: number }
	| { carryCountAtLeast: number }
	| { carryCountOver: number }
	| { carryRewardAtMost: number };

export type Directive =
	| { kind: "OVERRIDE"; op: "PAUSE"; missionId?: string }
	| { kind: "OVERRIDE"; op: "RESUME"; missionId?: string }
	| {
			kind: "OVERRIDE";
			op: "STAGE";
			target: XY[] | Predicate;
			thenAct?: "pickUp" | "putDown";
			missionId?: string;
	  }
	| {
			kind: "MODIFIER";
			selector: TargetSelector;
			effect: { add?: number; mult?: number };
			condition?: Condition;
			lifetime: "one-shot" | "persistent";
			missionId: string;
			target: string | "both";
	  };

export type ActiveModifier = {
	selector: TargetSelector;
	effect: { add?: number; mult?: number };
	condition?: Condition;
	lifetime: "one-shot" | "persistent";
	missionId: string;
	target: string | "both";
};

export type ActiveDirectives = {
	paused: boolean;
	/** missionId that caused the pause; null = PAUSE arrived without missionId (orphan). */
	pauseMissionId: string | null;
	stage: {
		target: XY[] | Predicate;
		thenAct?: "pickUp" | "putDown";
		missionId?: string;
	} | null;
	modifiers: readonly ActiveModifier[];
	/** All XY tiles from on:"cross" modifiers — agent_core adds these to BFS blocked set. */
	hardForbiddenTileCoords: readonly XY[];
	/** Parcel IDs explicitly forbidden for pickup (from on:"pickup" with parcelId). */
	forbiddenPickupParcelIds: ReadonlySet<string>;
};

export class DirectiveHandler {
	private readonly queue: Directive[] = [];
	private pool: ActiveModifier[] = [];
	private _paused = false;
	private _pauseMissionId: string | null = null;
	private _stage: ActiveDirectives["stage"] = null;

	enqueue(d: Directive): void {
		this.queue.push(d);
	}

	apply(): void {
		for (const d of this.queue.splice(0)) {
			if (d.kind === "OVERRIDE") {
				if (d.op === "PAUSE") {
					this._paused = true;
					this._pauseMissionId = d.missionId ?? null;
				} else if (d.op === "RESUME") {
					this._paused = false;
					this._pauseMissionId = null;
				} else {
					this._stage = {
						target: d.target,
						...(d.thenAct !== undefined && { thenAct: d.thenAct }),
						...(d.missionId !== undefined && {
							missionId: d.missionId,
						}),
					};
				}
			} else {
				this.pool.push({
					selector: d.selector,
					effect: d.effect,
					...(d.condition !== undefined && {
						condition: d.condition,
					}),
					lifetime: d.lifetime,
					missionId: d.missionId,
					target: d.target,
				});
			}
		}
	}

	releaseByMissionId(missionId: string): void {
		this.pool = this.pool.filter((m) => m.missionId !== missionId);
		if (this._pauseMissionId === missionId) {
			this._paused = false;
			this._pauseMissionId = null;
		}
	}

	clearStage(): void {
		this._stage = null;
	}

	get state(): ActiveDirectives {
		const hardForbiddenTileCoords: XY[] = [];
		const forbiddenPickupParcelIds = new Set<string>();
		for (const m of this.pool) {
			if (m.selector.on === "cross") {
				for (const xy of m.selector.tiles)
					hardForbiddenTileCoords.push(xy);
			}
			if (m.selector.on === "pickup" && m.selector.parcelId) {
				forbiddenPickupParcelIds.add(m.selector.parcelId);
			}
		}
		return {
			paused: this._paused,
			pauseMissionId: this._pauseMissionId,
			stage: this._stage,
			modifiers: this.pool,
			hardForbiddenTileCoords,
			forbiddenPickupParcelIds,
		};
	}
}
