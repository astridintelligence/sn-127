import { logDebug, logWarning } from '../../utils/logging';

const FETCH_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 500;
const PRESENCE_PAGE_SIZE = 2000;
const MAX_PAGES = 100;

export interface CompetitionParticipantInfo {
    participantId: string;
    coldkey: string;
    hotkey: string | null;
    uid: number | null;
    isDisqualified: boolean;
}

export interface CompletedCompetition {
    competitionId: string;
    name: string;
    startTime: string;
    endTime: string;
    initialBalance: number;
    emissionsStartDate: string;
    emissionsEndDate: string;
    participants: CompetitionParticipantInfo[];
}

export async function fetchCompletedCompetitions(baseUrl: string): Promise<CompletedCompetition[]> {
    const data = await fetchJson<{ competitions: CompletedCompetition[] }>(`${baseUrl}/public/arena/completed-competitions`);
    return data.competitions ?? [];
}

export interface TradeEntry {
    id: string;
    executedAt: string;
    participantId: string | null;
    agentId: string;
    side: string;
    positionSide: string;
    ticker: string;
    quantity: number;
    price: number;
    fees: number;
    realizedPnl: number;
    leverage: number | null;
}

export interface ExecutionEntry {
    id: string;
    executionTime: string;
    participantId: string | null;
    executionNumber: number;
    isExternal: boolean;
}

export interface PresenceEntry {
    participantId: string | null;
    executionTime: string;
}

export async function fetchAllTrades(baseUrl: string, competitionId: string, after: string | null): Promise<TradeEntry[]> {
    const all: TradeEntry[] = [];
    let offset = 0;
    let page = 0;

    while (page < MAX_PAGES) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (after) {
            params.set('after', after);
        }

        const url = `${baseUrl}/public/competitions/${competitionId}/wallet-activity?${params}`;

        logDebug('Fetching trades page', { competitionId, page, offset, after });

        const data = await fetchJson<{ trades: TradeEntry[] }>(url);
        const batch = data.trades ?? [];

        all.push(...batch);
        logDebug('Fetched trades page', { competitionId, page, fetched: batch.length, total: all.length });

        if (batch.length < PAGE_SIZE) {
            break;
        }

        offset += PAGE_SIZE;
        page++;
    }

    if (page >= MAX_PAGES) {
        logWarning('fetchAllTrades hit page limit', { competitionId, maxPages: MAX_PAGES, total: all.length });
    }

    return all;
}

export async function fetchExecutionPresence(
    baseUrl: string,
    competitionId: string,
    participantIds: string[],
    after: string | null
): Promise<PresenceEntry[]> {
    const all: PresenceEntry[] = [];
    let offset = 0;
    let page = 0;

    while (page < MAX_PAGES) {
        const params = new URLSearchParams({ limit: String(PRESENCE_PAGE_SIZE), offset: String(offset), participantIds: participantIds.join(',') });
        if (after) {
            params.set('after', after);
        }

        const url = `${baseUrl}/public/competitions/${competitionId}/executions/presence?${params}`;

        logDebug('Fetching execution presence page', { competitionId, page, offset, after });

        const data = await fetchJson<{ executions: PresenceEntry[] }>(url);
        const batch = data.executions ?? [];

        all.push(...batch);
        logDebug('Fetched execution presence page', { competitionId, page, fetched: batch.length, total: all.length });

        if (batch.length < PRESENCE_PAGE_SIZE) {
            break;
        }

        offset += PRESENCE_PAGE_SIZE;
        page++;
    }

    if (page >= MAX_PAGES) {
        logWarning('fetchExecutionPresence hit page limit', { competitionId, maxPages: MAX_PAGES, total: all.length });
    }

    return all;
}

function withTimeout(ms: number): AbortSignal {
    return AbortSignal.timeout(ms);
}

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { signal: withTimeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`Arena API error ${res.status} for ${url}`);
    }

    return res.json() as Promise<T>;
}
