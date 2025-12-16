import { ApiPromise, WsProvider } from '@polkadot/api';

import logger from '../config/logger';

let apiInstance: ApiPromise | null = null;
let connectingPromise: Promise<ApiPromise> | null = null;
let currentEndpoint: string | null = null;

const createProvider = (endpoint: string): WsProvider => {
    const provider = new WsProvider(endpoint);

    provider.on('error', (err) => {
        logger.error({ err }, 'polkadot provider error');
    });

    provider.on('disconnected', () => {
        logger.warn({ endpoint }, 'polkadot provider disconnected');
    });

    provider.on('connected', () => {
        logger.info({ endpoint }, 'polkadot provider connected');
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
                logger.error({ err }, 'polkadot api error');
            });

            api.on('disconnected', () => {
                logger.warn({ endpoint }, 'polkadot api disconnected');
                apiInstance = null;
                connectingPromise = null;
            });

            logger.info({ endpoint }, 'connected to polkadot api');

            return api;
        })
        .catch((err) => {
            logger.error({ err }, 'failed to connect to polkadot api');

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
        logger.info({ endpoint: currentEndpoint }, 'polkadot api disconnected');
    } catch (err) {
        logger.error({ err }, 'error disconnecting polkadot api');
    } finally {
        apiInstance = null;
        connectingPromise = null;
        currentEndpoint = null;
    }
};
