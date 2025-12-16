import { ValidatorIdentity } from './identity';

export const signHeartbeat = async (payload: Record<string, unknown>, identity: ValidatorIdentity): Promise<string> => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const signature = await identity.sign(bytes);

    return Buffer.from(signature).toString('hex');
};
