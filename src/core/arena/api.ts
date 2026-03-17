const FETCH_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 500;

export interface ArenaParticipant {
    participantId: string;
    coldkey: string;
    hotkey: string | null;
    uid: number | null;
    totalPnlPercent: number;
    totalTrades: number;
    rank: number | null;
}

export interface ArenaCompetition {
    id: string;
    name: string;
    status: string;
    startTime: string;
}

export interface ArenaInfo {
    arenaEmissionsPercent: number;
    competition: ArenaCompetition | null;
    participants: ArenaParticipant[];
}

export interface TradeEntry {
    id: string;
    executedAt: string;
    participantId: string | null;
    agentId: string;
    side: string;
    ticker: string;
}

export interface ExecutionEntry {
    id: string;
    executionTime: string;
    participantId: string | null;
    executionNumber: number;
    isExternal: boolean;
}

export async function fetchArenaInfo(baseUrl: string): Promise<ArenaInfo> {
    return fetchJson<ArenaInfo>(`${baseUrl}/public/arena/bittensor`);
}

export async function fetchAllTrades(baseUrl: string, competitionId: string, after: string | null): Promise<TradeEntry[]> {
    const all: TradeEntry[] = [];
    let offset = 0;

    while (true) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (after) {
            params.set('after', after);
        }

        const url = `${baseUrl}/public/competitions/${competitionId}/wallet-activity?${params}`;
        const data = await fetchJson<{ trades: TradeEntry[] }>(url);
        const page = data.trades ?? [];

        all.push(...page);
        if (page.length < PAGE_SIZE) {
            break;
        }

        offset += PAGE_SIZE;
    }

    return all;
}

export async function fetchAllExecutions(baseUrl: string, competitionId: string, after: string | null): Promise<ExecutionEntry[]> {
    const all: ExecutionEntry[] = [];
    let offset = 0;

    while (true) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (after) {
            params.set('after', after);
        }

        const url = `${baseUrl}/public/competitions/${competitionId}/executions?${params}`;
        const data = await fetchJson<{ executions: ExecutionEntry[] }>(url);
        const page = data.executions ?? [];

        all.push(...page);
        if (page.length < PAGE_SIZE) {
            break;
        }
        offset += PAGE_SIZE;
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
