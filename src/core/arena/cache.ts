import type { OhlcvCandle, PresenceEntry, TradeEntry } from './api';

export interface CompetitionCache {
    competitionId: string;
    trades: TradeEntry[];
    executions: PresenceEntry[];
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

export function appendExecutions(cache: CompetitionCache, newExecutions: PresenceEntry[]): void {
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

// Candles for a completed competition never change once fetched (the range ends at the competition's end),
// so they are kept per competition and ticker across cycles, independent of the single active trade cache.
const candleCache = new Map<string, OhlcvCandle[]>();

export function getCachedCandles(competitionId: string, tickerId: string): OhlcvCandle[] | undefined {
    return candleCache.get(`${competitionId}:${tickerId}`);
}

export function setCachedCandles(competitionId: string, tickerId: string, candles: OhlcvCandle[]): void {
    candleCache.set(`${competitionId}:${tickerId}`, candles);
}
