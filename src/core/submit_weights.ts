import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/cjs/types';
import { hexToU8a, isHex, u8aToHex } from '@polkadot/util';
import { cryptoWaitReady, ed25519PairFromSecret, ed25519PairFromSeed } from '@polkadot/util-crypto';
import { getPublicKey } from '@scure/sr25519';
import type { BittensorWeightTarget } from '../config/env';
import config from '../config/env';
import { connectPolkadot } from '../polkadot/connection';
import { logDebug, logError, logInfo, logWarning } from '../utils/logging';
import { computeArenaWeights } from './arena';

export interface SubnetWeightsConfig {
    subnetConnection: SubnetConnectionConfig;
}

export interface SubnetConnectionConfig {
    networkUrl: string;
    subnetId: number;
    ss58Address: string;
    ss58Format?: number;
    secretPhrase: string;
}

export interface SetWeightsResult {
    txHash: string;
    blockNumber: number | null;
    extrinsicIndex: number | null;
}

interface SubnetScheduleParams {
    weightsRateLimit: number;
}

export class SubnetWeights {
    private config: SubnetWeightsConfig;

    private api: ApiPromise | null = null;
    private account: KeyringPair | null = null;

    private lastCommitBlock: number = 0;

    constructor(config: SubnetWeightsConfig) {
        this.config = config;
    }

    async setWeights(uids: number[], weights: number[]): Promise<SetWeightsResult> {
        if (uids.length !== weights.length) {
            throw new Error('Miner IDs and weights arrays must have the same length');
        }
        if (uids.length === 0) {
            throw new Error('Must provide at least one miner');
        }

        try {
            const api = await this.getApi();
            const account = await this.getAccount();
            const subnetId = this.config.subnetConnection.subnetId;
            const versionKey = 0;

            const setWeightsTx = api.tx.subtensorModule.setWeights(subnetId, uids, weights, versionKey);

            let blockNumber: number | null = null;
            let extrinsicIndex: number | null = null;

            const txHash = await new Promise<string>((resolve, reject) => {
                setWeightsTx
                    .signAndSend(account, async (result: { status?: any; dispatchError?: any }) => {
                        const { status, dispatchError } = result;

                        if (status.isInBlock) {
                            logDebug(`Transaction included in block: ${status.asInBlock.toHex()}`);

                            const signedBlock = await api.rpc.chain.getBlock(status.asInBlock);
                            blockNumber = signedBlock.block.header.number.toNumber();

                            const extrinsics = signedBlock.block.extrinsics;
                            extrinsicIndex = extrinsics.findIndex((ex: any) => ex.hash.toHex() === setWeightsTx.hash.toHex());
                        }

                        if (status.isFinalized) {
                            logDebug(`Transaction finalized: ${status.asFinalized.toHex()}`);

                            if (dispatchError) {
                                if (dispatchError.isModule) {
                                    const decoded = api.registry.findMetaError(dispatchError.asModule);
                                    reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`));
                                } else {
                                    reject(new Error(dispatchError.toString()));
                                }
                            } else {
                                resolve(status.asFinalized.toHex());
                            }
                        }
                    })
                    .catch(reject);
            });

            return { txHash, blockNumber, extrinsicIndex };
        } catch (err) {
            logError('Error setting weights', this.getErrorMetadata(err as Error));
            throw err;
        }
    }

    async disconnect(): Promise<void> {
        if (this.api) {
            await this.api.disconnect();
            this.api = null;
        }
    }

    private async getApi(): Promise<ApiPromise> {
        if (!this.api) {
            try {
                const wsProvider = new WsProvider(this.config.subnetConnection.networkUrl);
                this.api = await ApiPromise.create({ provider: wsProvider, noInitWarn: true });
            } catch (err) {
                logError('Failed to create Polkadot API instance', this.getErrorMetadata(err as Error));
                throw err;
            }
        }

        return this.api;
    }

    private async getAccount(): Promise<KeyringPair> {
        if (this.account) {
            return this.account;
        }

        const ready = await cryptoWaitReady();
        if (!ready) {
            throw new Error('failed to initialize crypto libraries for polkadot');
        }

        const keyring = new Keyring({
            type: 'sr25519',
            ss58Format: this.config.subnetConnection.ss58Format
        });

        const secretPhrase = this.config.subnetConnection.secretPhrase.trim();
        const hexSecret = this.normalizeHexSecret(secretPhrase);
        const account = hexSecret
            ? this.addAccountFromHex(keyring, hexSecret, this.config.subnetConnection.ss58Address)
            : keyring.addFromUri(secretPhrase);

        if (!this.matchesExpectedAccount(account, this.config.subnetConnection.ss58Address)) {
            logWarning('The provided validator secret does not match the expected SS58 address', {
                expectedAddress: this.config.subnetConnection.ss58Address || 'N/A',
                derivedAddress: account.address,
                derivedPublicKey: u8aToHex(account.publicKey)
            });
        }

        logDebug(`Using account: ${account.address}`);

        this.account = account;

        return this.account;
    }

    private normalizeHexSecret(secretPhrase: string): string | null {
        if (isHex(secretPhrase)) {
            return secretPhrase;
        }

        if (secretPhrase.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(secretPhrase)) {
            return `0x${secretPhrase}`;
        }

        return null;
    }

    private matchesExpectedAccount(account: KeyringPair, expectedAddress?: string): boolean {
        const normalizedExpectedAddress = expectedAddress?.trim() ?? '';
        if (normalizedExpectedAddress && account.address !== normalizedExpectedAddress) {
            return false;
        }

        return true;
    }

    private addAccountFromHex(keyring: Keyring, secretPhrase: string, expectedAddress?: string): KeyringPair {
        const keyBytes = hexToU8a(secretPhrase);
        const ss58Format = this.config.subnetConnection.ss58Format;
        const candidates: KeyringPair[] = [];

        if (keyBytes.length === 32) {
            candidates.push(keyring.addFromSeed(keyBytes));
            const edKeyring = new Keyring({ type: 'ed25519', ss58Format });
            candidates.push(edKeyring.addFromPair(ed25519PairFromSeed(keyBytes)));
        }

        if (keyBytes.length === 64) {
            candidates.push(
                keyring.addFromPair({
                    publicKey: getPublicKey(keyBytes),
                    secretKey: keyBytes
                })
            );
            candidates.push(keyring.addFromSeed(keyBytes.slice(0, 32)));

            const edKeyring = new Keyring({ type: 'ed25519', ss58Format });
            candidates.push(edKeyring.addFromPair(ed25519PairFromSecret(keyBytes)));
            candidates.push(edKeyring.addFromPair(ed25519PairFromSeed(keyBytes.slice(0, 32))));
        }

        if (keyBytes.length === 96) {
            candidates.push(
                keyring.addFromPair({
                    publicKey: keyBytes.slice(64, 96),
                    secretKey: keyBytes.slice(0, 64)
                })
            );
        }

        for (const candidate of candidates) {
            if (this.matchesExpectedAccount(candidate, expectedAddress)) {
                return candidate;
            }
        }

        if (candidates.length > 0) {
            return candidates[0];
        }

        throw new Error(`invalid validator secret seed length: ${keyBytes.length} bytes`);
    }

    private getErrorMetadata(err: Error): Record<string, any> {
        return {
            message: err?.message ?? '',
            stack: err?.stack ?? '',
            name: err?.name ?? ''
        };
    }

    async submitWeights(uids: number[], weights: number[]): Promise<SetWeightsResult | null> {
        try {
            const scheduleParams = await this.getSubnetScheduleParams();
            const currentBlock = await this.getCurrentBlock();

            const blocksSinceLastCommit = this.lastCommitBlock ? currentBlock - this.lastCommitBlock : Infinity;
            const canCommit = blocksSinceLastCommit >= scheduleParams.weightsRateLimit;

            if (!canCommit) {
                const blocksToWait = scheduleParams.weightsRateLimit - blocksSinceLastCommit;
                const minutesToWait = Math.ceil((blocksToWait * 12) / 60);

                logDebug(`Rate limit active. Need to wait ${blocksToWait} more blocks (~${minutesToWait} minutes)`, {
                    nextCommitBlock: this.lastCommitBlock + scheduleParams.weightsRateLimit
                });

                const sleepMs = blocksToWait * 12 * 1000 + 10_000;
                logDebug(`Sleeping for ${Math.ceil(sleepMs / 1000 / 60)} minutes...`);

                await this.disconnect();
                await this.sleep(sleepMs);

                return null;
            }

            const result = await this.setWeights(uids, weights);

            this.lastCommitBlock = currentBlock;

            logInfo('Weight commit successful', {
                transaction: result.txHash,
                nextCommitAfterBlock: this.lastCommitBlock + scheduleParams.weightsRateLimit
            });

            return result;
        } finally {
            await this.disconnect();
        }
    }

    private async getSubnetScheduleParams(): Promise<SubnetScheduleParams> {
        const api = await this.getApi();
        const subnetId = this.config.subnetConnection.subnetId;

        const weightsRateLimit = await api.query.subtensorModule.weightsSetRateLimit(subnetId);

        return {
            weightsRateLimit: weightsRateLimit.toJSON() as number
        };
    }

    private async getCurrentBlock(): Promise<number> {
        const api = await this.getApi();
        const blockNumber = await api.query.system.number();

        return blockNumber.toJSON() as number;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

export const startSetWeightsService = async (): Promise<NodeJS.Timeout | null> => {
    if (!config.bittensor.enabled) {
        logInfo('Bittensor weight service disabled');
        return null;
    }

    const validatorSecret = config.validatorSecretSeed.trim() || config.validatorMnemonic.trim();
    if (!validatorSecret) {
        logWarning('Validator mnemonic or secret seed not provided, bittensor weight service disabled');
        return null;
    }

    logInfo('Starting bittensor weight service', {
        endpoint: config.bittensor.wsEndpoint,
        netuid: config.bittensor.netuid,
        intervalMs: config.bittensor.weightIntervalMs
    });

    const subnetWeights = new SubnetWeights({
        subnetConnection: {
            networkUrl: config.bittensor.wsEndpoint,
            subnetId: config.bittensor.netuid,
            ss58Address: config.validatorSs58Address,
            ss58Format: config.validatorSs58Format,
            secretPhrase: validatorSecret
        }
    });

    let lastSuccessfulWeights: BittensorWeightTarget[] | null = null;

    const weightsEqual = (a: BittensorWeightTarget[], b: BittensorWeightTarget[]): boolean => {
        if (a.length !== b.length) {
            return false;
        }

        const sortedA = [...a].sort((x, y) => x.uid - y.uid);
        const sortedB = [...b].sort((x, y) => x.uid - y.uid);

        return sortedA.every((w, i) => w.uid === sortedB[i].uid && w.weight === sortedB[i].weight);
    };

    const run = async () => {
        try {
            if (!config.arenaApiUrl) {
                logWarning('ARENA_API_URL not configured, skipping weight computation');
                return;
            }

            const api = await connectPolkadot(config.bittensor.wsEndpoint);
            const targets = await computeArenaWeights(api, config.bittensor.netuid, config.arenaApiUrl);

            let effectiveTargets: BittensorWeightTarget[];

            if (targets === null) {
                if (lastSuccessfulWeights) {
                    logWarning('Failed to fetch arena competitions, reusing last successful weights', {
                        cachedWeights: lastSuccessfulWeights.map((w) => ({ uid: w.uid, weight: w.weight }))
                    });
                    effectiveTargets = lastSuccessfulWeights;
                } else {
                    logWarning('Failed to fetch arena competitions and no previous weights cached, skipping cycle');
                    return;
                }
            } else {
                if (lastSuccessfulWeights && !weightsEqual(targets, lastSuccessfulWeights)) {
                    logInfo('Weight set changed', {
                        slack: true,
                        previous: lastSuccessfulWeights,
                        current: targets
                    });
                }
                lastSuccessfulWeights = targets;
                effectiveTargets = targets;
            }

            const uids = effectiveTargets.map((w) => w.uid);
            const weights = effectiveTargets.map((w) => w.weight);

            logInfo(`Weights ready to submit: ${uids.length} targets (Uids: [${uids.join(', ')}], Weights: [${weights.join(', ')}])`);

            const result = await subnetWeights.submitWeights(uids, weights);

            logInfo(`Submitted weights: ${result?.blockNumber ?? 'N/A'}-${result?.extrinsicIndex?.toString().padStart(4, '0') ?? 'N/A'}`);
        } catch (err) {
            logError('Failed to submit bittensor weights', { err });
        }
    };

    await run();

    return setInterval(run, config.bittensor.weightIntervalMs);
};
