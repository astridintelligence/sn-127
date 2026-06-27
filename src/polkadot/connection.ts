import { ApiPromise, WsProvider } from '@polkadot/api';

import { logError, logInfo, logWarning } from '../utils/logging';

let apiInstance: ApiPromise | null = null;
let connectingPromise: Promise<ApiPromise> | null = null;
let currentEndpoint: string | null = null;

const createProvider = (endpoint: string): WsProvider => {
    const provider = new WsProvider(endpoint);

    provider.on('error', (err) => {
        logError('Polkadot provider error', { err });
    });

    provider.on('disconnected', () => {
        logWarning('Polkadot provider disconnected', { endpoint });
    });

    provider.on('connected', () => {
        logInfo('Polkadot provider connected', { endpoint });
    });

    return provider;
};

export const connectPolkadot = async (endpoint: string): Promise<ApiPromise> => {
    if (apiInstance && apiInstance.isConnected && currentEndpoint === endpoint) {
        return apiInstance;
    }

    if (connectingPromise) {
        return connectingPromise;
    }

    const provider = createProvider(endpoint);

    connectingPromise = ApiPromise.create({
        provider,
        noInitWarn: true
    })
        .then((api) => {
            currentEndpoint = endpoint;
            apiInstance = api;

            api.on('error', (err) => {
                logError('Polkadot API error', { err });
            });

            api.on('disconnected', () => {
                logWarning('Polkadot API disconnected', { endpoint });

                apiInstance = null;
                connectingPromise = null;
            });

            logInfo('Connected to Polkadot API', { endpoint });

            return api;
        })
        .catch((err) => {
            logError('Failed to connect to Polkadot API', { err });

            connectingPromise = null;
            throw err;
        });

    return connectingPromise;
};

export const disconnectPolkadot = async (): Promise<void> => {
    if (!apiInstance) {
        return;
    }

    try {
        await apiInstance.disconnect();
        logInfo('Polkadot API disconnected', { endpoint: currentEndpoint });
    } catch (err) {
        logError('Error disconnecting Polkadot API', { err });
    } finally {
        apiInstance = null;
        connectingPromise = null;
        currentEndpoint = null;
    }
};
