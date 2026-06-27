import type { TradeEntry } from './api';

interface Position {
    quantity: number;
    avgEntryPrice: number;
    leverage: number;
}

export interface ParticipantPnl {
    participantId: string;
    totalPnlAmount: number;
    totalPnlPercent: number;
}

/**
 * Compute replayed PnL for every participant in a competition.
 *
 * @param allTrades     All trades for the competition (mixed participants).
 * @param initialBalance Competition initial wallet balance (for PnL%).
 * @returns Map from participantId → replayed PnL.
 */
export function computeAllParticipantPnl(allTrades: TradeEntry[], initialBalance: number): Map<string, ParticipantPnl> {
    const byParticipant = new Map<string, TradeEntry[]>();

    for (const trade of allTrades) {
        const pid = trade.participantId ?? '';
        if (!pid) {
            continue;
        }

        if (!byParticipant.has(pid)) {
            byParticipant.set(pid, []);
        }

        byParticipant.get(pid)!.push(trade);
    }

    const result = new Map<string, ParticipantPnl>();

    for (const [participantId, trades] of byParticipant) {
        result.set(participantId, replayParticipantTrades(participantId, trades, initialBalance));
    }

    return result;
}

function replayParticipantTrades(participantId: string, trades: TradeEntry[], initialBalance: number): ParticipantPnl {
    // Sort chronologically
    const sorted = [...trades].sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime());

    // Track open positions keyed by "ticker:positionSide"
    const positions = new Map<string, Position>();
    let totalPnlAmount = 0;

    for (const trade of sorted) {
        const key = `${trade.ticker}:${trade.positionSide}`;
        const isOpeningTrade = isOpening(trade.side, trade.positionSide);
        const leverage = trade.leverage ?? 1;

        if (isOpeningTrade) {
            // Add to (or open) a position using weighted average entry price
            const existing = positions.get(key);
            if (existing) {
                const totalQty = existing.quantity + trade.quantity;
                const newAvgEntry = (existing.quantity * existing.avgEntryPrice + trade.quantity * trade.price) / totalQty;
                positions.set(key, { quantity: totalQty, avgEntryPrice: newAvgEntry, leverage });
            } else {
                positions.set(key, { quantity: trade.quantity, avgEntryPrice: trade.price, leverage });
            }
        } else {
            // Closing/reducing a position — compute realized PnL
            const existing = positions.get(key);
            const entryPrice = existing?.avgEntryPrice ?? trade.price;
            const effectiveLeverage = existing?.leverage ?? leverage;

            const priceDiff = trade.positionSide === 'long' ? trade.price - entryPrice : entryPrice - trade.price;

            const tradePnl = priceDiff * trade.quantity * effectiveLeverage - trade.fees;
            totalPnlAmount += tradePnl;

            if (existing) {
                const remainingQty = existing.quantity - trade.quantity;

                if (remainingQty > 0.000001) {
                    positions.set(key, { ...existing, quantity: remainingQty });
                } else {
                    positions.delete(key);
                }
            }
        }
    }

    const totalPnlPercent = initialBalance > 0 ? (totalPnlAmount / initialBalance) * 100 : 0;

    return { participantId, totalPnlAmount, totalPnlPercent };
}

/**
 * Returns true when the trade adds to / opens a position rather than closing it.
 *
 * Convention (mirrors platform tradingService):
 *   long position  → buy opens, sell closes
 *   short position → sell opens, buy closes
 */
function isOpening(side: string, positionSide: string): boolean {
    return (positionSide === 'long' && side === 'buy') || (positionSide === 'short' && side === 'sell');
}
