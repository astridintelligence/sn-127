import { KeyringPair } from '@polkadot/keyring/types';
import { u8aToHex } from '@polkadot/util';

import logger from '../config/logger';
import { initWalletFromMnemonic } from '../polkadot/wallet';

export interface ValidatorIdentity {
    readonly address: string;
    readonly publicKey: string;
    readonly pair: KeyringPair;
    readonly sign: (payload: Uint8Array) => Promise<Uint8Array>;
}

export interface LoadIdentityOptions {
    readonly ss58Format?: number;
    readonly walletName?: string;
}

export const loadIdentity = async (mnemonic: string, options: LoadIdentityOptions = {}): Promise<ValidatorIdentity | null> => {
    if (!mnemonic) {
        logger.warn('validator mnemonic not provided');
        return null;
    }

    try {
        const pair = await initWalletFromMnemonic(mnemonic, {
            ss58Format: options.ss58Format,
            name: options.walletName
        });

        const identity: ValidatorIdentity = {
            address: pair.address,
            publicKey: u8aToHex(pair.publicKey),
            pair,
            sign: async (payload: Uint8Array) => pair.sign(payload)
        };

        logger.info(
            {
                address: identity.address,
                publicKey: identity.publicKey,
                identity: pair.meta?.name ?? 'validator'
            },
            'validator identity loaded'
        );

        return identity;
    } catch (err) {
        logger.error({ err }, 'failed to initialize validator identity');
        return null;
    }
};
