import type { OhlcvCandle, TradeEntry } from './api';

/**
 * Independent replay of the Astrid Score (formula astrid-v2) for a completed competition.
 *
 * This is a port of the platform's scoring (api/src/services/astrid in the arena repo), restricted to the
 * v2 reward score. Equity is marked to market on a fixed 5-minute grid from the competition start to its
 * end, using the stored 5m candle closes, so the result only depends on public data:
 * trades (wallet-activity) and candles (ohlcv history).
 *
 * Keep the constants and maths in sync with the platform. Any change to the platform formula needs a
 * matching change here, otherwise validators will rank differently from the platform's published scores.
 */

export const SCORING_INTERVAL_MINUTES = 5;
const INTERVAL_MS = SCORING_INTERVAL_MINUTES * 60 * 1000;
const POSITION_QUANTITY_EPSILON = 1e-10;
const PNL_CURVE_K = 0.12;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const WEIGHTS = {
    pnlScore: 0.25,
    calmarScore: 0.22,
    sortinoScore: 0.18,
    ulcerScore: 0.15,
    maxDrawdownScore: 0.12,
    executionActivityScore: 0.08
} as const;

export interface AstridCompetitionParams {
    startTime: string;
    endTime: string;
    initialBalance: number;
}

export interface AstridResult {
    participantId: string;
    /** null when the score is withheld (no trades, or no valid equity samples). */
    score: number | null;
    competitionReturn: number;
    filledTradeCount: number;
}

interface EquityPoint {
    equity: number | null;
    hasOpenPosition: boolean;
    absNotionalExposure: number;
}

interface Position {
    tickerId: string;
    side: 'long' | 'short';
    quantity: number;
    entryPrice: number;
    marginUsed: number;
    leverage: number;
}

interface ReplayTrade {
    id: string;
    tickerId: string;
    side: string;
    positionSide: string;
    quantity: number;
    price: number;
    fees: number;
    leverage: number;
    executedAtMs: number;
}

type PriceIndex = Map<string, Array<{ time: number; close: number }>>;

/** Distinct ticker ids traded in the given trades, so the caller knows which candles to fetch. */
export function collectTickerIds(trades: TradeEntry[]): string[] {
    return [...new Set(trades.map((t) => t.tickerId).filter((id): id is string => !!id))];
}

export function buildPriceIndex(candlesByTicker: Map<string, OhlcvCandle[]>): PriceIndex {
    const index: PriceIndex = new Map();

    for (const [tickerId, candles] of candlesByTicker) {
        const prices = candles
            .map((c) => ({ time: new Date(c.timestamp).getTime(), close: Number(c.close) }))
            .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.close))
            .sort((a, b) => a.time - b.time);

        index.set(tickerId, prices);
    }

    return index;
}

/**
 * Compute the final Astrid Score for every participant that has trades.
 * Participants without trades get no entry; callers should treat them as unscored.
 */
export function computeAllAstridScores(allTrades: TradeEntry[], comp: AstridCompetitionParams, priceIndex: PriceIndex): Map<string, AstridResult> {
    const startMs = new Date(comp.startTime).getTime();
    const endMs = new Date(comp.endTime).getTime();
    const timestamps = generateTimestamps(startMs, endMs);
    const durationDays = Math.max(1, (endMs - startMs) / MS_PER_DAY);

    const byParticipant = new Map<string, ReplayTrade[]>();

    for (const trade of allTrades) {
        const executedAtMs = new Date(trade.executedAt).getTime();
        // Same window as the platform's final snapshot: trades executed in [start, end].
        if (!trade.participantId || !trade.tickerId || executedAtMs < startMs || executedAtMs > endMs) {
            continue;
        }

        const list = byParticipant.get(trade.participantId) ?? [];
        list.push({
            id: trade.id,
            tickerId: trade.tickerId,
            side: trade.side,
            positionSide: trade.positionSide,
            quantity: trade.quantity,
            price: trade.price,
            fees: trade.fees,
            // The platform replays with the order's leverage, falling back to 1.
            leverage: trade.orderLeverage ?? 1,
            executedAtMs
        });
        byParticipant.set(trade.participantId, list);
    }

    const results = new Map<string, AstridResult>();

    for (const [participantId, trades] of byParticipant) {
        results.set(participantId, scoreParticipant(participantId, trades, comp.initialBalance, timestamps, priceIndex, durationDays));
    }

    return results;
}

function generateTimestamps(startMs: number, endMs: number): number[] {
    if (endMs < startMs) {
        return [];
    }

    const timestamps: number[] = [];
    for (let t = startMs; t <= endMs; t += INTERVAL_MS) {
        timestamps.push(t);
    }

    if (timestamps.length > 0 && timestamps[timestamps.length - 1] < endMs) {
        timestamps.push(endMs);
    }

    return timestamps;
}

function lookupPrice(priceIndex: PriceIndex, tickerId: string, timeMs: number): number | null {
    const prices = priceIndex.get(tickerId);
    if (!prices || prices.length === 0 || prices[0].time > timeMs) {
        return null;
    }

    let low = 0;
    let high = prices.length - 1;

    if (prices[high].time <= timeMs) {
        return prices[high].close;
    }

    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (prices[mid].time <= timeMs) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    return prices[low].close;
}

function unrealizedPnl(position: Position, currentPrice: number): number {
    const diff = position.side === 'long' ? currentPrice - position.entryPrice : position.entryPrice - currentPrice;
    return diff * position.quantity * position.leverage;
}

function isOpening(trade: ReplayTrade): boolean {
    return (trade.positionSide === 'long' && trade.side === 'buy') || (trade.positionSide === 'short' && trade.side === 'sell');
}

function scoreParticipant(
    participantId: string,
    unsortedTrades: ReplayTrade[],
    startingEquity: number,
    timestamps: number[],
    priceIndex: PriceIndex,
    durationDays: number
): AstridResult {
    const trades = [...unsortedTrades].sort((a, b) => a.executedAtMs - b.executedAtMs || a.id.localeCompare(b.id));

    const positions = new Map<string, Position>();
    let cash = startingEquity;
    let tradeIndex = 0;
    const points: EquityPoint[] = [];

    for (const timestamp of timestamps) {
        while (tradeIndex < trades.length && trades[tradeIndex].executedAtMs <= timestamp) {
            const trade = trades[tradeIndex];
            tradeIndex++;

            const quantity = Math.max(trade.quantity, 0);
            const price = Math.max(trade.price, 0);
            const leverage = trade.leverage > 0 ? trade.leverage : 1;
            const fees = Math.max(trade.fees, 0);
            const key = `${trade.tickerId}:${trade.positionSide}`;

            if (isOpening(trade)) {
                const margin = (quantity * price) / leverage;
                const existing = positions.get(key);

                if (existing) {
                    const totalQuantity = existing.quantity + quantity;
                    const totalValue = existing.quantity * existing.entryPrice + quantity * price;
                    existing.entryPrice = totalQuantity > 0 ? totalValue / totalQuantity : price;
                    existing.quantity = totalQuantity;
                    existing.marginUsed += margin;
                    existing.leverage = leverage;
                } else {
                    positions.set(key, {
                        tickerId: trade.tickerId,
                        side: trade.positionSide === 'short' ? 'short' : 'long',
                        quantity,
                        entryPrice: price,
                        marginUsed: margin,
                        leverage
                    });
                }

                cash -= margin + fees;
                continue;
            }

            const existing = positions.get(key);
            if (!existing) {
                continue;
            }

            const closeQuantity = Math.min(quantity, existing.quantity);
            const closingRatio = existing.quantity > 0 ? closeQuantity / existing.quantity : 0;
            const releasedMargin = existing.marginUsed * closingRatio;
            const realized = unrealizedPnl({ ...existing, quantity: closeQuantity }, price);

            cash += Math.max(0, releasedMargin + realized - fees);
            existing.quantity -= closeQuantity;
            existing.marginUsed -= releasedMargin;

            if (Math.abs(existing.quantity) < POSITION_QUANTITY_EPSILON) {
                positions.delete(key);
            }
        }

        points.push(markToMarket(timestamp, cash, positions, priceIndex));
    }

    const valid = points.filter((p) => p.equity !== null && Number.isFinite(p.equity));
    const validCount = valid.length;
    const activeExposureRatio = validCount > 0 ? valid.filter((p) => p.hasOpenPosition).length / validCount : 0;
    const totalAbsNotional = valid.reduce((sum, p) => sum + p.absNotionalExposure, 0);
    const avgAbsNotionalRatio = validCount > 0 && startingEquity > 0 ? totalAbsNotional / validCount / startingEquity : 0;

    const score = calculateScore({
        equity: valid.map((p) => p.equity as number),
        startingEquity,
        expectedSampleCount: timestamps.length,
        filledTradeCount: trades.length,
        activeExposureRatio,
        averageAbsNotionalExposureRatio: avgAbsNotionalRatio,
        durationDays
    });

    return { participantId, score: score.score, competitionReturn: score.competitionReturn, filledTradeCount: trades.length };
}

function markToMarket(timestamp: number, cash: number, positions: Map<string, Position>, priceIndex: PriceIndex): EquityPoint {
    let equity = cash;
    let absNotional = 0;

    for (const position of positions.values()) {
        const price = lookupPrice(priceIndex, position.tickerId, timestamp);
        if (price === null) {
            return { equity: null, hasOpenPosition: positions.size > 0, absNotionalExposure: 0 };
        }

        equity += position.marginUsed + unrealizedPnl(position, price);
        absNotional += Math.abs(position.quantity * price * position.leverage);
    }

    return { equity, hasOpenPosition: positions.size > 0, absNotionalExposure: absNotional };
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return value === Infinity ? max : min;
    }

    return Math.min(Math.max(value, min), max);
}

function round(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

function calculateScore(input: {
    equity: number[];
    startingEquity: number;
    expectedSampleCount: number;
    filledTradeCount: number;
    activeExposureRatio: number;
    averageAbsNotionalExposureRatio: number;
    durationDays: number;
}): { score: number | null; competitionReturn: number } {
    const { equity, startingEquity } = input;
    const ending = equity.length > 0 ? equity[equity.length - 1] : startingEquity;
    const competitionReturn =
        Number.isFinite(startingEquity) && startingEquity > 0 && Number.isFinite(ending) ? (ending - startingEquity) / startingEquity : 0;

    // Withheld: invalid inputs, or never traded (a flat curve would earn full marks on drawdown terms).
    if (startingEquity <= 0 || input.expectedSampleCount <= 0 || equity.length === 0 || input.filledTradeCount === 0) {
        return { score: null, competitionReturn };
    }

    let peak = 0;
    const drawdowns = equity.map((e) => {
        peak = Math.max(peak, e);
        return peak <= 0 || e >= peak ? 0 : (peak - e) / peak;
    });

    const maxDrawdown = drawdowns.length > 0 ? Math.max(...drawdowns) : 0;
    const ulcer = drawdowns.length > 0 ? Math.sqrt(drawdowns.reduce((s, d) => s + d ** 2, 0) / drawdowns.length) : 0;

    const sampleReturns: number[] = [];
    for (let i = 1; i < equity.length; i++) {
        if (equity[i - 1] > 0) {
            sampleReturns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
        }
    }

    const downsidePerSample =
        sampleReturns.length > 0 ? Math.sqrt(sampleReturns.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / sampleReturns.length) : 0;
    const downsideDeviation = downsidePerSample * Math.sqrt(sampleReturns.length);
    const sortino = downsideDeviation === 0 ? (competitionReturn > 0 ? Infinity : 0) : competitionReturn / downsideDeviation;
    const calmar = maxDrawdown === 0 ? (competitionReturn > 0 ? Infinity : 0) : competitionReturn / maxDrawdown;

    const minTurnoverTrades = Math.max(4, Math.ceil(input.durationDays / 2));
    const executionActivity = round(
        ((clamp(input.filledTradeCount / minTurnoverTrades, 0, 1) +
            clamp(input.activeExposureRatio / 0.2, 0, 1) +
            clamp(input.averageAbsNotionalExposureRatio / 0.05, 0, 1)) /
            3) *
            100
    );

    const components = {
        pnlScore: round(100 * Math.tanh(competitionReturn / PNL_CURVE_K)),
        calmarScore: round(clamp(calmar / 5, 0, 1) * 100),
        sortinoScore: round(clamp(sortino / 3, 0, 1) * 100),
        ulcerScore: round(clamp(1 - ulcer / 0.1, 0, 1) * 100),
        maxDrawdownScore: round(clamp(1 - maxDrawdown / 0.2, 0, 1) * 100),
        executionActivityScore: executionActivity
    };

    const score = round(
        WEIGHTS.pnlScore * components.pnlScore +
            WEIGHTS.calmarScore * components.calmarScore +
            WEIGHTS.sortinoScore * components.sortinoScore +
            WEIGHTS.ulcerScore * components.ulcerScore +
            WEIGHTS.maxDrawdownScore * components.maxDrawdownScore +
            WEIGHTS.executionActivityScore * components.executionActivityScore
    );

    return { score, competitionReturn };
}
