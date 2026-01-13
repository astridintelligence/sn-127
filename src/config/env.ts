import dotenv from 'dotenv';

dotenv.config();

export interface BittensorWeightTarget {
    readonly uid: number;
    readonly weight: number;
}

export interface BittensorConfig {
    readonly enabled: boolean;
    readonly wsEndpoint: string;
    readonly netuid: number;
    readonly versionKey: number;
    readonly weightIntervalMs: number;
    readonly weightsUrl: string | null;
    readonly staticWeights: readonly BittensorWeightTarget[];
}

export interface ValidatorConfig {
    readonly apiUrl: string;
    readonly redisUrl: string;
    readonly validatorMnemonic: string;
    readonly validatorSs58Format: number;
    readonly heartbeatIntervalMs: number;
    readonly maxConcurrentTasks: number;
    readonly dockerSocketPath: string;
    readonly adminPort: number;
    readonly bittensor: BittensorConfig;
    readonly displayName: string;
    readonly iconUrl: string;

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

const parseWeightTargets = (raw: string | undefined): readonly BittensorWeightTarget[] => {
    if (!raw) {
        return [];
    }

    return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
            const [uidRaw, weightRaw] = entry.split(':').map((part) => part.trim());
            const uid = Number(uidRaw);
            const weight = Number(weightRaw);

            if (!Number.isInteger(uid) || uid < 0) {
                return null;
            }

            if (!Number.isFinite(weight) || weight < 0) {
                return null;
            }

            return { uid, weight };
        })
        .filter((target): target is BittensorWeightTarget => target !== null);
};

const configuredWeights = parseWeightTargets(process.env.BITTENSOR_WEIGHT_TARGETS);
const configuredWeightsUrl = process.env.BITTENSOR_WEIGHTS_URL ?? '';
const configuredEndpoint = process.env.BITTENSOR_WS_ENDPOINT ?? 'wss://entrypoint.finney.opentensor.ai:443';

const config: ValidatorConfig = {
    apiUrl: process.env.API_URL ?? 'http://localhost:3000/v1',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    validatorMnemonic: process.env.VALIDATOR_MNEMONIC ?? '',
    validatorSs58Format: int(process.env.VALIDATOR_SS58_FORMAT, 42),
    heartbeatIntervalMs: int(process.env.HEARTBEAT_INTERVAL_MS, 15000),
    maxConcurrentTasks: int(process.env.MAX_CONCURRENT_TASKS, 2),
    dockerSocketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    adminPort: int(process.env.PORT, 5000),
    bittensor: {
        enabled: bool(process.env.BITTENSOR_ENABLED, true),
        wsEndpoint: configuredEndpoint,
        netuid: int(process.env.BITTENSOR_NETUID, 1),
        versionKey: Number(process.env.BITTENSOR_VERSION_KEY ?? 0),
        weightIntervalMs: int(process.env.BITTENSOR_WEIGHT_INTERVAL_MS, 60000),
        weightsUrl: configuredWeightsUrl.length > 0 ? configuredWeightsUrl : null,
        staticWeights: configuredWeights
    },
    displayName: process.env.VALIDATOR_DISPLAY_NAME ?? 'Unset',
    iconUrl: process.env.VALIDATOR_ICON_URL ?? '',

    logLevel: process.env.LOG_LEVEL ?? 'info',
    isProduction: process.env.NODE_ENV === 'production'
};

export default config;
