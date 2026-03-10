import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/cjs/types';
import { hexToU8a, isHex, u8aToHex } from '@polkadot/util';
import { cryptoWaitReady, ed25519PairFromSecret, ed25519PairFromSeed } from '@polkadot/util-crypto';
import { getPublicKey } from '@scure/sr25519';
import crypto from 'crypto';
import { HttpCachingChain, HttpChainClient, type ChainOptions } from 'drand-client';
import { roundAt, timelockEncrypt } from 'tlock-js';
import config, { BittensorWeightTarget } from '../config/env';
import logger from '../config/logger';
import { connectPolkadot } from '../polkadot/connection';
import { computeArenaWeights } from './arena';
import { fetchTargets } from './bittensor-weights';

const defaultTempo = 360;
const defaultCommitRevealPeriod = 1;

export interface SubnetWeightsConfig {
    subnetConnection: SubnetConnectionConfig;
    drand: DrandConfig;
}

export interface SubnetConnectionConfig {
    networkUrl: string;
    subnetId: number;
    ss58Address: string;
    ss58Format?: number;
    secretPhrase: string;
}

export interface DrandConfig {
    apiBaseUrl: string;
    chainHash: string;
    publicKey: string;
}

export interface LoggerConfig {
    level?: string;
    pretty?: boolean;
}

interface SubnetInfo {
    commitRevealEnabled: boolean;
    commitRevealPeriod: number;
    tempo: number;
}

interface SubnetScheduleParams {
    tempo: number;
    weightsRateLimit: number;
    activityCutoff: number;
    commitRevealEnabled: boolean;
    revealPeriodEpochs: number;
}

export interface CommitWeightsResult {
    txHash: string;
    encryptedCommit: string;
    targetRound: number;
    blockNumber: number | null;
    extrinsicIndex: number | null;
}

export interface SetWeightsResult {
    // For commit-reveal
    commitHash?: string;
    salt?: string;
    revealAfterBlocks?: number;
    targetRound?: number;

    // For standard
    standardHash?: string;

    blockNumber?: number | null;
    extrinsicIndex?: number | null;
}

export class SubnetWeights {
    private config: SubnetWeightsConfig;

    private chainOptions: ChainOptions;

    private api: ApiPromise | null = null;
    private account: KeyringPair | null = null;

    private lastCommitBlock: number = 0;

    constructor(config: SubnetWeightsConfig) {
        this.config = config;
        if (!this.validateConfig()) {
            throw new Error('Invalid SubnetWeightsConfig: Missing required Drand configuration fields');
        }

        this.chainOptions = {
            disableBeaconVerification: false,
            noCache: false,
            chainVerificationParams: {
                chainHash: this.config.drand.chainHash,
                publicKey: this.config.drand.publicKey
            }
        };
    }

    private validateConfig(): boolean {
        const drand = this.config.drand;
        return !!(drand.apiBaseUrl && drand.chainHash && drand.publicKey);
    }

    async setWeights(uids: number[], weights: number[]): Promise<SetWeightsResult> {
        if (uids.length !== weights.length) {
            throw new Error('Miner IDs and weights arrays must have the same length');
        }

        if (uids.length === 0) {
            throw new Error('Must provide at least one miner');
        }

        try {
            const subnetInfo = await this.getSubnetInfo();

            // Choose method based on commit-reveal setting
            if (subnetInfo.commitRevealEnabled) {
                const revealAfterBlocks = subnetInfo.commitRevealPeriod * subnetInfo.tempo;
                logger.debug(`Weights will be revealed after: ${revealAfterBlocks} blocks (~${Math.floor((revealAfterBlocks * 12) / 60)} minutes)\n`);

                const salt = crypto.randomBytes(8);
                const targetRound = await this.calculateTargetRound(revealAfterBlocks, 12);

                const {
                    txHash,
                    targetRound: actualTargetRound,
                    blockNumber,
                    extrinsicIndex
                } = await this.commitCRWeights(uids, weights, salt, targetRound);

                return {
                    commitHash: txHash,
                    salt: salt.toString('hex'),
                    revealAfterBlocks,
                    targetRound: actualTargetRound,
                    blockNumber,
                    extrinsicIndex
                };
            } else {
                logger.debug('Standard Mode (No Commit-Reveal)');

                const txHash = await this.setWeightsStandard(uids, weights);

                logger.debug('Weights set successfully.');

                return {
                    standardHash: txHash
                };
            }
        } catch (err) {
            logger.error(`Error setting weights: ${JSON.stringify(this.getErrorMetadata(err as Error))}`);
            throw err;
        }
    }

    private async commitCRWeights(uids: number[], weights: number[], salt: Uint8Array, targetRound: number): Promise<CommitWeightsResult> {
        const api = await this.getApi();
        const account = await this.getAccount();
        const subnetId = this.config.subnetConnection.subnetId;

        const encryptedCommit = await this.createTimelockCommit(uids, weights, salt, targetRound);

        const extrinsics = Object.keys(api.tx.subtensorModule);

        let commitTx;

        if (api.tx.subtensorModule.commitCrv3Weights) {
            commitTx = api.tx.subtensorModule.commitCrv3Weights(subnetId, Array.from(encryptedCommit), targetRound);
        } else if (api.tx.subtensorModule.commitTimelockedWeights) {
            const commitRevealVersion = 4;
            commitTx = api.tx.subtensorModule.commitTimelockedWeights(subnetId, Array.from(encryptedCommit), targetRound, commitRevealVersion);
        } else {
            throw new Error(
                'Could not find CRv3 / CRv4 commit extrinsic. Available commit extrinsics: ' +
                    extrinsics.filter((e) => e.toLowerCase().includes('commit')).join(', ') +
                    '\n\nThis subnet may not support Drand timelock encryption. ' +
                    'Try using the simple hash approach instead.'
            );
        }

        logger.debug('Submitting timelock commit transaction ...');

        let blockNumber: number | null = null;
        let extrinsicIndex: number | null = null;

        const txHash = await new Promise<string>((resolve, reject) => {
            commitTx
                .signAndSend(account, async (result: any) => {
                    const { status, dispatchError } = result;

                    if (result.status.isInBlock || result.status.isFinalized) {
                        const blockHash = result.status.isInBlock ? result.status.asInBlock : result.status.asFinalized;

                        const signedBlock = await api.rpc.chain.getBlock(blockHash);
                        blockNumber = signedBlock.block.header.number.toNumber();

                        const extrinsics = signedBlock.block.extrinsics;
                        extrinsicIndex = -1;

                        extrinsics.forEach((ex, index) => {
                            if (ex.hash.toHex() === commitTx.hash.toHex()) {
                                extrinsicIndex = index;
                            }
                        });
                    }

                    if (status.isFinalized) {
                        logger.debug(`Commit finalized: ${status.asFinalized.toHex()}`);

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

        return { txHash, encryptedCommit, targetRound, blockNumber, extrinsicIndex };
    }

    private async createTimelockCommit(uids: number[], weights: number[], salt: Uint8Array, targetRound: number): Promise<string> {
        const versionKey = 0;

        const data = Buffer.concat([
            Buffer.from(new Uint16Array(uids).buffer),
            Buffer.from(new Uint16Array(weights).buffer),
            salt,
            Buffer.from(new Uint32Array([versionKey]).buffer) //
        ]);

        const client = this.getDrandClient();

        const cipherText = await timelockEncrypt(targetRound, data, client);

        return cipherText;
    }

    private async setWeightsStandard(uids: any[], weights: any[]): Promise<string> {
        const api = await this.getApi();
        const account = await this.getAccount();
        const subnetId = this.config.subnetConnection.subnetId;
        const versionKey = 0;

        const setWeightsTx = api.tx.subtensorModule.setWeights(subnetId, uids, weights, versionKey);

        return new Promise((resolve, reject) => {
            setWeightsTx
                .signAndSend(account, (result: { status?: any; dispatchError?: any }) => {
                    const { status, dispatchError } = result;
                    if (status.isInBlock) {
                        logger.debug(`Transaction included in block: ${status.asInBlock.toHex()}`);
                    }

                    if (status.isFinalized) {
                        logger.debug(`Transaction finalized: ${status.asFinalized.toHex()}`);

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
    }

    private async calculateTargetRound(blocksInFuture: number, blockTime: number = 12): Promise<number> {
        const client = this.getDrandClient();

        const chainInfo = await client.chain().info();

        const currentTimeMs = Date.now();
        const targetTimeMs = currentTimeMs + blocksInFuture * blockTime * 1000;

        const targetRound = roundAt(targetTimeMs, chainInfo);

        return targetRound;
    }

    private getDrandClient(): HttpChainClient {
        const chain = new HttpCachingChain(`${this.config.drand.apiBaseUrl}/${this.config.drand.chainHash}`, this.chainOptions);
        const client = new HttpChainClient(chain);

        return client;
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
                logger.error(this.getErrorMetadata(err as Error), 'Failed to create Polkadot API instance');
                throw err;
            }
        }

        return this.api;
    }

    private async getSubnetInfo(): Promise<SubnetInfo> {
        const api = await this.getApi();

        const subnetId = this.config.subnetConnection.subnetId;
        const commitRevealEnabled = await api.query.subtensorModule.commitRevealWeightsEnabled(subnetId);
        const revealPeriodEpochs = await api.query.subtensorModule.revealPeriodEpochs(subnetId);
        const tempo = await api.query.subtensorModule.tempo(subnetId);

        const subnetInfo: SubnetInfo = {
            commitRevealEnabled: commitRevealEnabled.toJSON() as boolean,
            commitRevealPeriod: (revealPeriodEpochs.toJSON() as number) || defaultCommitRevealPeriod,
            tempo: (tempo.toJSON() as number) || defaultTempo
        };

        logger.debug('Subnet Configuration:');
        logger.debug(`  - Commit-Reveal Enabled: ${subnetInfo.commitRevealEnabled}`);
        logger.debug(`  - Commit-Reveal Period: ${subnetInfo.commitRevealPeriod} tempos`);
        logger.debug(`  - Tempo: ${subnetInfo.tempo} blocks`);

        return subnetInfo;
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
            logger.warn(
                'The provided validator secret does not match the expected SS58 address. ' +
                    `Expected Address: ${this.config.subnetConnection.ss58Address || 'N/A'}. ` +
                    `Derived Address: ${account.address}, Derived Public Key: ${u8aToHex(account.publicKey)}`
            );
        }

        logger.debug(`Using account: ${account.address}`);

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

    private normalizeHex(value?: string): string | null {
        const trimmed = value?.trim() ?? '';
        if (!trimmed) {
            return null;
        }

        if (isHex(trimmed)) {
            return trimmed.toLowerCase();
        }

        if (trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
            return `0x${trimmed}`.toLowerCase();
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

    getErrorMetadata(err: Error): Record<string, any> {
        let metadata: Record<string, any> = {};

        if (err) {
            metadata['message'] = err.message || '';
            metadata['stack'] = err.stack || '';
            metadata['name'] = err.name || '';
            metadata['cause'] = err.cause || '';
        }

        return metadata;
    }

    async submitWeights(uids: number[], weights: number[]): Promise<SetWeightsResult | null> {
        try {
            const scheduleParams = await this.getSubnetScheduleParams();
            const currentBlock = await this.getCurrentBlock();

            // Calculate if we can commit
            const blocksSinceLastCommit = this.lastCommitBlock ? currentBlock - this.lastCommitBlock : Infinity;
            const canCommit = blocksSinceLastCommit >= scheduleParams.weightsRateLimit;

            if (!canCommit) {
                const blocksToWait = scheduleParams.weightsRateLimit - blocksSinceLastCommit;
                const minutesToWait = Math.ceil((blocksToWait * 12) / 60);

                logger.debug(`Rate limit active. Need to wait ${blocksToWait} more blocks (~${minutesToWait} minutes)`);
                logger.debug(`   Next commit available at block: ${this.lastCommitBlock + scheduleParams.weightsRateLimit}`);

                // Sleep until we can commit (with a small buffer)
                const sleepMs = blocksToWait * 12 * 1000 + 10000; // blocks * 12s + 10s buffer
                logger.debug(`   Sleeping for ${Math.ceil(sleepMs / 1000 / 60)} minutes...`);

                await this.disconnect();
                await this.sleep(sleepMs);

                return null;
            }

            const result = await this.setWeights(uids, weights);

            this.lastCommitBlock = currentBlock;

            logger.info('Weight commit successful!');
            logger.info(`   Transaction: ${result.commitHash || result.standardHash}`);
            logger.info(`   Next commit available after block: ${this.lastCommitBlock + scheduleParams.weightsRateLimit}`);

            return result;
        } finally {
            await this.disconnect();
        }
    }

    private async getSubnetScheduleParams(): Promise<SubnetScheduleParams> {
        const api = await this.getApi();
        const subnetId = this.config.subnetConnection.subnetId;

        const tempo = await api.query.subtensorModule.tempo(subnetId);
        const weightsRateLimit = await api.query.subtensorModule.weightsSetRateLimit(subnetId);
        const activityCutoff = await api.query.subtensorModule.activityCutoff(subnetId);
        const commitRevealEnabled = await api.query.subtensorModule.commitRevealWeightsEnabled(subnetId);
        const revealPeriodEpochs = await api.query.subtensorModule.revealPeriodEpochs(subnetId);

        return {
            tempo: tempo.toJSON() as number,
            weightsRateLimit: weightsRateLimit.toJSON() as number,
            activityCutoff: activityCutoff.toJSON() as number,
            commitRevealEnabled: commitRevealEnabled.toJSON() as boolean,
            revealPeriodEpochs: revealPeriodEpochs.toJSON() as number
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

// Drand configuration - https://docs.drand.love/dev-guide/API%20Documentation%20v1/chains

export const startSetWeightsService = async (): Promise<NodeJS.Timeout | null> => {
    if (!config.bittensor.enabled) {
        logger.info('bittensor weight service disabled');
        return null;
    }

    const validatorSecret = config.validatorSecretSeed.trim() || config.validatorMnemonic.trim();
    if (!validatorSecret) {
        logger.warn('validator mnemonic or secret seed not provided; bittensor weight service disabled');
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

    const subnetWeightsConfig: SubnetWeightsConfig = {
        subnetConnection: {
            networkUrl: config.bittensor.wsEndpoint,
            subnetId: config.bittensor.netuid,
            ss58Address: config.validatorSs58Address,
            ss58Format: config.validatorSs58Format,
            secretPhrase: validatorSecret
        },
        drand: config.drandConfig
    };

    const subnetWeights = new SubnetWeights(subnetWeightsConfig);

    const run = async () => {
        try {
            const vaultTargets = await fetchTargets();
            if (vaultTargets.length === 0) {
                logger.debug('no bittensor weights available to submit');
                return;
            }

            // Attempt to blend in arena miner weights if configured
            let targets: readonly BittensorWeightTarget[] = vaultTargets;
            if (config.arenaApiUrl) {
                try {
                    const api = await connectPolkadot(config.bittensor.wsEndpoint);
                    const blended = await computeArenaWeights(api, config.bittensor.netuid, config.arenaApiUrl, vaultTargets);
                    if (blended) {
                        targets = blended;
                    }
                } catch (err) {
                    logger.error({ err }, 'arena weight computation failed — falling back to vault-only weights');
                }
            }

            const uids = targets.map((w) => w.uid);
            const weights = targets.map((w) => w.weight);

            logger.info(
                `Weights ready to submit: ${uids.length} targets (Uids: [${uids.join(', ')}], Weights: [${weights.join(', ')}])${subnetWeights ? '' : '.'}`
            );

            const result = await subnetWeights.submitWeights(uids, weights);

            logger.info(
                `Submitted weights successfully: ${result?.blockNumber || 'N/A'}-${result?.extrinsicIndex?.toString().padStart(4, '0') || 'N/A'}`
            );
        } catch (err) {
            logger.error({ err }, 'failed to submit bittensor weights');
        }
    };

    await run();

    return setInterval(run, config.bittensor.weightIntervalMs);
};
