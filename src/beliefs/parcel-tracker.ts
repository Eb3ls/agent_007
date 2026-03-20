// ============================================================
// src/beliefs/parcel-tracker.ts — ParcelTracker (T08)
// Estimates per-parcel decay rates from consecutive sensing
// updates and provides future-reward estimation.
// ============================================================

import type { Position } from '../types.js';

interface ParcelRecord {
  lastReward: number;
  lastTimestamp: number;
  decayRatePerMs: number;
}

interface SpawnRecord {
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export class ParcelTracker {
  private records = new Map<string, ParcelRecord>();
  private spawns = new Map<string, SpawnRecord>();

  /**
   * Feed a sensing observation for a parcel.
   * Call this each time the parcel appears in a sensing update.
   */
  observe(parcelId: string, reward: number, timestamp: number): void {
    const existing = this.records.get(parcelId);

    if (!existing) {
      this.records.set(parcelId, {
        lastReward: reward,
        lastTimestamp: timestamp,
        decayRatePerMs: 0,
      });
      return;
    }

    let decayRate = existing.decayRatePerMs;

    if (reward < existing.lastReward && existing.lastReward > 0) {
      const dt = timestamp - existing.lastTimestamp;
      if (dt > 0) {
        decayRate = (existing.lastReward - reward) / dt;
      }
    }

    this.records.set(parcelId, {
      lastReward: reward,
      lastTimestamp: timestamp,
      decayRatePerMs: decayRate,
    });
  }

  /** Per-parcel decay rate in reward-units/ms. Returns 0 if unknown. */
  getDecayRate(parcelId: string): number {
    return this.records.get(parcelId)?.decayRatePerMs ?? 0;
  }

  /** Average decay rate across all parcels with an observed rate. */
  getGlobalAverageDecayRate(): number {
    const rates: number[] = [];
    for (const record of this.records.values()) {
      if (record.decayRatePerMs > 0) {
        rates.push(record.decayRatePerMs);
      }
    }
    if (rates.length === 0) return 0;
    return rates.reduce((sum, r) => sum + r, 0) / rates.length;
  }

  /**
   * Estimate the reward of a parcel at futureTimestamp.
   * Falls back to global average decay rate when per-parcel rate is unknown.
   */
  estimateRewardAt(parcelId: string, futureTimestamp: number): number {
    const record = this.records.get(parcelId);
    if (!record) return 0;

    const dt = futureTimestamp - record.lastTimestamp;
    if (dt <= 0) return record.lastReward;

    const rate =
      record.decayRatePerMs > 0
        ? record.decayRatePerMs
        : this.getGlobalAverageDecayRate();

    return Math.max(0, record.lastReward - rate * dt);
  }

  /** Record a new parcel appearing at a tile (spawn event). */
  recordSpawn(position: Position, timestamp: number): void {
    const key = `${position.x},${position.y}`;
    const existing = this.spawns.get(key);

    if (!existing) {
      this.spawns.set(key, { count: 1, firstTimestamp: timestamp, lastTimestamp: timestamp });
    } else {
      this.spawns.set(key, {
        count: existing.count + 1,
        firstTimestamp: existing.firstTimestamp,
        lastTimestamp: timestamp,
      });
    }
  }

  /**
   * Estimated spawn frequency at a tile in spawns/ms.
   * Returns 0 if fewer than 2 spawns have been observed.
   */
  getSpawnFrequency(position: Position): number {
    const key = `${position.x},${position.y}`;
    const record = this.spawns.get(key);
    if (!record || record.count < 2) return 0;

    const dt = record.lastTimestamp - record.firstTimestamp;
    if (dt <= 0) return 0;
    return record.count / dt;
  }

  /** Remove all state for a parcel (e.g. after delivery or expiry). */
  forget(parcelId: string): void {
    this.records.delete(parcelId);
  }
}
