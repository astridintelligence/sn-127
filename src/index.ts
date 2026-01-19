import { startAdminServer } from './admin/server';
import config from './config/env';
import logger from './config/logger';
import { startHeartbeatLoop } from './core/heartbeat';
import { startMonitoringService, stopMonitoringService } from './core/monitoring';
import { startSetWeightsService } from './core/submit_weights';
import { startTaskPoller } from './core/task-poller';
import { registerValidator } from './core/validator-service';
import { setValidatorId } from './core/validator-state';
import { disconnectPolkadot } from './polkadot/connection';
import { loadIdentity } from './utils/identity';

const bootstrap = async () => {
    logger.info('Starting validator daemon');

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

    const validatorId = await registerValidator(identity);
    setValidatorId(validatorId);

    startMonitoringService();

    const heartbeatTimer = await startHeartbeatLoop(identity);
    const weightTimer = await startSetWeightsService();
    const taskPoller = startTaskPoller();
    const adminServer = startAdminServer();

    process.on('SIGTERM', async () => {
        logger.info('received SIGTERM, shutting down services');

        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
        }

        if (weightTimer) {
            clearInterval(weightTimer);
        }

        stopMonitoringService();

        await taskPoller.stop();
        await new Promise<void>((resolve) => {
            adminServer.close(() => resolve());
        });

        await disconnectPolkadot();

        process.exit(0);
    });
};

bootstrap().catch((err) => {
    logger.error({ err }, 'validator failed to start');
    process.exit(1);
});
