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
import logger from '../../config/logger';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

let cache: MetagraphCache | null = null;

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

        for (const [storageKey, hotkeyRaw] of keyEntries) {
            const hotkey = (hotkeyRaw as any).toJSON() as string | null;
            if (!hotkey) {
                continue;
            }

            const uid = storageKey.args[1].toNumber() as number;
            const coldkeyRaw = await q.owner(hotkey);
            const coldkey = coldkeyRaw.toJSON() as string | null;

            if (coldkey && uid !== null) {
                addNeuron(coldkey, hotkey, uid);
            }
        }
    } else {
        throw new Error(
            `subtensorModule storage layout not recognized — neither 'neurons' nor 'keys/owner' found. Available keys: ${Object.keys(q).join(', ')}`
        );
    }

    logger.info({ netuid, coldkeys: byColdkey.size, hotkeys: byHotkey.size }, 'arena metagraph cache refreshed');

    cache = { byColdkey, byHotkey, fetchedAt: Date.now(), netuid };
}

async function ensureCache(api: ApiPromise, netuid: number): Promise<MetagraphCache> {
    const isStale = !cache || cache.netuid !== netuid || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
    if (isStale) {
        await refreshCache(api, netuid);
    }

    return cache!;
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
