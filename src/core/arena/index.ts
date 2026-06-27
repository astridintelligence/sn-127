import type { ApiPromise } from '@polkadot/api';
import type { BittensorWeightTarget } from '../../config/env';
import { logDebug, logError, logInfo, logWarning } from '../../utils/logging';
import {
    fetchAllTrades,
    fetchCompletedCompetitions,
    fetchExecutionPresence,
    type CompletedCompetition,
    type PresenceEntry,
    type TradeEntry
} from './api';
import { appendExecutions, appendTrades, getCache } from './cache';
import { EMISSION_SPLITS, TOP_N } from './constants';
import { checkEligibility, type EligibilityParticipant } from './eligibility';
import { getNeuronByHotkey, getNeuronsByColdkey } from './metagraph';
import { computeAllParticipantPnl } from './pnl';
import { buildArenaWeights } from './weights';

/**
 * Arena miner weight computation — entry point.
 *
 * Called once per weight-setting cycle. Fetches completed competitions that
 * are in their delayed-emissions payout window, replays each participant's
 * trades to compute PnL independently, runs eligibility checks, ranks the
 * top-3, resolves their Bittensor UIDs, and returns weight targets.
 *
 * Returns [{uid:0, weight:100}] (all burn) when no competition is currently
 * in its payout window or when no eligible miners are found.
 *
 * Emission config is hardcoded in constants.ts and is NOT fetched from the platform API.
 */
export async function computeArenaWeights(api: ApiPromise, netuid: number, arenaApiUrl: string): Promise<BittensorWeightTarget[] | null> {
    const burnOnly: BittensorWeightTarget[] = [{ uid: 0, weight: 100 }];

    let competitions: CompletedCompetition[];
    try {
        competitions = await fetchCompletedCompetitions(arenaApiUrl);
    } catch (err) {
        logError('Failed to fetch completed competitions', { err });
        return null;
    }

    const now = new Date();

    competitions = competitions.filter((c) => {
        const inWindow = now >= new Date(c.emissionsStartDate) && now < new Date(c.emissionsEndDate);
        if (!inWindow) {
            logWarning('Competition outside emissions window, skipping', {
                competitionId: c.competitionId,
                emissionsStartDate: c.emissionsStartDate,
                emissionsEndDate: c.emissionsEndDate
            });
        }

        return inWindow;
    });

    if (competitions.length === 0) {
        logInfo('No completed competitions in payout window, returning burn-only weights');
        return burnOnly;
    }

    logInfo('Competitions in payout window', { count: competitions.length });

    // Resolve each competition's eligible, ranked miners
    const resolvedCompetitions: Array<{
        competitionId: string;
        rankedMiners: Array<{ uid: number; emissionShare: number }>;
    }> = [];

    for (const comp of competitions) {
        const ranked = await resolveCompetitionMiners(api, netuid, arenaApiUrl, comp);
        if (ranked.length > 0) {
            resolvedCompetitions.push({ competitionId: comp.competitionId, rankedMiners: ranked });
        }
    }

    if (resolvedCompetitions.length === 0) {
        logInfo('No eligible miners found across all payout competitions');
        return burnOnly;
    }

    return buildArenaWeights(resolvedCompetitions);
}

/**
 * For a single completed competition: fetch trades + executions, run eligibility
 * checks, replay PnL, rank top-N, and resolve Bittensor UIDs.
 */
async function resolveCompetitionMiners(
    api: ApiPromise,
    netuid: number,
    arenaApiUrl: string,
    comp: CompletedCompetition
): Promise<Array<{ uid: number; emissionShare: number }>> {
    const cache = getCache(comp.competitionId);

    // Only consider non-disqualified participants
    const eligible = comp.participants.filter((p) => !p.isDisqualified);

    const eligibleIds = eligible.map((p) => p.participantId);

    let newTrades: TradeEntry[] = [];
    let newExecutions: PresenceEntry[] = [];

    try {
        [newTrades, newExecutions] = await Promise.all([
            fetchAllTrades(arenaApiUrl, comp.competitionId, cache.tradesLastFetchedAt),
            fetchExecutionPresence(arenaApiUrl, comp.competitionId, eligibleIds, cache.executionsLastFetchedAt)
        ]);
    } catch (err) {
        logError('Failed to fetch trades/executions, using cached data', { err, competitionId: comp.competitionId });
    }

    appendTrades(cache, newTrades);
    appendExecutions(cache, newExecutions);

    logDebug('Trade/execution cache updated', {
        competitionId: comp.competitionId,
        cachedTrades: cache.trades.length,
        cachedExecutions: cache.executions.length,
        newTrades: newTrades.length,
        newExecutions: newExecutions.length
    });

    if (eligible.length === 0) {
        logInfo('All participants are disqualified', { competitionId: comp.competitionId });
        return [];
    }

    // Wrap eligible participants in the shape expected by checkEligibility
    const asArenaParticipants: EligibilityParticipant[] = eligible.map((p) => ({
        participantId: p.participantId,
        coldkey: p.coldkey,
        hotkey: p.hotkey,
        uid: p.uid
    }));

    const eligibilityResults = checkEligibility(asArenaParticipants, cache.trades, cache.executions);
    const passedEligibility = eligibilityResults.filter((r) => r.eligible);

    const ineligible = eligibilityResults.filter((r) => !r.eligible);
    if (ineligible.length > 0) {
        logDebug('Ineligible miners', { ineligible: ineligible.map((r) => ({ coldkey: r.participant.coldkey, reason: r.reason })) });
    }

    if (passedEligibility.length === 0) {
        logInfo('No miners passed eligibility check', { competitionId: comp.competitionId });
        return [];
    }

    // Replay trades to compute PnL independently
    const pnlByParticipant = computeAllParticipantPnl(cache.trades, comp.initialBalance);

    // Rank eligible miners by replayed PnL (highest wins), take up to TOP_N
    const ranked = passedEligibility
        .map((r) => {
            const pnl = pnlByParticipant.get(r.participant.participantId);
            return { participant: r.participant, pnlPercent: pnl?.totalPnlPercent ?? 0 };
        })
        .sort((a, b) => b.pnlPercent - a.pnlPercent)
        .slice(0, TOP_N);

    logInfo('Ranked miners', {
        competitionId: comp.competitionId,
        ranked: ranked.map((r) => ({ coldkey: r.participant.coldkey, pnl: r.pnlPercent }))
    });

    // Assign emission splits based on how many miners qualified
    const splits = getSplitsForCount(ranked.length);

    // Resolve Bittensor UIDs from the live metagraph
    const resolvedMiners: Array<{ uid: number; emissionShare: number }> = [];

    for (let i = 0; i < ranked.length; i++) {
        const { participant } = ranked[i];
        const emissionShare = splits[i];

        const resolvedUid = await resolveUid(api, netuid, participant);
        if (resolvedUid == null) {
            continue;
        }

        resolvedMiners.push({ uid: resolvedUid, emissionShare });
    }

    return resolvedMiners;
}

/** Trim EMISSION_SPLITS to the actual miner count and renormalize so they sum to 1. */
function getSplitsForCount(count: number): number[] {
    if (count === 0) {
        return [];
    }

    const raw = EMISSION_SPLITS.slice(0, count);
    const total = raw.reduce((s, v) => s + v, 0);

    return raw.map((v) => v / total);
}

async function resolveUid(api: ApiPromise, netuid: number, participant: EligibilityParticipant): Promise<number | null> {
    const { coldkey, hotkey, uid: preferredUid } = participant;

    if (hotkey && preferredUid != null) {
        const neuron = await getNeuronByHotkey(api, netuid, hotkey);
        if (neuron && neuron.uid === preferredUid && neuron.coldkey === coldkey) {
            return neuron.uid;
        }

        logWarning('Preferred hotkey/uid does not match metagraph, falling back to coldkey lookup', {
            coldkey,
            hotkey,
            preferredUid,
            found: neuron ?? null
        });
    }

    const neurons = await getNeuronsByColdkey(api, netuid, coldkey);
    if (neurons.length === 0) {
        logWarning('Miner not found in metagraph, skipping', { coldkey });
        return null;
    }

    return neurons[0].uid;
}
