import {
    SIGNATURE_LENGTH_IN_BYTES,
    Transaction as LegacyTransaction,
    Transaction,
    TransactionSignature,
    VersionedMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import {
    AuthorizeAPI,
    Base64EncodedAddress,
    Base64EncodedTransaction,
    CloneAuthorizationAPI,
    DeauthorizeAPI,
    GetCapabilitiesAPI,
    MobileWallet,
    ReauthorizeAPI,
    TerminateSessionAPI,
    transact as baseTransact,
    startRemoteScenario as baseStartRemoteScenario,
    WalletAssociationConfig,
    RemoteWalletAssociationConfig,
} from '@solana-mobile/mobile-wallet-adapter-protocol';
import bs58 from 'bs58';

import { fromUint8Array, toUint8Array } from './base64Utils.js';

interface Web3SignAndSendTransactionsAPI {
    signAndSendTransactions<T extends LegacyTransaction | VersionedTransaction>(params: {
        minContextSlot?: number;
        commitment?: string;
        skipPreflight?: boolean;
        maxRetries?: number;
        waitForCommitmentToSendNextTransaction?: boolean;
        transactions: T[];
    }): Promise<TransactionSignature[]>;
}

interface Web3SignTransactionsAPI {
    signTransactions<T extends LegacyTransaction | VersionedTransaction>(params: { transactions: T[] }): Promise<T[]>;
}

interface Web3SignMessagesAPI {
    signMessages(params: { addresses: Base64EncodedAddress[]; payloads: Uint8Array[] }): Promise<Uint8Array[]>;
}

export interface Web3MobileWallet
    extends AuthorizeAPI,
        CloneAuthorizationAPI,
        DeauthorizeAPI,
        GetCapabilitiesAPI,
        ReauthorizeAPI,
        Web3SignAndSendTransactionsAPI,
        Web3SignTransactionsAPI,
        Web3SignMessagesAPI {}

export interface Web3RemoteMobileWallet
    extends Web3MobileWallet, TerminateSessionAPI {}

export type Web3Scenario = Readonly<{
    wallet: Promise<Web3MobileWallet>;
    close: () => void;
}>;

export type Web3RemoteScenario = Web3Scenario & Readonly<{
    associationUrl: URL;
}>;

function getPayloadFromTransaction(transaction: LegacyTransaction | VersionedTransaction): Base64EncodedTransaction {
    const serializedTransaction =
        'version' in transaction
            ? transaction.serialize()
            : transaction.serialize({
                  requireAllSignatures: false,
                  verifySignatures: false,
              });
    const payload = fromUint8Array(serializedTransaction);
    return payload;
}

function getTransactionFromWireMessage(byteArray: Uint8Array): Transaction | VersionedTransaction {
    const numSignatures = byteArray[0];
    const messageOffset = numSignatures * SIGNATURE_LENGTH_IN_BYTES + 1;
    const version = VersionedMessage.deserializeMessageVersion(byteArray.slice(messageOffset, byteArray.length));
    if (version === 'legacy') {
        return Transaction.from(byteArray);
    } else {
        return VersionedTransaction.deserialize(byteArray);
    }
}

export async function transact<TReturn>(
    callback: (wallet: Web3MobileWallet) => TReturn,
    config?: WalletAssociationConfig,
): Promise<TReturn> {
    const augmentedCallback: (wallet: MobileWallet) => TReturn = (wallet) => {
        return callback(augmentWalletAPI(wallet));
    };
    return await baseTransact(augmentedCallback, config);
}

export async function startRemoteScenario(
    config: RemoteWalletAssociationConfig,
): Promise<Web3RemoteScenario> {
    const { wallet, close, associationUrl } = await baseStartRemoteScenario(config);
    const augmentedPromise = wallet.then((wallet) => {
        return augmentWalletAPI(wallet); 
    });
    return { wallet: augmentedPromise, close, associationUrl };
}

function augmentWalletAPI(wallet: MobileWallet): Web3MobileWallet {
    return new Proxy<Web3MobileWallet>({} as Web3MobileWallet, {
        get<TMethodName extends keyof Web3MobileWallet>(target: Web3MobileWallet, p: TMethodName) {
            if (target[p] == null) {
                switch (p) {
                    case 'signAndSendTransactions':
                        target[p] = async function ({
                            minContextSlot,
                            commitment,
                            skipPreflight,
                            maxRetries,
                            waitForCommitmentToSendNextTransaction,
                            transactions,
                            ...rest
                        }: Parameters<Web3MobileWallet['signAndSendTransactions']>[0]) {
                            const payloads = transactions.map(getPayloadFromTransaction);
                            const options = {
                                min_context_slot: minContextSlot,
                                commitment: commitment,
                                skip_preflight: skipPreflight,
                                max_retries: maxRetries,
                                wait_for_commitment_to_send_next_transaction: waitForCommitmentToSendNextTransaction
                            };
                            const { signatures: base64EncodedSignatures } = await wallet.signAndSendTransactions({
                                ...rest,
                                ...(Object.values(options).some(element => element != null) 
                                    ? { options: options } 
                                    : null),
                                payloads,
                            });
                            const signatures = base64EncodedSignatures.map(toUint8Array).map(bs58.encode);
                            return signatures as TransactionSignature[];
                        } as Web3MobileWallet[TMethodName];
                        break;
                    case 'signMessages':
                        target[p] = async function ({
                            payloads,
                            ...rest
                        }: Parameters<Web3MobileWallet['signMessages']>[0]) {
                            const base64EncodedPayloads = payloads.map(fromUint8Array);
                            const { signed_payloads: base64EncodedSignedMessages } = await wallet.signMessages({
                                ...rest,
                                payloads: base64EncodedPayloads,
                            });
                            const signedMessages = base64EncodedSignedMessages.map(toUint8Array);
                            return signedMessages;
                        } as Web3MobileWallet[TMethodName];
                        break;
                    case 'signTransactions':
                        target[p] = async function ({
                            transactions,
                            ...rest
                        }: Parameters<Web3MobileWallet['signTransactions']>[0]) {
                            const payloads = transactions.map(getPayloadFromTransaction);
                            const { signed_payloads: base64EncodedCompiledTransactions } =
                                await wallet.signTransactions({
                                    ...rest,
                                    payloads,
                                });
                            const compiledTransactions = base64EncodedCompiledTransactions.map(toUint8Array);
                            const signedTransactions = compiledTransactions.map(getTransactionFromWireMessage);
                            return signedTransactions;
                        } as Web3MobileWallet[TMethodName];
                        break;
                    default: {
                        target[p] = wallet[p] as unknown as Web3MobileWallet[TMethodName];
                        break;
                    }
                }
            }
            return target[p];
        },
        defineProperty() {
            return false;
        },
        deleteProperty() {
            return false;
        },
    });
}