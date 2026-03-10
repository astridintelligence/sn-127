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
