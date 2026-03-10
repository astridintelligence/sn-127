/**
 * Ranking algorithm for arena miners.
 *
 * From the set of eligible miners, selects the top 3 by totalPnlPercent
 * (highest PnL wins). Only these miners receive emission weight allocations.
 *
 * Emission splits by eligible miner count:
 *   1 miner  → 100%
 *   2 miners → 70% / 30%
 *   3 miners → 60% / 30% / 10%
 */

import type { ArenaParticipant } from './api';
import type { EligibilityResult } from './eligibility';

export const TOP_N = 3;

/** Emission share fractions keyed by total miner count. */
const SPLITS_BY_COUNT: Record<number, readonly number[]> = {
    1: [1.0],
    2: [0.7, 0.3],
    3: [0.6, 0.3, 0.1]
};

export interface RankedMiner {
    participant: ArenaParticipant;
    position: number; // 1 = highest PnL
    emissionShare: number; // fraction of the total arena allocation (e.g. 0.6)
}

/**
 * Rank eligible miners by totalPnlPercent descending, take up to TOP_N,
 * and assign emission shares based on the actual count that qualified.
 */
export function rankEligibleMiners(results: EligibilityResult[]): RankedMiner[] {
    const eligible = results
        .filter((r) => r.eligible)
        .map((r) => r.participant)
        .sort((a, b) => b.totalPnlPercent - a.totalPnlPercent)
        .slice(0, TOP_N);

    if (eligible.length === 0) {
        return [];
    }

    const splits = SPLITS_BY_COUNT[eligible.length];

    return eligible.map((participant, i) => ({
        participant,
        position: i + 1,
        emissionShare: splits[i]
    }));
}
