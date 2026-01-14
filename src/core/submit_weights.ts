import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/cjs/types';
import crypto from 'crypto';
import { HttpCachingChain, HttpChainClient, type ChainOptions } from 'drand-client';
import { roundAt, timelockEncrypt } from 'tlock-js';
import config from '../config/env';
import logger from '../config/logger';
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
    private subnetInfo: SubnetInfo | null = null;
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

            const normalizedWeights = this.normalizeWeights(weights);

            // Choose method based on commit-reveal setting
            if (subnetInfo.commitRevealEnabled) {
                const revealAfterBlocks = subnetInfo.commitRevealPeriod * subnetInfo.tempo;
                logger.debug(`Weights will be revealed after: ${revealAfterBlocks} blocks (~${Math.floor((revealAfterBlocks * 12) / 60)} minutes)\n`);

                const salt = crypto.randomBytes(8);
                const targetRound = await this.calculateTargetRound(revealAfterBlocks, 12);

                const {
                    txHash,
                    encryptedCommit,
                    targetRound: actualTargetRound,
                    blockNumber,
                    extrinsicIndex
                } = await this.commitCRWeights(uids, normalizedWeights, salt, targetRound);

                logger.debug('Weights committed successfully (CRv3).');
                logger.debug('Commit Details:');
                logger.debug(`  - Transaction Hash: ${txHash}`);
                logger.debug(`  - Target Drand Round: ${actualTargetRound}`);
                logger.debug(`  - Encrypted Data Size: ${encryptedCommit.length} bytes`);

                logger.debug(`The blockchain will automatically decrypt and reveal weights when Drand round ${actualTargetRound} is reached.`);

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
        const account = this.getAccount();
        const subnetId = this.config.subnetConnection.subnetId;

        const encryptedCommit = await this.createTimelockCommit(uids, weights, salt, targetRound);

        const extrinsics = Object.keys(api.tx.subtensorModule);
        logger.debug(`Available extrinsics: ${extrinsics.filter((e) => e.toLowerCase().includes('commit')).join(', ')}`);

        let commitTx;

        if (api.tx.subtensorModule.commitCrv3Weights) {
            logger.debug('Using: commitCrv3Weights (CRv3)');
            commitTx = api.tx.subtensorModule.commitCrv3Weights(subnetId, Array.from(encryptedCommit), targetRound);
        } else if (api.tx.subtensorModule.commitTimelockedWeights) {
            logger.debug('Using: commitTimelockedWeights (CRv4)');
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

        logger.debug('Creating Drand timelock encrypted commit ...');

        const data = Buffer.concat([
            Buffer.from(new Uint16Array(uids).buffer),
            Buffer.from(new Uint16Array(weights).buffer),
            salt,
            Buffer.from(new Uint32Array([versionKey]).buffer) //
        ]);

        const client = this.getDrandClient();

        const cipherText = await timelockEncrypt(targetRound, data, client);

        logger.debug('Timelock encryption complete');

        return cipherText;
    }

    private async setWeightsStandard(uids: any[], weights: any[]): Promise<string> {
        const api = await this.getApi();
        const account = this.getAccount();
        const subnetId = this.config.subnetConnection.subnetId;
        const versionKey = 0;

        const setWeightsTx = api.tx.subtensorModule.setWeights(subnetId, uids, weights, versionKey);

        logger.debug('Submitting standard set_weights transaction ...');

        return new Promise((resolve, reject) => {
            setWeightsTx
                .signAndSend(account, (result: { status?: any; events?: any; dispatchError?: any }) => {
                    const { status, events, dispatchError } = result;
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

        logger.debug(`Drand Genesis Time: ${new Date(chainInfo.genesis_time * 1000).toISOString()}`);
        logger.debug(`Drand Period: ${chainInfo.period} seconds`);

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
        if (this.subnetInfo) {
            return this.subnetInfo;
        }

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

        this.subnetInfo = subnetInfo;

        return this.subnetInfo;
    }

    private getAccount(): KeyringPair {
        if (this.account) {
            return this.account;
        }

        const keyring = new Keyring({ type: 'sr25519' });
        const account = keyring.addFromUri(this.config.subnetConnection.secretPhrase);

        if (account.address !== this.config.subnetConnection.ss58Address) {
            throw new Error('Private key does not match the provided SS58 address');
        }

        logger.debug(`Using account: ${account.address}`);

        this.account = account;

        return this.account;
    }

    private normalizeWeights(weights: number[]): number[] {
        const maxWeight = 1;
        const totalWeight = weights.reduce((sum, w) => sum + w, 0);
        const normalizedWeights = weights.map((weight) => Math.floor((weight / totalWeight) * maxWeight));

        logger.debug('Weight Normalization:');
        logger.debug(`  - Original: [${weights.join(', ')}]`);
        logger.debug(`  - Normalized: [${normalizedWeights.join(', ')}]`);

        return normalizedWeights;
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

            logger.debug('Current State:');
            logger.debug(`  - Current Block: ${currentBlock}`);
            logger.debug(`  - Last Commit Block: ${this.lastCommitBlock || 'None'}`);
            logger.debug(`  - Blocks Since Last Commit: ${this.lastCommitBlock ? currentBlock - this.lastCommitBlock : 'N/A'}`);

            logger.debug('Subnet Configuration:');
            logger.debug(`  - Tempo: ${scheduleParams.tempo} blocks (~${Math.floor((scheduleParams.tempo * 12) / 60)} min)`);
            logger.debug(
                `  - Weights Rate Limit: ${scheduleParams.weightsRateLimit} blocks (~${Math.floor((scheduleParams.weightsRateLimit * 12) / 60)} min)`
            );
            logger.debug(
                `  - Activity Cutoff: ${scheduleParams.activityCutoff} blocks (~${Math.floor((scheduleParams.activityCutoff * 12) / 60)} min)`
            );
            logger.debug(`  - Commit-Reveal: ${scheduleParams.commitRevealEnabled ? 'Enabled' : 'Disabled'}`);

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
            secretPhrase: config.validatorMnemonic
        },
        drand: config.drandConfig
    };

    const subnetWeights = new SubnetWeights(subnetWeightsConfig);

    const run = async () => {
        try {
            const targets = await fetchTargets();
            if (targets.length === 0) {
                logger.debug('no bittensor weights available to submit');
                return;
            }

            const uids = targets.map((w) => w.uid);
            const weights = targets.map((w) => w.weight);

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
