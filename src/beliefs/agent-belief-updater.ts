// ============================================================
// src/beliefs/agent-belief-updater.ts — Agent belief updates
// Handles updates to agent beliefs with heading estimation and confidence decay
// ============================================================

import type { AgentBelief, Direction, Position, RawAgentSensing } from '../types.js';

/** Agent confidence decays to 0 over this duration after last seen. */
const AGENT_CONFIDENCE_DECAY_MS = 10_000;

export type AgentBeliefUpdateResult = {
  agents: Map<string, AgentBelief>;
  prevPositions: Map<string, Position>;
  changed: boolean;
};

export class AgentBeliefUpdater {
  /**
   * Update agent beliefs from raw sensing data with heading estimation and confidence decay.
   * @param rawAgents Current sensed agents
   * @param currentAgents Previous agent beliefs
   * @param prevAgentPositions Previous raw positions (for heading estimation)
   * @param allyIds Set of ally agent IDs
   * @returns Update result with new agents map, updated previous positions, and changed flag
   */
  update(
    rawAgents: ReadonlyArray<RawAgentSensing>,
    currentAgents: Map<string, AgentBelief>,
    prevAgentPositions: Map<string, Position>,
    allyIds: Set<string>,
  ): AgentBeliefUpdateResult {
    const now = Date.now();
    const sensedIds = new Set<string>();
    const agents = new Map(currentAgents);
    const newPrevPositions = new Map(prevAgentPositions);

    // Update sensed agents
    for (const raw of rawAgents) {
      sensedIds.add(raw.id);
      const existing = agents.get(raw.id);

      // Estimate heading from raw float delta for accuracy (avoids false equality
      // when comparing integer belief position against a new fractional raw position).
      const prevRaw = prevAgentPositions.get(raw.id);
      let heading: Direction | null = null;
      if (prevRaw && (prevRaw.x !== raw.x || prevRaw.y !== raw.y)) {
        const dx = raw.x - prevRaw.x;
        const dy = raw.y - prevRaw.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          heading = dx > 0 ? 'right' : 'left';
        } else {
          heading = dy > 0 ? 'up' : 'down';
        }
      } else if (existing) {
        heading = existing.heading;
      }

      // Store raw float position for heading computation on the next update.
      newPrevPositions.set(raw.id, { x: raw.x, y: raw.y });

      // Use stable integer position — skip fractional mid-move coordinates to avoid
      // placing the agent on a tile they're actually leaving (Math.round can snap
      // to the destination tile while the agent is still on the source tile).
      const stablePosition = (Number.isInteger(raw.x) && Number.isInteger(raw.y))
        ? { x: raw.x, y: raw.y }
        : existing?.position ?? { x: Math.round(raw.x), y: Math.round(raw.y) };

      agents.set(raw.id, {
        id: raw.id,
        name: raw.name,
        position: stablePosition,
        score: raw.score,
        lastSeen: now,
        confidence: 1.0,
        heading,
        isAlly: allyIds.has(raw.id),
      });
    }

    // Decay confidence of agents no longer sensed
    for (const [id, belief] of Array.from(agents.entries())) {
      if (sensedIds.has(id)) continue;
      const age = now - belief.lastSeen;
      if (age > AGENT_CONFIDENCE_DECAY_MS) {
        agents.delete(id);
        newPrevPositions.delete(id);
      } else {
        const confidence = Math.max(0, 1 - age / AGENT_CONFIDENCE_DECAY_MS);
        agents.set(id, { ...belief, confidence });
      }
    }

    return {
      agents,
      prevPositions: newPrevPositions,
      changed: true, // Always emit for consistency
    };
  }
}
