import axios from 'axios';

import config from '../config/env';
import logger from '../config/logger';
import type { ValidatorIdentity } from '../utils/identity';
import { signHeartbeat } from '../utils/signing';
import type { CapacitySnapshot } from './monitoring';
import { getCapacitySnapshot } from './monitoring';
import { registerValidator } from './validator-service';
import { getValidatorId, setValidatorId } from './validator-state';

interface HeartbeatPayload {
    validatorId: string;
    version: string;
    capacity: CapacitySnapshot;
    uptime: number;
    timestamp: number;
    signature: string;
}

const appVersion = process.env.APP_VERSION ?? '0.0.0';
const processStart = Date.now();

export const startHeartbeatLoop = async (identity: ValidatorIdentity) => {
    const sendHeartbeat = async (retrying = false) => {
        let validatorId: string;
        try {
            validatorId = getValidatorId();
        } catch (err) {
            logger.warn({ err }, 'validatorId unavailable before heartbeat; attempting registration');

            try {
                const registeredId = await registerValidator(identity);
                setValidatorId(registeredId);
                validatorId = registeredId;
            } catch (registerErr) {
                logger.error({ err: registerErr }, 'validator registration failed');
                return;
            }
        }

        const payload: Omit<HeartbeatPayload, 'signature'> = {
            validatorId,
            version: appVersion,
            capacity: getCapacitySnapshot(),
            uptime: Math.floor((Date.now() - processStart) / 1000),
            timestamp: Math.floor(Date.now() / 1000)
        };

        const signature = await signHeartbeat(payload, identity);
        const heartbeat: HeartbeatPayload = { ...payload, signature };

        try {
            await axios.post(`${config.apiUrl}/validators/heartbeat`, heartbeat, {
                timeout: 5_000
            });

            logger.debug({ validatorId: heartbeat.validatorId }, 'heartbeat sent');
        } catch (err) {
            if (axios.isAxiosError(err) && err.response?.status === 403 && !retrying) {
                logger.warn({ status: err.response.status }, 'heartbeat rejected with 403; attempting validator registration');

                try {
                    const registeredId = await registerValidator(identity);
                    setValidatorId(registeredId);

                    await sendHeartbeat(true);

                    return;
                } catch (registerErr) {
                    logger.error({ err: registerErr }, 're-registration failed after heartbeat rejection');
                }
            }

            logger.error({ err }, 'failed to send heartbeat');
        }
    };

    await sendHeartbeat();

    return setInterval(sendHeartbeat, config.heartbeatIntervalMs);
};
