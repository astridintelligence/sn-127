import config from './config/env';
import { startSetWeightsService } from './core/submit_weights';
import { disconnectPolkadot } from './polkadot/connection';
import { loadIdentity } from './utils/identity';
import { logError, logInfo } from './utils/logging';

const bootstrap = async () => {
    logInfo('Starting validator daemon');

    const identity = await loadIdentity(
        {
            mnemonic: config.validatorMnemonic,
            secretSeed: config.validatorSecretSeed
        },
        {
            ss58Format: config.validatorSs58Format,
            walletName: 'validator-hotkey'
        }
    );

    if (!identity) {
        throw new Error('Failed to load validator identity');
    }

    const weightTimer = await startSetWeightsService();

    process.on('SIGTERM', async () => {
        logInfo('Received SIGTERM, shutting down services');

        if (weightTimer) {
            clearInterval(weightTimer);
        }

        await disconnectPolkadot();

        process.exit(0);
    });
};

bootstrap().catch((err) => {
    logError('Validator failed to start', { err });
    process.exit(1);
});
