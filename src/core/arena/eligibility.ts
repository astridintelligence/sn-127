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
 *   2. Every trade in the most recent RECENT_TRADE_WINDOW_MS slot that contains trades must have at least one
 *      execution run submitted within ±EXECUTION_WINDOW_MS of the trade's executedAt timestamp.
 *      If the latest window is empty, we slide back through consecutive windows until we find one with trades.
 *      This means past failures are forgiven once the agent is behaving correctly, but a participant who has
 *      gone silent (no recent trades) is still checked against their last active window.
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

        const oldestTradeTime = Math.min(...trades.map((t) => new Date(t.executedAt).getTime()));

        // Slide backwards through consecutive windows until we find one that contains trades.
        let windowEnd = now;
        let windowStart = now - RECENT_TRADE_WINDOW_MS;
        let windowTrades: TradeEntry[] = [];

        while (windowEnd > oldestTradeTime) {
            windowTrades = trades.filter((t) => {
                const time = new Date(t.executedAt).getTime();
                return time >= windowStart && time < windowEnd;
            });

            if (windowTrades.length > 0) {
                break;
            }

            windowEnd = windowStart;
            windowStart = windowEnd - RECENT_TRADE_WINDOW_MS;
        }

        if (windowTrades.length === 0) {
            return { participant: p, eligible: false, reason: 'no trades in recent windows' };
        }

        for (const trade of windowTrades) {
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
