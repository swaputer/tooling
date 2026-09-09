# `@swaputer-labs/receipt-codec`

Dependency-free runtime codec for SwapVM `VMReceiptV1` payloads. Decode and
validate receipts from raw bytes or hex, or encode typed receipt data back to
its canonical binary form.

## Installation

```sh
npm install @swaputer-labs/receipt-codec@0.1.2
```

The current public release is `0.1.2`. It requires Node.js 20 or newer and uses
ES modules.

## Decode a Kernel receipt

```ts
import {
  decodeVMReceipt,
  isVMReceiptError,
  type Hex
} from "@swaputer-labs/receipt-codec";

export function inspectReceipt(payload: Hex) {
  try {
    const receipt = decodeVMReceipt(payload);
    return {
      records: receipt.recordCount,
      executedBytes: receipt.worldExecution.executedBytes,
      tokenBurned: receipt.worldExecution.tokenBurned
    };
  } catch (error) {
    if (isVMReceiptError(error)) {
      throw new Error(`Invalid VMReceiptV1: ${error.code}`);
    }
    throw error;
  }
}
```

The decoder validates the complete payload before returning anything. It does
not fetch transactions or trust partial records. Use `@swaputer-labs/cli` when the
input is a transaction hash rather than an already extracted receipt payload.

## API

```ts
decodeVMReceipt(input: Uint8Array | `0x${string}`): VMReceiptV1
encodeVMReceipt(receipt: VMReceiptV1Input | VMReceiptV1): Uint8Array
encodeVMReceiptHex(receipt: VMReceiptV1Input | VMReceiptV1): `0x${string}`
```

`decodeVMReceipt` returns deeply frozen records only after the complete payload and mandatory final Kernel summary pass validation. Unknown application records remain raw and lossless. Known Kernel records include typed `decoded` fields. A failure throws `VMReceiptError` with a stable `ReceiptErrorCode`, optional byte offset and structured details; it never returns partial records.

The runtime has no third-party dependencies and performs no network or wallet
operations.

## License

MIT
