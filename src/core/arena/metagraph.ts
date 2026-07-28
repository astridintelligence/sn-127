/**
 * Metagraph UID/hotkey lookup for the sn-127 validator.
 *
 * Builds two indices from the chain:
 *   byColdkey: coldkey → NeuronRecord[]   (all registrations for a coldkey)
 *   byHotkey:  hotkey  → NeuronRecord     (unique — one registration per hotkey)
 *
 * Results are cached for CACHE_TTL_MS to avoid hammering the chain on every cycle.
 */

import type { ApiPromise } from '@polkadot/api';
import { logError, logInfo, logWarning } from '../../utils/logging';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const RPC_RETRIES = 2;
const RPC_RETRY_BASE_MS = 2000;

export interface NeuronRecord {
    uid: number;
    hotkey: string;
    coldkey: string;
}

interface MetagraphCache {
    byColdkey: Map<string, NeuronRecord[]>;
    byHotkey: Map<string, NeuronRecord>;
    fetchedAt: number;
    netuid: number;
}

/**
 * Thrown when the metagraph cannot be read and there is no cache to fall back on.
 * `computeArenaWeights` turns this into a null return so the caller reuses its last
 * successful weight set instead of skipping the cycle.
 */
export class MetagraphUnavailableError extends Error {
    constructor(cause: unknown) {
        super(`Metagraph is unavailable: ${(cause as Error)?.message ?? String(cause)}`);
        this.name = 'MetagraphUnavailableError';
        this.cause = cause;
    }
}

class UnsupportedStorageLayoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedStorageLayoutError';
    }
}

let cache: MetagraphCache | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshCache(api: ApiPromise, netuid: number): Promise<void> {
    const q = (api.query as any).subtensorModule;
    const byColdkey = new Map<string, NeuronRecord[]>();
    const byHotkey = new Map<string, NeuronRecord>();

    const addNeuron = (coldkey: string, hotkey: string, uid: number) => {
        const record: NeuronRecord = { uid, hotkey, coldkey };

        byHotkey.set(hotkey, record);

        const existing = byColdkey.get(coldkey);
        if (existing) {
            existing.push(record);
        } else {
            byColdkey.set(coldkey, [record]);
        }
    };

    if (q.neurons) {
        const entries: [unknown, unknown][] = await q.neurons.entries(netuid);

        for (const [, neuronRaw] of entries) {
            const neuron = (neuronRaw as any).toJSON() as Record<string, unknown> | null;
            if (!neuron) {
                continue;
            }

            const coldkey = typeof neuron.coldkey === 'string' ? neuron.coldkey : null;
            const hotkey = typeof neuron.hotkey === 'string' ? neuron.hotkey : null;
            const uid = typeof neuron.uid === 'number' ? neuron.uid : null;

            if (coldkey && hotkey && uid !== null) {
                addNeuron(coldkey, hotkey, uid);
            }
        }
    } else if (q.keys && q.owner) {
        const keyEntries: [any, unknown][] = await q.keys.entries(netuid);

        const resolved: { hotkey: string; uid: number }[] = [];
        for (const [storageKey, hotkeyRaw] of keyEntries) {
            const hotkey = (hotkeyRaw as any).toJSON() as string | null;
            if (!hotkey) {
                continue;
            }

            resolved.push({ hotkey, uid: storageKey.args[1].toNumber() as number });
        }

        const coldkeysRaw = await q.owner.multi(resolved.map((r) => r.hotkey));

        resolved.forEach(({ hotkey, uid }, index) => {
            const coldkey = coldkeysRaw[index]?.toJSON() as string | null;

            if (coldkey && uid !== null) {
                addNeuron(coldkey, hotkey, uid);
            }
        });
    } else {
        throw new UnsupportedStorageLayoutError(
            `subtensorModule storage layout not recognized — neither 'neurons' nor 'keys/owner' found. Available keys: ${Object.keys(q).join(', ')}`
        );
    }

    logInfo('Metagraph cache refreshed', { netuid, coldkeys: byColdkey.size, hotkeys: byHotkey.size });

    cache = { byColdkey, byHotkey, fetchedAt: Date.now(), netuid };
}

/**
 * Return a usable cache, refreshing it when stale.
 *
 * A refresh that fails is retried RPC_RETRIES times; if it still fails, a previously
 * fetched cache is served stale rather than failing the caller. Only a refresh with no
 * cache at all to fall back on throws MetagraphUnavailableError.
 */
async function ensureCache(api: ApiPromise, netuid: number): Promise<MetagraphCache> {
    // A cache for a different netuid can't be reused, not even as a stale fallback.
    const usable = cache && cache.netuid === netuid ? cache : null;

    if (usable && Date.now() - usable.fetchedAt <= CACHE_TTL_MS) {
        return usable;
    }

    for (let attempt = 0; ; attempt++) {
        try {
            await refreshCache(api, netuid);

            return cache!;
        } catch (err) {
            // A layout mismatch is a permanent problem — retrying it just delays the real error.
            if (err instanceof UnsupportedStorageLayoutError) {
                throw err;
            }

            if (attempt < RPC_RETRIES) {
                logWarning('Metagraph refresh failed, retrying', { netuid, attempt: attempt + 1, err });

                await sleep((attempt + 1) * RPC_RETRY_BASE_MS);

                continue;
            }

            logError('Metagraph refresh failed after retries', { netuid, attempts: attempt + 1, err });

            if (usable) {
                logWarning('Serving stale metagraph cache', { netuid, ageMs: Date.now() - usable.fetchedAt });

                return usable;
            }

            throw new MetagraphUnavailableError(err);
        }
    }
}

/**
 * Look up all registrations for a given coldkey on the subnet.
 * Returns an empty array if the coldkey is not registered.
 */
export async function getNeuronsByColdkey(api: ApiPromise, netuid: number, coldkey: string): Promise<NeuronRecord[]> {
    const c = await ensureCache(api, netuid);
    return c.byColdkey.get(coldkey) ?? [];
}

/**
 * Look up the registration for a given hotkey on the subnet.
 * Returns null if the hotkey is not registered.
 */
export async function getNeuronByHotkey(api: ApiPromise, netuid: number, hotkey: string): Promise<NeuronRecord | null> {
    const c = await ensureCache(api, netuid);
    return c.byHotkey.get(hotkey) ?? null;
}

/** Force-invalidate the cache (e.g. after a known registration event). */
export function invalidateMetagraphCache(): void {
    cache = null;
}
