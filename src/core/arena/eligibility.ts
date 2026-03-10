import type { ArenaParticipant, ExecutionEntry, TradeEntry } from './api';

/** Time window (each side) in which an execution must exist near a trade. */
const EXECUTION_WINDOW_MS = 2 * 60 * 60 * 1000; // ±2 hours

/** How far back to look when evaluating recent trade coverage. Older trades are ignored. */
const RECENT_TRADE_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface EligibilityResult {
    participant: ArenaParticipant;
    eligible: boolean;
    reason?: string;
}

/**
 * Check eligibility for all participants given the full set of cached trades and executions for the competition.
 *
 * Eligibility rules for arena miner emissions.
 *
 * A miner is eligible only if ALL of the following hold:
 *   1. They have made at least one trade.
 *   2. Every trade within the last RECENT_TRADE_WINDOW_MS has at least one execution run submitted within ±EXECUTION_WINDOW_MS of the trade's executedAt timestamp.
 *      Trades older than the recent window are ignored, allowing past failures to be forgiven once the agent is behaving correctly.
 *      If there are no recent trades, the coverage check is skipped entirely.
 */

export function checkEligibility(participants: ArenaParticipant[], allTrades: TradeEntry[], allExecutions: ExecutionEntry[]): EligibilityResult[] {
    const tradesByParticipant = groupBy(allTrades, (t) => t.participantId ?? '');
    const executionsByParticipant = groupBy(allExecutions, (e) => e.participantId ?? '');

    const now = Date.now();

    return participants.map((p) => {
        const trades = tradesByParticipant.get(p.participantId) ?? [];
        const executions = executionsByParticipant.get(p.participantId) ?? [];

        if (trades.length === 0) {
            return { participant: p, eligible: false, reason: 'no trades during competition' };
        }

        const recentTrades = trades.filter((t) => now - new Date(t.executedAt).getTime() <= RECENT_TRADE_WINDOW_MS);

        for (const trade of recentTrades) {
            const tradeTime = new Date(trade.executedAt).getTime();

            const hasNearbyExecution = executions.some((e) => {
                const execTime = new Date(e.executionTime).getTime();
                return Math.abs(execTime - tradeTime) <= EXECUTION_WINDOW_MS;
            });

            if (!hasNearbyExecution) {
                return {
                    participant: p,
                    eligible: false,
                    reason: `trade at ${trade.executedAt} has no execution run within ±2h`
                };
            }
        }

        return { participant: p, eligible: true };
    });
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();

    for (const item of items) {
        const k = key(item);

        if (!map.has(k)) {
            map.set(k, []);
        }

        map.get(k)!.push(item);
    }

    return map;
}
