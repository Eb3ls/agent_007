export type XY = { x: number; y: number };

export type PredicateToken =
	| "odd-row"
	| "even-row"
	| "odd-col"
	| "even-col"
	| "odd-tile"
	| "even-tile"
	| "delivery"
	| "spawn"
	| "leftmost"
	| "rightmost"
	| "topmost"
	| "bottommost"
	| "center";

export type Predicate = PredicateToken[];

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
	stage: {
		target: XY[] | Predicate;
		thenAct?: "pickUp" | "putDown";
		missionId?: string;
	} | null;
	modifiers: readonly ActiveModifier[];
	/** Unpriced on:"cross" tiles (no effect.add) — treated as hard BFS walls. */
	hardForbiddenTileCoords: readonly XY[];
	/** Priced on:"cross" tiles — penalty is subtracted from paths that cross them. */
	pricedCrossTiles: readonly { x: number; y: number; penalty: number }[];
	/** Parcel IDs explicitly forbidden for pickup (from on:"pickup" with parcelId). */
	forbiddenPickupParcelIds: ReadonlySet<string>;
};

const ORPHAN = "__orphan__";

export class DirectiveHandler {
	private readonly queue: Directive[] = [];
	private pool: ActiveModifier[] = [];
	private _pausedBy = new Set<string>();
	private _stages: NonNullable<ActiveDirectives["stage"]>[] = [];

	enqueue(d: Directive): void {
		this.queue.push(d);
	}

	apply(): void {
		for (const d of this.queue.splice(0)) {
			if (d.kind === "OVERRIDE") {
				if (d.op === "PAUSE") {
					this._pausedBy.add(d.missionId ?? ORPHAN);
				} else if (d.op === "RESUME") {
					if (d.missionId) this._pausedBy.delete(d.missionId);
					else this._pausedBy.clear();
				} else {
					this._stages.push({
						target: d.target,
						...(d.thenAct !== undefined && { thenAct: d.thenAct }),
						...(d.missionId !== undefined && {
							missionId: d.missionId,
						}),
					});
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
		this._stages = this._stages.filter((s) => s.missionId !== missionId);
		this._pausedBy.delete(missionId);
	}

	clearStage(): void {
		this._stages.shift();
	}

	get state(): ActiveDirectives {
		const hardForbiddenTileCoords: XY[] = [];
		const pricedCrossTiles: { x: number; y: number; penalty: number }[] =
			[];
		const forbiddenPickupParcelIds = new Set<string>();
		for (const m of this.pool) {
			if (m.selector.on === "cross") {
				const penalty = m.effect.add !== undefined ? -m.effect.add : 0;
				for (const xy of m.selector.tiles) {
					if (penalty > 0) pricedCrossTiles.push({ ...xy, penalty });
					else hardForbiddenTileCoords.push(xy);
				}
			}
			if (m.selector.on === "pickup" && m.selector.parcelId) {
				forbiddenPickupParcelIds.add(m.selector.parcelId);
			}
		}
		return {
			paused: this._pausedBy.size > 0,
			stage: this._stages[0] ?? null,
			modifiers: this.pool,
			hardForbiddenTileCoords,
			pricedCrossTiles,
			forbiddenPickupParcelIds,
		};
	}
}

// Maps the mission target string to a release scope: "both" targets all agents (global),
// any other value is per-agent.
export function scopeOf(target: string): "global" | "per-agent" {
	return target === "both" ? "global" : "per-agent";
}
