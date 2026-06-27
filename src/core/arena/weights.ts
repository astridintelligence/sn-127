/**
 * Weight construction for arena delayed emissions.
 *
 * The weight set is built entirely from competition results:
 *
 *   UID 0 (burn)  = 100 − (EMISSIONS_PERCENT × number_of_competitions)
 *   Per-competition top-3 miners receive EMISSIONS_PERCENT × emissionShare
 *
 * Floor + remainder strategy ensures integer weights that sum exactly to 100:
 * each miner weight is floored, and the leftover integer is given to the
 * highest-weighted miner in that competition.
 *
 * Example — 1 competition (25%), 3 qualifying miners:
 *   UID 0 (burn):     75
 *   UID A (rank 1):   floor(25×0.60) + 1 remainder = 16
 *   UID B (rank 2):   floor(25×0.30)              = 7
 *   UID C (rank 3):   floor(25×0.10)              = 2
 *   Total:            100
 */

import type { BittensorWeightTarget } from '../../config/env';
import { EMISSIONS_PERCENT } from './constants';

export interface ResolvedCompetition {
    competitionId: string;
    rankedMiners: Array<{ uid: number; emissionShare: number }>;
}

/**
 * Build final weight targets from all resolved payout competitions.
 *
 * @param competitions  Competitions with ranked miners (UIDs + emission shares).
 * @returns Array of {uid, weight} targets ready to submit to Bittensor.
 */
export function buildArenaWeights(competitions: ResolvedCompetition[]): BittensorWeightTarget[] {
    if (competitions.length === 0) {
        return [{ uid: 0, weight: 100 }];
    }

    const totalArena = EMISSIONS_PERCENT * competitions.length;
    const burnWeight = Math.max(0, 100 - totalArena);

    // Accumulate weights per UID (a miner could appear in multiple competitions)
    const weightByUid = new Map<number, number>();

    for (const comp of competitions) {
        // Compute floor weights for this competition's miners
        const floorWeights = comp.rankedMiners.map((m) => Math.floor(EMISSIONS_PERCENT * m.emissionShare));
        const allocated = floorWeights.reduce((s, w) => s + w, 0);
        const remainder = EMISSIONS_PERCENT - allocated;

        for (let i = 0; i < comp.rankedMiners.length; i++) {
            const { uid } = comp.rankedMiners[i];
            const weight = floorWeights[i] + (i === 0 ? remainder : 0);
            if (weight > 0) {
                weightByUid.set(uid, (weightByUid.get(uid) ?? 0) + weight);
            }
        }
    }

    const targets: BittensorWeightTarget[] = [{ uid: 0, weight: burnWeight }];

    for (const [uid, weight] of weightByUid.entries()) {
        targets.push({ uid, weight });
    }

    return targets;
}
