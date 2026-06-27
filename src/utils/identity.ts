import { KeyringPair } from '@polkadot/keyring/types';
import { u8aToHex } from '@polkadot/util';

import { initWalletFromMnemonic, initWalletFromSecretSeed } from '../polkadot/wallet';
import { logError, logInfo, logWarning } from './logging';

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

export interface ValidatorCredentials {
    readonly mnemonic?: string;
    readonly secretSeed?: string;
}

export const loadIdentity = async (credentials: ValidatorCredentials, options: LoadIdentityOptions = {}): Promise<ValidatorIdentity | null> => {
    const mnemonic = credentials.mnemonic?.trim() ?? '';
    const secretSeed = credentials.secretSeed?.trim() ?? '';

    if (!mnemonic && !secretSeed) {
        logWarning('Validator mnemonic or secret seed not provided');
        return null;
    }

    try {
        const pair = mnemonic
            ? await initWalletFromMnemonic(mnemonic, {
                  ss58Format: options.ss58Format,
                  name: options.walletName
              })
            : await initWalletFromSecretSeed(secretSeed, {
                  ss58Format: options.ss58Format,
                  name: options.walletName
              });

        const identity: ValidatorIdentity = {
            address: pair.address,
            publicKey: u8aToHex(pair.publicKey),
            pair,
            sign: async (payload: Uint8Array) => pair.sign(payload)
        };

        logInfo('Validator identity loaded', {
            address: identity.address,
            publicKey: identity.publicKey,
            identity: pair.meta?.name ?? 'validator'
        });

        return identity;
    } catch (err) {
        logError('Failed to initialize validator identity', { err });
        return null;
    }
};
