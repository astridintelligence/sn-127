import { Keyring } from '@polkadot/api';
import { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady, mnemonicValidate } from '@polkadot/util-crypto';

import logger from '../config/logger';

export interface WalletOptions {
    readonly ss58Format?: number;
    readonly name?: string;
}

const DEFAULT_SS58_FORMAT = 42;
const DEFAULT_WALLET_NAME = 'validator-hotkey';

export const initWalletFromMnemonic = async (mnemonic: string, options: WalletOptions = {}): Promise<KeyringPair> => {
    const trimmedMnemonic = mnemonic.trim();
    if (!mnemonicValidate(trimmedMnemonic)) {
        throw new Error('invalid validator mnemonic provided');
    }

    const ready = await cryptoWaitReady();
    if (!ready) {
        throw new Error('failed to initialize crypto libraries for polkadot');
    }

    const keyring = new Keyring({
        type: 'sr25519',
        ss58Format: options.ss58Format ?? DEFAULT_SS58_FORMAT
    });

    const pair = keyring.addFromMnemonic(trimmedMnemonic, {
        name: options.name ?? DEFAULT_WALLET_NAME
    });

    logger.debug(
        {
            ss58Format: options.ss58Format,
            type: keyring.type
        },
        'initialized polkadot wallet'
    );

    return pair;
};
