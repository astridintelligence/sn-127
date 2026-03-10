import type { ExecutionEntry, TradeEntry } from './api';

export interface CompetitionCache {
    competitionId: string;
    trades: TradeEntry[];
    executions: ExecutionEntry[];
    tradesLastFetchedAt: string | null;
    executionsLastFetchedAt: string | null;
}

let activeCache: CompetitionCache | null = null;

export function getCache(competitionId: string): CompetitionCache {
    if (activeCache?.competitionId !== competitionId) {
        activeCache = {
            competitionId,
            trades: [],
            executions: [],
            tradesLastFetchedAt: null,
            executionsLastFetchedAt: null
        };
    }

    return activeCache;
}

export function appendTrades(cache: CompetitionCache, newTrades: TradeEntry[]): void {
    if (!cache) {
        throw new Error('Cache not initialized. Call getCache(competitionId) first.');
    }

    if (newTrades.length === 0) {
        return;
    }

    cache.trades.push(...newTrades);

    const latest = newTrades.reduce((max, t) => (t.executedAt > max ? t.executedAt : max), newTrades[0].executedAt);
    if (!cache.tradesLastFetchedAt || latest > cache.tradesLastFetchedAt) {
        cache.tradesLastFetchedAt = latest;
    }
}

export function appendExecutions(cache: CompetitionCache, newExecutions: ExecutionEntry[]): void {
    if (!cache) {
        throw new Error('Cache not initialized. Call getCache(competitionId) first.');
    }

    if (newExecutions.length === 0) {
        return;
    }

    cache.executions.push(...newExecutions);

    const latest = newExecutions.reduce((max, e) => (e.executionTime > max ? e.executionTime : max), newExecutions[0].executionTime);
    if (!cache.executionsLastFetchedAt || latest > cache.executionsLastFetchedAt) {
        cache.executionsLastFetchedAt = latest;
    }
}
