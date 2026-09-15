# SwapVM v1.2 Executor Context Extension

Status: frozen protocol extension for the unaudited experimental v1.2 Stage 7M
release-candidate line.

This document defines the minimal protocol extension required for MiniVM programs to safely bind actions to an EVM application entrypoint such as an ETH vault or escrow market. It does not modify the frozen v1.1 files. The v1.1 line remains defined by `SwapVM-v1.1-frozen-spec.md`, `SwapVM-ISA-v1.json` and `SwapVM-v1.1-freeze-manifest.json`.

## Compatibility boundary

SwapVM v1.2 intentionally changes the authenticated action domain and VM ISA:

- `VM_VERSION = 2`.
- EIP-712 domain version is `"1.2"`.
- `VMAction` fields and type hash are unchanged from v1.1.
- VMReceiptV1 encoding is unchanged.
- ProgramPackageV1 encoding is unchanged.
- Existing v1.1 signatures are invalid under v1.2 because the domain version changes.
- Existing v1 bytecode remains valid under ISA v2 unless it relied on opcodes `0xba`, `0xbb` or `0xbc` being invalid.

## New MiniVM context opcodes

ISA v2 adds three read-only context opcodes:

| Opcode | Mnemonic | Type | Semantics |
| --- | --- | --- | --- |
| `0xba` | `TXROUTER` | EVM address word | The Router address bound into the authenticated root action. |
| `0xbb` | `TXEXECUTOR` | EVM address word | The `authorizedExecutor` address bound into the authenticated root action, or zero for permissionless relay. |
| `0xbc` | `TXRECIPIENT` | EVM address word | The EVM recipient address bound into the authenticated root action. |

Each value is pushed as a 256-bit word containing the 20-byte EVM address in the low 160 bits and zero high bits. The values are inherited unchanged by all nested `CALL`, `STATICCALL` and `CREATE` descendants.

For direct `Kernel.staticCall`, there is no signed Router action. The read-only local context uses:

- `TXROUTER = address(0)`;
- `TXEXECUTOR = msg.sender`;
- `TXRECIPIENT = address(0)`.

This direct static context is only a query convenience and cannot commit storage, deployments or virtual records.

## Security use

MiniVM programs that bridge or escrow EVM-side assets can now enforce an EVM entrypoint:

```text
require(tx.executor == trustedVault)
```

An EVM vault or market must submit the signed VM action through the canonical Router with:

```text
authorizedExecutor == address(vaultOrMarket)
```

The Router already requires a nonzero `authorizedExecutor` to equal its external `msg.sender`; the Kernel signs and verifies the same field. Therefore a program that checks `TXEXECUTOR` cannot be triggered by a direct user Router call or a different EVM contract.

## Non-goals

v1.2 does not add value transfer inside MiniVM, delegatecall, upgrades, pausing, dynamic bytes, ABI changes, new Ethereum application events, or any new receipt record format. It also does not define sETH or sell-order escrow itself; those are application protocols enabled by this context extension.

## Required implementation updates

- `SwaputerKernel` sets `VM_VERSION = 2`, uses EIP-712 domain name `"Swaputer"` and version `"1.2"`, and passes `router`, `authorizedExecutor` and `recipient` into `VMContext`.
- `SwapVMMiniVM` accepts and executes opcodes `0xba..0xbc`.
- TinySol exposes `tx.router`, `tx.executor` and `tx.recipient` as `address`.
- The TypeScript MiniVM simulator and fee estimator carry the same context fields.
- Tooling uses `SwapVM-ISA-v2.json` as the source for the v1.2 line while preserving historical v1.1 files.
