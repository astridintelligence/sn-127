import axios from 'axios';

import config from '../config/env';
import logger from '../config/logger';
import type { ValidatorIdentity } from '../utils/identity';

export const registerValidator = async (identity: ValidatorIdentity): Promise<string> => {
    try {
        const payload = {
            hotkey: identity.address,
            ...(config.displayName ? { displayName: config.displayName } : {}),
            ...(config.iconUrl ? { icon: config.iconUrl } : {})
        };

        const { data } = await axios.post(`${config.apiUrl}/validators/register`, payload, { timeout: 5_000 });

        const validatorId: unknown = data?.validatorId;
        if (typeof validatorId !== 'string' || validatorId.trim().length === 0) {
            throw new Error('registration response missing validatorId');
        }

        logger.info({ validatorId }, 'validator registered with coordinator');

        return validatorId;
    } catch (err) {
        logger.error({ err }, 'failed to register validator');
        throw err;
    }
};
