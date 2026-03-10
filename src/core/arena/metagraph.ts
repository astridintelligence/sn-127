/**
 * Metagraph UID/hotkey lookup for the sn-127 validator.
 *
 * Queries the Bittensor chain to build a coldkey → { uid, hotkey } map for
 * all registered neurons on the target subnet. Results are cached for
 * CACHE_TTL_MS to avoid hammering the chain on every weight cycle.
 */

import type { ApiPromise } from '@polkadot/api';
import logger from '../../config/logger';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface NeuronRecord {
    uid: number;
    hotkey: string;
}

interface MetagraphCache {
    neurons: Map<string, NeuronRecord>; // coldkey → { uid, hotkey }
    fetchedAt: number;
    netuid: number;
}

let cache: MetagraphCache | null = null;

async function refreshCache(api: ApiPromise, netuid: number): Promise<void> {
    const q = (api.query as any).subtensorModule;
    const neurons = new Map<string, NeuronRecord>();

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
                neurons.set(coldkey, { uid, hotkey });
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
                neurons.set(coldkey, { uid, hotkey });
            }
        }
    } else {
        throw new Error(
            `subtensorModule storage layout not recognized — neither 'neurons' nor 'keys/owner' found. Available keys: ${Object.keys(q).join(', ')}`
        );
    }

    logger.info({ netuid, count: neurons.size }, 'arena metagraph cache refreshed');

    cache = { neurons, fetchedAt: Date.now(), netuid };
}

/**
 * Look up the UID and hotkey for a given coldkey on the subnet.
 * Returns null if the coldkey is not registered.
 */
export async function getNeuronByColdkey(api: ApiPromise, netuid: number, coldkey: string): Promise<NeuronRecord | null> {
    const isStale = !cache || cache.netuid !== netuid || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
    if (isStale) {
        await refreshCache(api, netuid);
    }

    return cache!.neurons.get(coldkey) ?? null;
}

/** Force-invalidate the cache (e.g. after a known registration event). */
export function invalidateMetagraphCache(): void {
    cache = null;
}
