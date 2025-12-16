import axios from 'axios';

import type { BittensorWeightTarget } from '../config/env';
import config from '../config/env';
import logger from '../config/logger';
import { connectPolkadot } from '../polkadot/connection';
import type { ValidatorIdentity } from '../utils/identity';

const clampWeight = (value: number): number => {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.min(65_535, Math.max(0, Math.round(value)));
};

const dedupeTargets = (targets: readonly BittensorWeightTarget[]): BittensorWeightTarget[] => {
    const seen = new Map<number, number>();

    targets.forEach(({ uid, weight }) => {
        if (!Number.isInteger(uid) || uid < 0) {
            return;
        }

        const normalizedWeight = clampWeight(weight);
        seen.set(uid, normalizedWeight);
    });

    return Array.from(seen.entries())
        .sort(([a], [b]) => a - b)
        .map(([uid, weight]) => ({ uid, weight }));
};

const parseRemoteWeights = (payload: unknown): BittensorWeightTarget[] => {
    if (!payload) {
        return [];
    }

    const candidates = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { weights?: unknown }).weights)
          ? ((payload as { weights: unknown }).weights as unknown[])
          : [];

    return candidates
        .map((candidate) => {
            if (typeof candidate === 'object' && candidate !== null && 'uid' in candidate && 'weight' in candidate) {
                const uid = Number((candidate as { uid: unknown }).uid);
                const weight = Number((candidate as { weight: unknown }).weight);

                if (!Number.isInteger(uid) || uid < 0) {
                    return null;
                }

                if (!Number.isFinite(weight) || weight < 0) {
                    return null;
                }

                return { uid, weight } satisfies BittensorWeightTarget;
            }

            return null;
        })
        .filter((target): target is BittensorWeightTarget => target !== null);
};

const fetchTargets = async (): Promise<BittensorWeightTarget[]> => {
    if (config.bittensor.weightsUrl) {
        try {
            const { data } = await axios.get(config.bittensor.weightsUrl, {
                timeout: 5_000
            });

            const parsed = parseRemoteWeights(data);
            if (parsed.length > 0) {
                return parsed;
            }

            logger.warn(
                {
                    url: config.bittensor.weightsUrl
                },
                'received empty weights payload from remote source'
            );
        } catch (err) {
            logger.error({ err }, 'failed to fetch bittensor weights from remote');
        }
    }

    if (config.bittensor.staticWeights.length > 0) {
        return [...config.bittensor.staticWeights];
    }

    return [];
};

const submitWeights = async (identity: ValidatorIdentity, targets: readonly BittensorWeightTarget[]): Promise<void> => {
    const api = await connectPolkadot(config.bittensor.wsEndpoint);
    const deduped = dedupeTargets(targets);

    if (deduped.length === 0) {
        logger.debug('no bittensor weights to submit after dedupe');
        return;
    }

    const uids = deduped.map((target) => target.uid);
    const weights = deduped.map((target) => target.weight);

    const sample = deduped.slice(0, 5);

    logger.info(
        {
            netuid: config.bittensor.netuid,
            count: deduped.length,
            sample
        },
        'submitting bittensor weights'
    );

    const extrinsic = api.tx.subtensorModule.setWeights(config.bittensor.netuid, uids, weights, config.bittensor.versionKey);

    await new Promise<void>(async (resolve, reject) => {
        let unsub: (() => void) | undefined;

        try {
            unsub = await extrinsic.signAndSend(identity.pair, (result: any) => {
                const { status, dispatchError } = result;

                if (dispatchError) {
                    if (dispatchError.isModule) {
                        const meta = api.registry.findMetaError(dispatchError.asModule);
                        logger.error(
                            {
                                section: meta.section,
                                name: meta.name,
                                docs: meta.docs
                            },
                            'bittensor weight extrinsic failed'
                        );
                        unsub?.();
                        reject(new Error(`${meta.section}.${meta.name}`));
                        return;
                    }

                    logger.error({ error: dispatchError.toString() }, 'bittensor weight extrinsic failed');
                    unsub?.();

                    reject(new Error(dispatchError.toString()));
                    return;
                }

                if (status.isInBlock) {
                    logger.info(
                        {
                            blockHash: status.asInBlock.toHex()
                        },
                        'bittensor weights included in block'
                    );

                    unsub?.();
                    resolve();
                } else if (status.isFinalized) {
                    logger.debug(
                        {
                            blockHash: status.asFinalized.toHex()
                        },
                        'bittensor weights finalized'
                    );
                }
            });
        } catch (err) {
            logger.error({ err }, 'failed to sign and send bittensor weights');

            unsub?.();
            reject(err);
        }
    });
};

export const startBittensorWeightService = async (identity: ValidatorIdentity): Promise<NodeJS.Timeout | null> => {
    if (!config.bittensor.enabled) {
        logger.info('bittensor weight service disabled');
        return null;
    }

    logger.info(
        {
            endpoint: config.bittensor.wsEndpoint,
            netuid: config.bittensor.netuid,
            intervalMs: config.bittensor.weightIntervalMs
        },
        'starting bittensor weight service'
    );

    const run = async () => {
        try {
            const targets = await fetchTargets();
            if (targets.length === 0) {
                logger.debug('no bittensor weights available to submit');
                return;
            }

            await submitWeights(identity, targets);
        } catch (err) {
            logger.error({ err }, 'failed to submit bittensor weights');
        }
    };

    await run();

    return setInterval(run, config.bittensor.weightIntervalMs);
};
