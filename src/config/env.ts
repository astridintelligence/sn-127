import dotenv from 'dotenv';

dotenv.config();

const defaultArenaApiUrl = 'https://arena-api.astrid.global';

export interface BittensorWeightTarget {
    readonly uid: number;
    readonly weight: number;
}

export interface SlackConfig {
    readonly apiToken: string | null;
    readonly defaultChannel: string | null;
    readonly errorChannel: string | null;
    readonly infoChannel: string | null;
    readonly rateLimitMax: number;
    readonly rateLimitWindowMs: number;
}

export interface BittensorConfig {
    readonly enabled: boolean;
    readonly wsEndpoint: string;
    readonly netuid: number;
    readonly weightIntervalMs: number;
}

export interface ValidatorConfig {
    readonly arenaApiUrl: string;

    readonly validatorMnemonic: string;
    readonly validatorSecretSeed: string;
    readonly validatorSs58Address: string;
    readonly validatorSs58Format: number;

    readonly bittensor: BittensorConfig;

    readonly slackConfig: SlackConfig;
    readonly logLevel: string;
    readonly isProduction: boolean;
}

const int = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
    if (value === undefined) {
        return fallback;
    }
    const normalized = value.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
};

const config: ValidatorConfig = {
    arenaApiUrl: process.env.ARENA_API_URL ?? defaultArenaApiUrl,

    validatorMnemonic: process.env.VALIDATOR_MNEMONIC ?? '',
    validatorSecretSeed: process.env.VALIDATOR_SECRET_SEED ?? '',
    validatorSs58Address: process.env.VALIDATOR_SS58_ADDRESS ?? '',
    validatorSs58Format: int(process.env.VALIDATOR_SS58_FORMAT, 42),

    bittensor: {
        enabled: bool(process.env.BITTENSOR_ENABLED, true),
        wsEndpoint: process.env.BITTENSOR_WS_ENDPOINT ?? 'wss://entrypoint-finney.opentensor.ai:443',
        netuid: 127,
        weightIntervalMs: int(process.env.BITTENSOR_WEIGHT_INTERVAL_MS, 3600000)
    },

    slackConfig: {
        apiToken: process.env.SLACK_API_TOKEN ?? null,
        defaultChannel: process.env.SLACK_CHANNEL ?? null,
        errorChannel: process.env.SLACK_ERROR_CHANNEL ?? null,
        infoChannel: process.env.SLACK_INFO_CHANNEL ?? null,
        rateLimitMax: int(process.env.SLACK_RATE_LIMIT_MAX, 3),
        rateLimitWindowMs: int(process.env.SLACK_RATE_LIMIT_WINDOW_MS, 300_000)
    },
    logLevel: process.env.LOG_LEVEL ?? 'info',
    isProduction: process.env.NODE_ENV === 'production'
};

export default config;
