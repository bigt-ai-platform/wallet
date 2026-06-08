import { OrderdataResponse } from '../response/OrderdataResponse';
import { MarketOrderItemImpl } from '../ordermatch/MarketOrderItem';
import { NetworkParameters } from '../params/NetworkParameters';
import { ECKey } from '../core/ECKey';
import { TokenType } from '../core/TokenType';
import { UTXO } from '../core/UTXO';
import { Token } from '../core/Token';
import { GetBalancesResponse } from '../response/GetBalancesResponse';
import { SignedDataWithTokenImpl } from '../core/SignedDataWithToken';
import { SignedDataClass } from '../apps/data/SignedData';
import { KeyValue } from '../core/KeyValue';
import { ECIESCoder } from '../crypto/ECIESCoder';
import { OkHttp3Util } from '../utils/OkHttp3Util';
import { ReqCmd } from '../params/ReqCmd';
import { Utils } from '../utils/Utils';
import { OrderTickerResponse } from '../response/OrderTickerResponse';
import { MatchLastdayResult } from '../ordermatch/MatchLastdayResult';
import { Sha256Hash } from '../core/Sha256Hash';
import { Wallet } from '../wallet/Wallet';
import { Json } from '../utils/Json';
import { OrderCancelInfo } from '../core/OrderCancelInfo';
import { Transaction } from '../core/Transaction';
import { Block } from '../core/Block';
import { BlockType } from '../core/BlockType';
import { Coin } from '../core/Coin';
import { CoinConstants } from '../core/CoinConstants';
import { FreeStandingTransactionOutput } from '../wallet/FreeStandingTransactionOutput';

export class WalletUtil {
    public static orderMap(
        orderdataResponse: OrderdataResponse,
        orderData: MarketOrderItemImpl[],
        params: NetworkParameters,
        buy: string,
        sell: string
    ): void {
        const allOrders = orderdataResponse.getAllOrdersSorted();
        if (allOrders) {
            for (const orderRecord of allOrders) {
                const marketOrderItem = MarketOrderItemImpl.build(
                    orderRecord,
                    orderdataResponse.getTokennames(),
                    params,
                    buy,
                    sell
                );
                orderData.push(marketOrderItem);
            }
        }
    }

    public static resetOrderList(orderList: MarketOrderItemImpl[]): MarketOrderItemImpl[] {
        const list: MarketOrderItemImpl[] = [];

        const orderMap = new Map<string, Map<string, MarketOrderItemImpl[]>>();

        for (const map of orderList) {
            const tokenname = map.tokenName;
            const type = map.type;

            if (!orderMap.has(tokenname)) {
                orderMap.set(tokenname, new Map<string, MarketOrderItemImpl[]>());
            }
            const subMap = orderMap.get(tokenname)!;

            if (!subMap.has(type)) {
                subMap.set(type, []);
            }
            subMap.get(type)!.push(map);
        }

        for (const [tokenname, subMap] of orderMap.entries()) {
            const buys = subMap.get("buy") || [];
            if (buys.length > 0) {
                buys.sort((order1, order2) => {
                    // Compare prices in descending order (highest first)
                    const price1 = order1.price ?? 0;
                    const price2 = order2.price ?? 0;
                    return price2 - price1;
                });
            }

            const sells = subMap.get("sell") || [];
            if (sells.length > 0) {
                sells.sort((order1, order2) => {
                    // Compare prices in ascending order (lowest first)
                    const price1 = order1.price ?? 0;
                    const price2 = order2.price ?? 0;
                    return price1 - price2;
                });
            }

            if ("BIG" === tokenname) {
                if (buys.length > 0) {
                    list.push(...buys);
                    if (sells.length > 0) {
                        list.push(...sells);
                    }
                } else {
                    if (sells.length > 0) {
                        list.push(...sells);
                    }
                }
            } else {
                if (buys.length > 0) {
                    list.push(...buys);
                    if (sells.length > 0) {
                        list.push(...sells);
                    }
                } else {
                    if (sells.length > 0) {
                        list.push(...sells);
                    }
                }
            }
        }
        return list;
    }

    /*
     * return all decrypted SignedData list of the given keys and token type
     */
    public static async signedTokenList(
        userKeys: ECKey[],
        tokenType: TokenType,
        serverurl: string
    ): Promise<SignedDataWithTokenImpl[]> {
        const signedTokenList: SignedDataWithTokenImpl[] = [];
        const keys: string[] = [];

        for (const k of userKeys) {
            keys.push(Utils.HEX.encode(k.getPubKeyHash()));
        }

        const response = await OkHttp3Util.post(
            serverurl + ReqCmd.getBalances,
            new TextEncoder().encode(JSON.stringify(keys))
        );

        // Parse the response using Jackson ObjectMapper or standard JSON parsing
        // Since GetBalancesResponse has Jackson decorators, we might need to handle it properly
        const responseJson = JSON.parse(response);
        // Create a new GetBalancesResponse instance and populate it from the JSON
        const balancesResponse = new GetBalancesResponse();
        balancesResponse['outputs'] = responseJson.outputs?.map((utxo: any) => {
            // Create UTXO from JSON data
            return UTXO.fromJSONObject(utxo);
        }) || null;
        balancesResponse['balance'] = responseJson.balance || null;

        // Create the token names map
        const tokenMap = new Map<string, Token>();
        if (responseJson.tokennames) {
            Object.entries(responseJson.tokennames).forEach(([key, value]: [string, any]) => {
                const token = new Token();
                Object.assign(token, value);
                tokenMap.set(key, token);
            });
        }
        balancesResponse['tokennames'] = tokenMap;

        const outputs = balancesResponse.getOutputs();
        if (outputs) {
            for (const utxo of outputs) {
                const tokenMap = balancesResponse.getTokennames();
                if (tokenMap) {
                    const token = tokenMap.get(utxo.getTokenId());
                    // Compare the token type ordinal value (enum index)
                    // In the Java code: tokenType.ordinal() == token.getTokentype()
                    // In TypeScript, TokenType enum values are numeric starting from 0
                    // So tokenType is already the ordinal value
                    if (token && tokenType === token.getTokentype()) {
                        await WalletUtil.signedTokenListAdd(utxo, userKeys, token, signedTokenList);
                    }
                }
            }
        }
        return signedTokenList;
    }

    private static async signedTokenListAdd(
        utxo: UTXO,
        userkeys: ECKey[],
        token: Token,
        signedTokenList: SignedDataWithTokenImpl[]
    ): Promise<void> {
        if (!token || !token.getTokenKeyValues()) {
            return;
        }

        const tokenKeyValues = token.getTokenKeyValues();
        if (tokenKeyValues) {
            const keyValues = tokenKeyValues.getKeyvalues();
            if (keyValues) {
                for (const kvtemp of keyValues) {
                    const signerKey = WalletUtil.getSignedKey(userkeys, kvtemp.getKey());
                    if (signerKey) {
                        const decryptedPayload = await ECIESCoder.decrypt(
                            signerKey.getPrivKeyBytes(),
                            Utils.HEX.decode(kvtemp.getValue())
                        );
                        const signedData = SignedDataClass.parse(decryptedPayload);
                        signedTokenList.push(new SignedDataWithTokenImpl(signedData, token));
                        break; // Exit after first successful decryption
                    }
                }
            }
        }
    }

    private static getSignedKey(userkeys: ECKey[], pubKey: string): ECKey | null {
        for (const userkey of userkeys) {
            if (userkey.getPublicKeyAsHex() === pubKey) {
                return userkey;
            }
        }
        return null;
    }

    /**
     * Search for orders based on address and state
     * @param wallet The wallet instance
     * @param aesKey The encryption key
     * @param address4search The address to search for
     * @param state4search The state to filter by ("publish" for active orders, other values for completed/cancelled)
     * @param isMine Whether to include orders from the user's own keys
     * @param serverUrl The server URL to query
     * @returns List of MarketOrderItemImpl matching the criteria
     */
    public static async searchOrder(
        wallet: Wallet,
        aesKey: any,
        address4search: string | null,
        state4search: string = "publish",
        isMine: boolean = true,
        serverUrl: string
    ): Promise<MarketOrderItemImpl[]> {
        try {
            const orderList: MarketOrderItemImpl[] = [];
            const address: string[] = [];

            if (address4search && address4search.trim() !== "") {
                address.push(address4search);
            }

            const matched = state4search === "publish";
            if (isMine) {
                const walletKeys = await wallet.walletKeys(aesKey);
                for (const ecKey of walletKeys) {
                    address.push(ecKey.toAddress(wallet.params).toString());
                }
            }

            const requestParam: Record<string, any> = {};
            requestParam.spent = matched ? "false" : "true";
            requestParam.addresses = address;

            const response0 = await OkHttp3Util.post(
                serverUrl + ReqCmd.getOrders,
                new TextEncoder().encode(JSON.stringify(requestParam))
            );

            const orderdataResponse: OrderdataResponse = Json.jsonmapper().parse(response0, {
                mainCreator: () => [OrderdataResponse]
            });
            WalletUtil.orderMap(orderdataResponse, orderList, wallet.params, "buy", "sell");

            if (orderList && orderList.length > 0) {
                return WalletUtil.resetOrderList(orderList);
            }
            return orderList;
        } catch (error) {
            console.error("Error in searchOrder:", error);
            throw error;
        }
    }

    /**
     * Search for order tickers based on token ID
     * @param tokenid The token ID to search for
     * @param serverUrl The server URL to query
     * @returns List of order ticker data
     */
    public static async searchOrdersTicker(
        tokenid: string,
        serverUrl: string
    ): Promise<Map<string, any>[]> {
        try {
            const tokenids: string[] = [tokenid];
            const requestParam: Record<string, any> = {};
            requestParam.tokenids = tokenids;
            const ordersTickerList: Map<string, any>[] = [];

            await WalletUtil.getOrdersTicker(requestParam, ordersTickerList, serverUrl);
            return ordersTickerList;
        } catch (error) {
            console.error("Error in searchOrdersTicker:", error);
            throw error;
        }
    }

    /**
     * Get order tickers from the server
     * @param requestParam The request parameters
     * @param ordertickers The list to populate with ticker data
     * @param serverUrl The server URL to query
     */
    private static async getOrdersTicker(
        requestParam: Record<string, any>,
        ordertickers: Map<string, any>[],
        serverUrl: string
    ): Promise<void> {
        const response0 = await OkHttp3Util.post(
            serverUrl + ReqCmd.getOrdersTicker,
            new TextEncoder().encode(JSON.stringify(requestParam))
        );

        const orderTickerResponse: OrderTickerResponse = Json.jsonmapper().parse(response0, {
            mainCreator: () => [OrderTickerResponse, MatchLastdayResult]
        });

        const tickers = orderTickerResponse.getTickers();
        if (tickers) {
            for (const matchResult of tickers) {
                const map = new Map<string, any>();
                map.set("price", matchResult.getPrice());
                map.set("tokenid", matchResult.getTokenid());
                map.set("inserttime", new Date(matchResult.getInserttime()).toISOString());
                map.set("executedQuantity", matchResult.getExecutedQuantity());
                ordertickers.push(map);
            }
        }
    }

    /**
     * Check if the given address belongs to the wallet keys
     * @param wallet The wallet instance
     * @param aesKey The encryption key
     * @param address The address to check
     * @returns True if the address belongs to the wallet, false otherwise
     */
    public static async checkCancel(
        wallet: Wallet,
        aesKey: any,
        address: string
    ): Promise<boolean> {
        try {
            const keys = await wallet.walletKeys(aesKey);
            for (const ecKey of keys) {
                if (address === ecKey.toAddress(wallet.params).toString()) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            console.error("Error in checkCancel:", error);
            throw error;
        }
    }

    /**
     * Cancel an order
     * @param wallet The wallet instance
     * @param aesKey The encryption key
     * @param initialBlockHashHex The initial block hash of the order to cancel
     * @param address The address associated with the order
     * @param serverUrl The server URL to send the request to
     */
    public static async cancelOrder(
        wallet: Wallet,
        aesKey: any,
        initialBlockHashHex: string,
        address: string,
        serverUrl: string
    ): Promise<void> {
        try {
            wallet.setServerURL(serverUrl);
            const hash = Sha256Hash.wrap(Utils.HEX.decode(initialBlockHashHex));
            let legitimatingKey: ECKey | null = null;

            // Get the wallet keys to find the one that matches the address
            const keys = await wallet.walletKeys(aesKey);
            for (const ecKey of keys) {
                if (address === ecKey.toAddress(wallet.params).toString()) {
                    legitimatingKey = ecKey;
                    break;
                }
            }

            if (legitimatingKey) {
                // Create the order cancel info
                const orderCancelInfo = new OrderCancelInfo(hash);

                // Create a transaction to cancel the order
                const tx = new Transaction(wallet.params);
                tx.setMemo("cancel order");
                tx.setData(orderCancelInfo.toByteArray());

                // Add inputs and outputs similar to other transactions
                const utxos = await wallet.calculateAllSpendCandidatesUTXO(aesKey, false);

                // Find an appropriate UTXO to fund the transaction
                let foundUtxo = false;
                for (const utxo of utxos) {
                    const beneficiary = await wallet.getECKey(aesKey, utxo.getAddress());
                    tx.addInput2(utxo.getBlockHash(), new FreeStandingTransactionOutput(wallet.params, utxo));

                    // Add a small output for change if needed
                    const fee = Coin.valueOf(CoinConstants.FEE_DEFAULT.getValue(), NetworkParameters.getBIGTANGLE_TOKENID());
                    if (utxo.getValue().compareTo(fee) > 0) {
                        const changeValue = utxo.getValue().subtract(fee);
                        if (changeValue.getValue() > BigInt(0)) {
                            tx.addOutputEckey(changeValue, beneficiary);
                        }
                    }
                    foundUtxo = true;
                    break;
                }

                if (!foundUtxo) {
                    throw new Error("No UTXOs available to fund the cancel order transaction");
                }

                // Sign the transaction
                await wallet.signTransaction(tx, aesKey, "THROW");

                // Get the current tip block to inherit the correct difficulty target and other parameters
                const tipBlock = await wallet.getTip();

                // Create a new block based on the tip block to ensure correct difficulty target
                const block =  await wallet.getTip()    ; 
                block.addTransaction(tx);
                block.setBlockType(BlockType.BLOCKTYPE_ORDER_CANCEL);

                // Post the block to the network
                await OkHttp3Util.post(
                    serverUrl + ReqCmd.saveBlock,
                    new Uint8Array(block.bitcoinSerialize())
                );
            } else {
                throw new Error("No matching key found for the given address");
            }
        } catch (error) {
            console.error("Error in cancelOrder:", error);
            throw error;
        }
    }

    /**
     * Get localized token name based on the token name
     * @param tokenname The token name to check
     * @returns Localized name for CNY or USD tokens, empty string otherwise
     */
    public static getLocalTokenName(tokenname: string): string {
        if (tokenname.includes("cny@etf.com")) {
            // In a real implementation, you would return the localized message
            // For now, we'll return a placeholder
            return "CNY"; // Placeholder for getLocalMessage(Currencylist.CNY)
        }
        if (tokenname.includes("usd@etf.com")) {
            // In a real implementation, you would return the localized message
            // For now, we'll return a placeholder
            return "USD"; // Placeholder for getLocalMessage(Currencylist.USD)
        }
        return "";
    }
}