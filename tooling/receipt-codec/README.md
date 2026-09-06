# `@swaputer/receipt-codec`

Dependency-free runtime codec for the frozen SwapVM `VMReceiptV1` payload. Node and `@noble/hashes` are development-only dependencies used for tests, Solidity constant generation checks and freeze-manifest verification; the code under `src/` imports no third-party package.

## Installation

```sh
npm install @swaputer/receipt-codec
```

Requires Node.js 20 or newer and uses ES modules.

## Decode a Kernel receipt

```ts
import {
  decodeVMReceipt,
  isVMReceiptError,
  type Hex
} from "@swaputer/receipt-codec";

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
not fetch transactions or trust partial records. Use `@swaputer/cli` when the
input is a transaction hash rather than an already extracted receipt payload.

## API

```ts
decodeVMReceipt(input: Uint8Array | `0x${string}`): VMReceiptV1
encodeVMReceipt(receipt: VMReceiptV1Input | VMReceiptV1): Uint8Array
encodeVMReceiptHex(receipt: VMReceiptV1Input | VMReceiptV1): `0x${string}`
```

`decodeVMReceipt` returns deeply frozen records only after the complete payload and mandatory final Kernel summary pass validation. Unknown application records remain raw and lossless. Known Kernel records include typed `decoded` fields. A failure throws `VMReceiptError` with a stable `ReceiptErrorCode`, optional byte offset and structured details; it never returns partial records.

Run locally:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run check:manifests
```

See the [fixture documentation](https://github.com/swaputer/tooling/blob/main/tooling/receipt-codec/fixtures/README.md) for deterministic Foundry fixture regeneration.

## License

The files distributed in this npm package are available under the MIT License.
Only this package's allowlisted files are included in its npm archive.
