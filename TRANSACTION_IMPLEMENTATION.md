# Transaction Implementation with bigtangle-ts

## Overview

This document describes the complete transaction implementation for sending payments using bigtangle-ts.

## Architecture

### Transaction Service (`sources/services/transaction.ts`)

The transaction service provides a complete implementation for:
1. UTXO selection
2. Transaction creation
3. Transaction signing
4. Transaction broadcasting

### Key Components

#### 1. UTXO Selection

```typescript
function selectUTXOs(
  utxos: UTXO[],
  requiredAmount: bigint,
  fee: bigint
): SelectedUTXOs | null
```

**Algorithm**: Greedy selection with largest-first strategy
- Filters for spendable and confirmed UTXOs
- Sorts by value descending to minimize number of inputs
- Selects UTXOs until required amount + fee is met
- Returns selected UTXOs, total value, and change amount

**Benefits**:
- Minimizes transaction size by reducing number of inputs
- Reduces fees
- Simple and efficient

#### 2. Transaction Creation

```typescript
async function createAndSignTransaction(
  params: SendTransactionParams
): Promise<ApiResponse<TransactionResult>>
```

**Process**:
1. Fetch UTXOs from the network
2. Select appropriate UTXOs
3. Create ECKey from private key
4. Create transaction object
5. Add inputs from selected UTXOs
6. Add output to recipient
7. Add change output (if needed)
8. Set memo (if provided)
9. Sign all inputs
10. Serialize transaction

**Key Classes Used**:
- `Transaction` - Main transaction object
- `TransactionInput` - Transaction inputs (UTXOs being spent)
- `TransactionOutput` - Transaction outputs (new UTXOs being created)
- `Coin` - Value + token ID
- `Address` - Blockchain address
- `Script` - Locking/unlocking scripts
- `TransactionOutPoint` - Reference to previous output
- `Sha256Hash` - Transaction hash

#### 3. Transaction Signing

**Signing Process**:
```typescript
for (let i = 0; i < numInputs; i++) {
  // Get the script from the output being spent
  const scriptPubKey = new Script(scriptBytes);

  // Calculate signature hash (SIGHASH_ALL)
  const sigHash = tx.hashForSignatureScript(i, scriptPubKey, 1, false);

  // Sign with private key
  const signature = ecKey.sign(sigHash);

  // Create signature script (scriptSig)
  const scriptSig = Script.createInputScript(signature, ecKey);
  input.setScriptSig(scriptSig);
}
```

**Signature Type**: SIGHASH_ALL (value = 1)
- Signs all inputs and outputs
- Most common and secure signature type
- Prevents modification of transaction after signing

#### 4. Transaction Broadcasting

```typescript
async function broadcastTransaction(rawTx: string): Promise<ApiResponse<string>>
```

**Endpoint**: `POST {serverUrl}/broadcastTransaction`

**Payload**:
```json
{
  "rawtx": "hexadecimal transaction data"
}
```

**Response**:
```json
{
  "txHash": "transaction hash",
  "error": "error message if failed"
}
```

## Integration with UI

### Transaction Screen (`sources/app/(tabs)/index.tsx`)

**Flow**:
1. User selects token from their balances
2. User enters recipient address
3. User enters amount
4. User optionally enters memo
5. User clicks "Send"
6. Confirmation dialog shows transaction details
7. User confirms
8. Transaction is created, signed, and broadcast
9. Success message shows transaction hash
10. Form is cleared and balances refreshed

**Code Integration**:
```typescript
import { sendTransaction } from '@/services/transaction';

const handleSend = async () => {
  // Validate inputs...

  // Convert amount to satoshis
  const decimals = selectedToken.decimals || 8;
  const satoshis = Math.floor(amountNum * Math.pow(10, decimals));

  // Send transaction
  const result = await sendTransaction({
    fromAddress: publicInfo!.address,
    toAddress,
    amount: satoshis.toString(),
    tokenId: selectedToken.tokenid,
    privateKeyHex: wallet.wallet.privateKey,
    memo: memo || undefined,
  });

  // Handle result...
};
```

## Fee Estimation

### Simple Fee Model

```typescript
function estimateTransactionFee(numInputs: number, numOutputs: number): bigint {
  const baseFee = BigInt(1000); // 1000 satoshis base
  const perInputFee = BigInt(500); // 500 satoshis per input
  const perOutputFee = BigInt(300); // 300 satoshis per output

  return baseFee + perInputFee * BigInt(numInputs) + perOutputFee * BigInt(numOutputs);
}
```

**Default Fee**: 1000 satoshis (0.00001 tokens with 8 decimals)

**Fee Calculation**:
- Base: 1000 satoshis
- Per input: 500 satoshis
- Per output: 300 satoshis

**Example**:
- 2 inputs, 2 outputs: 1000 + (2 × 500) + (2 × 300) = 2600 satoshis

## Security Considerations

### Private Key Handling

1. **Never Stored in Plain Text**
   - Private keys encrypted with scrypt
   - Only decrypted in memory when needed

2. **Auto-Lock on Background**
   - Wallet automatically locks when app goes to background
   - Private key cleared from memory

3. **Transaction Signing**
   - Signing happens in-memory only
   - Private key never leaves the device
   - No network transmission of private key

### Transaction Validation

1. **Balance Check**
   - Verify sufficient balance before creating transaction
   - Account for transaction fee

2. **Address Validation**
   - Validate recipient address format
   - Use bigtangle-ts Address class for parsing

3. **Amount Validation**
   - Ensure positive amount
   - Verify amount doesn't exceed balance
   - Handle decimal conversions correctly

### UTXO Selection Safety

1. **Spendable Check**
   - Only select UTXOs marked as spendable
   - Ensure UTXOs are confirmed

2. **Double-Spend Prevention**
   - Selected UTXOs are from confirmed outputs
   - No race conditions in UTXO selection

## Error Handling

### Transaction Creation Errors

```typescript
{
  success: false,
  error: "Insufficient funds" | "Failed to fetch UTXOs" | "Failed to create transaction"
}
```

### Broadcasting Errors

```typescript
{
  success: false,
  error: "Failed to broadcast transaction" | "HTTP error message"
}
```

### User-Facing Error Messages

- **Insufficient funds**: "You don't have enough balance to complete this transaction"
- **Invalid address**: "Please enter a valid recipient address"
- **Network error**: "Failed to connect to network. Please try again"
- **Transaction failed**: "Transaction could not be completed. Please try again"

## Testing

### Manual Testing Checklist

- [ ] Send transaction with sufficient balance
- [ ] Attempt transaction with insufficient balance
- [ ] Send transaction with memo
- [ ] Send transaction without memo
- [ ] Send transaction with change output
- [ ] Send transaction that uses exact balance (no change)
- [ ] Cancel transaction confirmation
- [ ] Network error during UTXO fetch
- [ ] Network error during broadcast
- [ ] Invalid recipient address
- [ ] Zero or negative amount
- [ ] Very large amount
- [ ] Multiple UTXOs required
- [ ] Single UTXO sufficient

### Test Accounts

**Testnet**:
- Use testnet tokens for safe testing
- Set `useTestnet: true` in settings
- Get testnet tokens from faucet

## Future Enhancements

### Planned Features

1. **Advanced Fee Estimation**
   - Dynamic fee based on network congestion
   - Fee estimation from network statistics
   - User-selectable fee levels (slow/normal/fast)

2. **Transaction History**
   - Store sent transactions locally
   - Query transaction status from network
   - Show confirmation count

3. **Multi-Signature Support**
   - Support for multi-sig addresses
   - Partial signature creation
   - Signature collection and broadcasting

4. **Batch Transactions**
   - Send to multiple recipients in one transaction
   - Optimize UTXO selection for batch sends

5. **Replace-By-Fee (RBF)**
   - Allow increasing fee of unconfirmed transaction
   - Re-broadcast with higher fee

6. **Coin Control**
   - Manual UTXO selection
   - Privacy-focused UTXO management
   - Freeze/unfreeze specific UTXOs

### Optimization Opportunities

1. **UTXO Selection Algorithms**
   - Branch and bound for optimal selection
   - Privacy-preserving selection
   - Minimize dust outputs

2. **Caching**
   - Cache UTXO set locally
   - Invalidate on new blocks
   - Reduce network requests

3. **Offline Signing**
   - Create unsigned transaction on online device
   - Sign on offline device
   - Broadcast from online device

## Bigtangle-ts API Reference

### Key Classes

**Transaction**
- `new Transaction(params)` - Create transaction
- `addInput(input)` - Add input
- `addOutput(output)` - Add output
- `setMemo(memo)` - Set transaction memo
- `hashForSignatureScript(...)` - Calculate signature hash
- `getHash()` - Get transaction hash
- `bitcoinSerialize()` - Serialize to bytes

**Coin**
- `new Coin(satoshis, tokenid)` - Create coin
- `getValue()` - Get value in satoshis
- `getTokenid()` - Get token ID

**Address**
- `Address.fromBase58(params, address)` - Parse address
- `toBase58()` - Convert to string

**ECKey**
- `ECKey.fromPrivate(bytes)` - Create from private key
- `sign(hash)` - Sign hash
- `getPublicKeyAsHex()` - Get public key

**Script**
- `Script.createOutputScript(address)` - Create P2PKH output script
- `Script.createInputScript(signature, key)` - Create signature script

## Dependencies

### Required Imports

```typescript
import { ECKey, TestParams, Utils } from '@bigtangle/bigtangle-ts';
import { Transaction } from '@bigtangle/bigtangle-ts/dist/net/bigtangle/core/Transaction';
import { TransactionInput } from '@bigtangle/bigtangle-ts/dist/net/bigtangle/core/TransactionInput';
import { TransactionOutput } from '@bigtangle/bigtangle-ts/dist/net/bigtangle/core/TransactionOutput';
import { Coin } from '@bigtangle/bigtangle-ts/dist/net/bigtangle/core/Coin';
import { Address } from '@bigtangle/bigtangle-ts/dist/net/bigtangle/core/Address';
import { Script } from '@bigtangle/bigtangle-ts/dist/net/bigtangle/script/Script';
import { TransactionOutPoint } from '@bigtangle/bigtangle-ts/dist/net/bigtangle/core/TransactionOutPoint';
import { Sha256Hash } from '@bigtangle/bigtangle-ts/dist/net/bigtangle/core/Sha256Hash';
```

### Type Suppressions

Due to incomplete TypeScript definitions in bigtangle-ts, `@ts-ignore` comments are required for imports from the dist folder.

## Troubleshooting

### Common Issues

**"Insufficient funds"**
- Check UTXO response from network
- Verify balance calculation includes all spendable UTXOs
- Ensure fee is accounted for in balance check

**"Failed to fetch UTXOs"**
- Check network connection
- Verify server URL in settings
- Check address format

**"Transaction failed" during broadcast**
- Check transaction serialization
- Verify all inputs are properly signed
- Ensure server is accessible

**Private key errors**
- Verify wallet is unlocked
- Check private key format (hex string)
- Ensure key matches address

## Contact & Support

For issues with transaction implementation:
1. Check console logs for detailed error messages
2. Verify network connectivity and server settings
3. Test with testnet first
4. Check transaction serialization format

## Version History

**v1.0.0** (Current)
- Initial transaction implementation
- UTXO selection with greedy algorithm
- P2PKH transaction support
- SIGHASH_ALL signing
- Basic fee estimation
- Memo support
