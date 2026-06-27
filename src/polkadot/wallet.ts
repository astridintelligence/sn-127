import { Keyring } from '@polkadot/api';
import { KeyringPair } from '@polkadot/keyring/types';
import { hexToU8a, isHex } from '@polkadot/util';
import { cryptoWaitReady, mnemonicValidate } from '@polkadot/util-crypto';
import { getPublicKey } from '@scure/sr25519';

import { logDebug } from '../utils/logging';

export interface WalletOptions {
    readonly ss58Format?: number;
    readonly name?: string;
}

const DEFAULT_SS58_FORMAT = 42;
const DEFAULT_WALLET_NAME = 'validator-hotkey';

export const initWalletFromMnemonic = async (mnemonic: string, options: WalletOptions = {}): Promise<KeyringPair> => {
    const trimmedMnemonic = mnemonic.trim();
    if (!mnemonicValidate(trimmedMnemonic)) {
        throw new Error('Invalid validator mnemonic provided');
    }

    const ready = await cryptoWaitReady();
    if (!ready) {
        throw new Error('Failed to initialize crypto libraries for Polkadot');
    }

    const keyring = new Keyring({
        type: 'sr25519',
        ss58Format: options.ss58Format ?? DEFAULT_SS58_FORMAT
    });

    const pair = keyring.addFromMnemonic(trimmedMnemonic, {
        name: options.name ?? DEFAULT_WALLET_NAME
    });

    logDebug('Initialized Polkadot wallet', { ss58Format: options.ss58Format, type: keyring.type });

    return pair;
};

export const initWalletFromSecretSeed = async (secretSeed: string, options: WalletOptions = {}): Promise<KeyringPair> => {
    const trimmedSecretSeed = secretSeed.trim();
    if (!trimmedSecretSeed || !isHex(trimmedSecretSeed)) {
        throw new Error('Invalid validator secret seed provided');
    }

    const keyBytes = hexToU8a(trimmedSecretSeed);
    const ready = await cryptoWaitReady();
    if (!ready) {
        throw new Error('Failed to initialize crypto libraries for Polkadot');
    }

    const keyring = new Keyring({
        type: 'sr25519',
        ss58Format: options.ss58Format ?? DEFAULT_SS58_FORMAT
    });

    let pair: KeyringPair;
    if (keyBytes.length === 32) {
        pair = keyring.addFromSeed(keyBytes, {
            name: options.name ?? DEFAULT_WALLET_NAME
        });
    } else if (keyBytes.length === 64) {
        const publicKey = getPublicKey(keyBytes);
        pair = keyring.addFromPair(
            {
                publicKey,
                secretKey: keyBytes
            },
            { name: options.name ?? DEFAULT_WALLET_NAME }
        );
    } else if (keyBytes.length === 96) {
        pair = keyring.addFromPair(
            {
                publicKey: keyBytes.slice(64, 96),
                secretKey: keyBytes.slice(0, 64)
            },
            { name: options.name ?? DEFAULT_WALLET_NAME }
        );
    } else {
        throw new Error(`Invalid validator secret seed length: ${keyBytes.length} bytes`);
    }

    logDebug('Initialized Polkadot wallet', { ss58Format: options.ss58Format, type: keyring.type });

    return pair;
};
