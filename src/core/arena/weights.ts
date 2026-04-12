/**
 * Weight blending: merges vault targets with arena miner targets.
 *
 * The arena emissions percentage is taken out of the UID=0 (burn) allocation.
 * Vault miners (all UIDs != 0) are unaffected.
 *
 * Rounding strategy: floor each arena weight, then add the integer remainder
 * to the top-ranked miner. This guarantees the total arena allocation sums
 * exactly to arenaPercent with no weight leaking or over-allocating.
 *
 * Example with arenaPercent=25 and vault targets [{uid:0, weight:75}, {uid:164, weight:25}]:
 *
 *   UID 0   (burn):      75 - 25                   = 50
 *   UID 164 (vault):     25                        = 25  (unchanged)
 *   UID top1 (arena):    floor(25×0.60) + rem(1)   = 16  (15 + 1 remainder)
 *   UID top2 (arena):    floor(25×0.30)            = 7
 *   UID top3 (arena):    floor(25×0.10)            = 2
 */

import type { BittensorWeightTarget } from '../../config/env';
import type { RankedMiner } from './ranking';

/**
 * Blend vault targets with delayed-emission payout winners.
 *
 * Each winner's raw weight = emissionsPercent × (splitPercent / 100), pre-summed
 * per UID by the caller. The total arena allocation (sum of all emissionsPercent
 * values) is subtracted from UID=0 (burn), identical to blendWeights().
 *
 * Floor + remainder strategy: floors each winner weight, gives the integer
 * remainder to the highest-weighted winner.
 *
 * Example: two competitions each at 25%, splits 60/30/10:
 *   UID A (comp1 rank1): floor(25×0.60) = 15  → +1 remainder = 16
 *   UID B (comp1 rank2): floor(25×0.30) = 7
 *   UID C (comp1 rank3): floor(25×0.10) = 2
 *   UID D (comp2 rank1): floor(25×0.60) = 15
 *   ...total = 50 subtracted from UID=0
 */
export function blendPayoutWeights(
    vaultTargets: readonly BittensorWeightTarget[],
    totalPercent: number,
    allocationByUid: Map<number, number>
): BittensorWeightTarget[] {
    if (allocationByUid.size === 0 || totalPercent <= 0) {
        return [...vaultTargets];
    }

    const burnTarget = vaultTargets.find((t) => t.uid === 0);
    if (!burnTarget) {
        return [...vaultTargets];
    }

    const reducedBurnWeight = Math.max(0, burnTarget.weight - totalPercent);

    const blended: BittensorWeightTarget[] = vaultTargets.map((t) =>
        t.uid === 0 ? { uid: 0, weight: reducedBurnWeight } : { uid: t.uid, weight: t.weight }
    );

    // Sort descending so remainder goes to the top winner
    const sorted = [...allocationByUid.entries()].sort((a, b) => b[1] - a[1]);

    const floorWeights = sorted.map(([, w]) => Math.floor(w));
    const remainder = Math.round(totalPercent - floorWeights.reduce((sum, w) => sum + w, 0));

    for (let i = 0; i < sorted.length; i++) {
        const [uid] = sorted[i];
        const weight = floorWeights[i] + (i === 0 ? remainder : 0);
        if (weight > 0) {
            blended.push({ uid, weight });
        }
    }

    return blended;
}

/**
 * Blend vault weight targets with arena miner allocations.
 *
 * @param vaultTargets   Weight targets returned by the Vault API.
 * @param arenaPercent   Integer 0-100; percentage taken from UID=0 for arena miners.
 * @param rankedMiners   Top-3 ranked miners with their UIDs resolved.
 */
export function blendWeights(
    vaultTargets: readonly BittensorWeightTarget[],
    arenaPercent: number,
    rankedMiners: Array<RankedMiner & { uid: number }>
): BittensorWeightTarget[] {
    if (rankedMiners.length === 0 || arenaPercent <= 0) {
        return [...vaultTargets];
    }

    const burnTarget = vaultTargets.find((t) => t.uid === 0);
    if (!burnTarget) {
        // No burn UID in vault targets — cannot safely subtract the arena allocation.
        return [...vaultTargets];
    }

    const reducedBurnWeight = Math.max(0, burnTarget.weight - arenaPercent);

    const blended: BittensorWeightTarget[] = vaultTargets.map((t) =>
        t.uid === 0 ? { uid: 0, weight: reducedBurnWeight } : { uid: t.uid, weight: t.weight }
    );

    // Floor each arena share, then give the integer remainder to position 1.
    const floorWeights = rankedMiners.map((m) => Math.floor(arenaPercent * m.emissionShare));
    const remainder = arenaPercent - floorWeights.reduce((sum, w) => sum + w, 0);

    for (let i = 0; i < rankedMiners.length; i++) {
        const weight = floorWeights[i] + (i === 0 ? remainder : 0);
        blended.push({ uid: rankedMiners[i].uid, weight });
    }

    return blended;
}
