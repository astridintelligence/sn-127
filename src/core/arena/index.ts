import type { ApiPromise } from '@polkadot/api';
import type { BittensorWeightTarget } from '../../config/env';
import logger from '../../config/logger';
import { fetchAllExecutions, fetchAllTrades, fetchArenaInfo, type ExecutionEntry, type TradeEntry } from './api';
import { appendExecutions, appendTrades, getCache } from './cache';
import { checkEligibility } from './eligibility';
import { getNeuronByHotkey, getNeuronsByColdkey } from './metagraph';
import { rankEligibleMiners } from './ranking';
import { blendWeights } from './weights';

/**
 * Arena miner weight computation — entry point.
 *
 * Called once per weight-setting cycle. Fetches arena state from the
 * Astrid Arena API, checks miner eligibility, ranks them, resolves their
 * Bittensor UIDs, and returns blended weight targets.
 *
 * Returns null when arena emissions are inactive (no live competition, no
 * eligible miners, or ARENA_API_URL not configured). The caller should fall
 * back to vault-only weights in that case.
 */
export async function computeArenaWeights(
    api: ApiPromise,
    netuid: number,
    arenaApiUrl: string,
    vaultTargets: readonly BittensorWeightTarget[]
): Promise<BittensorWeightTarget[] | null> {
    let arenaInfo;

    try {
        arenaInfo = await fetchArenaInfo(arenaApiUrl);
    } catch (err) {
        logger.error({ err }, 'arena: failed to fetch arena info — skipping arena weights');
        return null;
    }

    const { arenaEmissionsPercent, competition, participants } = arenaInfo;

    if (arenaEmissionsPercent === 0 || !competition || participants.length === 0) {
        logger.debug({ arenaEmissionsPercent, hasCompetition: !!competition }, 'arena: no active arena competition');
        return null;
    }

    logger.info({ competitionId: competition.id, participants: participants.length, arenaEmissionsPercent }, 'arena: active competition found');

    const cache = getCache(competition.id);

    let newTrades: TradeEntry[] = [];
    let newExecutions: ExecutionEntry[] = [];

    try {
        [newTrades, newExecutions] = await Promise.all([
            fetchAllTrades(arenaApiUrl, competition.id, cache.tradesLastFetchedAt),
            fetchAllExecutions(arenaApiUrl, competition.id, cache.executionsLastFetchedAt)
        ]);
    } catch (err) {
        logger.error({ err }, 'arena: failed to fetch trades/executions — using cached data');
    }

    appendTrades(cache, newTrades);
    appendExecutions(cache, newExecutions);

    logger.debug(
        {
            competitionId: competition.id,
            cachedTrades: cache.trades.length,
            cachedExecutions: cache.executions.length,
            newTrades: newTrades.length,
            newExecutions: newExecutions.length
        },
        'arena: cache updated'
    );

    const eligibilityResults = checkEligibility(participants, cache.trades, cache.executions);

    const ineligible = eligibilityResults.filter((r) => !r.eligible);
    if (ineligible.length > 0) {
        logger.debug({ ineligible: ineligible.map((r) => ({ coldkey: r.participant.coldkey, reason: r.reason })) }, 'arena: ineligible miners');
    }

    const ranked = rankEligibleMiners(eligibilityResults);

    if (ranked.length === 0) {
        logger.info('arena: no eligible miners qualify for emissions');
        return null;
    }

    logger.info(
        { ranked: ranked.map((r) => ({ coldkey: r.participant.coldkey, position: r.position, pnl: r.participant.totalPnlPercent })) },
        'arena: ranked miners'
    );

    const resolvedMiners: Array<(typeof ranked)[number] & { uid: number }> = [];

    for (const miner of ranked) {
        const { coldkey, hotkey: preferredHotkey, uid: preferredUid } = miner.participant;

        let resolvedUid: number | null = null;

        // Validate the platform's preferred hotkey/uid against the fresh metagraph
        if (preferredHotkey && preferredUid != null) {
            const neuron = await getNeuronByHotkey(api, netuid, preferredHotkey);
            if (neuron && neuron.uid === preferredUid && neuron.coldkey === coldkey) {
                resolvedUid = neuron.uid;
            } else {
                logger.warn(
                    {
                        coldkey,
                        preferredHotkey,
                        preferredUid,
                        found: neuron ?? null
                    },
                    'arena: preferred hotkey/uid from platform does not match metagraph — falling back to fresh metagraph entry'
                );
            }
        }

        // Fall back to any registration for this coldkey
        if (resolvedUid == null) {
            const neurons = await getNeuronsByColdkey(api, netuid, coldkey);
            if (neurons.length === 0) {
                logger.warn({ coldkey }, 'arena: miner not found in metagraph — skipping');
                continue;
            }

            resolvedUid = neurons[0].uid;
        }

        resolvedMiners.push({ ...miner, uid: resolvedUid });
    }

    if (resolvedMiners.length === 0) {
        logger.warn('arena: no ranked miners could be resolved to UIDs');
        return null;
    }

    return blendWeights(vaultTargets, arenaEmissionsPercent, resolvedMiners);
}
