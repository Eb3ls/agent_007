export type AgentSnapshot = {
	pos: { x: number; y: number };
	carry: { count: number; reward: number; ids: string[] };
	intentionSummary: {
		kind: "goto" | "explore" | "pickup" | "deliver" | "push" | "idle";
		targetId?: string;
		targetXY?: { x: number; y: number };
		spawnerIds?: number[];
		missionId?: string;
	};
};

export type TeamExclusions = {
	excludedParcelIds: ReadonlySet<string>;
	exploreExcludedSpawnIds: ReadonlySet<number>;
	excludedGotoTargets: ReadonlySet<string>; // serialized "x,y"
};

export class Coordinator {
	private readonly snapshots = new Map<string, AgentSnapshot>();
	private readonly deliveredScores = new Map<string, number>();
	private readonly startTime = Date.now();
	private _seedL = 0;

	publish(agentId: string, snap: AgentSnapshot): void {
		this.snapshots.set(agentId, snap);
	}

	posOf(agentId: string): { x: number; y: number } | null {
		return this.snapshots.get(agentId)?.pos ?? null;
	}

	carryOf(
		agentId: string,
	): { count: number; reward: number; ids: string[] } | null {
		return this.snapshots.get(agentId)?.carry ?? null;
	}

	setSeedL(rate: number): void {
		this._seedL = rate;
	}

	recordDelivery(agentId: string, points: number): void {
		this.deliveredScores.set(
			agentId,
			(this.deliveredScores.get(agentId) ?? 0) + points,
		);
	}

	// L: points/ms per-player. Seed branch (per-player proxy) and computed branch share scope.
	getL(): number {
		let total = 0;
		for (const pts of this.deliveredScores.values()) total += pts;
		if (total === 0) return this._seedL;
		const elapsed = Math.max(1, Date.now() - this.startTime);
		const agentCount = Math.max(1, this.snapshots.size);
		return total / elapsed / agentCount;
	}

	exclusionsFor(agentId: string): TeamExclusions {
		const excludedParcelIds = new Set<string>();
		const exploreExcludedSpawnIds = new Set<number>();
		const excludedGotoTargets = new Set<string>();

		for (const [id, snap] of this.snapshots) {
			if (id === agentId) continue;
			const s = snap.intentionSummary;
			if (s.spawnerIds) {
				for (const sid of s.spawnerIds)
					exploreExcludedSpawnIds.add(sid);
			}
			if (s.kind === "pickup" && s.targetId) {
				excludedParcelIds.add(s.targetId);
			}
			if (s.kind === "goto" && s.targetXY) {
				excludedGotoTargets.add(`${s.targetXY.x},${s.targetXY.y}`);
			}
		}

		return {
			excludedParcelIds,
			exploreExcludedSpawnIds,
			excludedGotoTargets,
		};
	}
}
