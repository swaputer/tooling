# `@swaputer-labs/cli`

Read-only command-line verification for Swaputer SVM transactions. The CLI
fetches an Ethereum receipt through an explicitly named RPC environment
variable, verifies the configured chain, Kernel runtime code hash, World ID,
`Events(bytes32,uint64,bytes)` envelope and complete `VMReceiptV1`, then emits a
human summary or JSON.

It never loads a wallet, signs or sends transactions. RPC URLs are not accepted
as command-line arguments, printed in output or included in structured errors.

## Installation

```sh
npm install --global @swaputer-labs/cli
swaputer --help
```

It can also be run without a global installation:

```sh
npx @swaputer-labs/cli --help
```

Requires Node.js 22 or newer.

## Inspect a transaction

```sh
export BASE_SEPOLIA_RPC_URL='https://example.invalid'

swaputer inspect 0x... \
  --network base-sepolia \
  --rpc-env BASE_SEPOLIA_RPC_URL

swaputer inspect 0x... \
  --rpc-env BASE_SEPOLIA_RPC_URL \
  --json

swaputer decode-receipt 0x... --json
```

Example human-readable output:

```text
Verified Swaputer transaction 0x...
Network: Base Sepolia (84532)
Release: swaputer-v1.2-rc4
Block: 46449798
Execution 1: height=1526 actor=0x... target=0x... bytes=191 burned=191000000000000
```

`--json` serializes bigint fields as decimal strings for scripts and other
automated consumers.

The package currently includes a verified Base Sepolia release descriptor. It
does not contain a Base Mainnet configuration.

Exit codes are stable: `2` for input/usage, `3` for RPC configuration or
transport, `4` for a missing transaction, `5` for a reverted transaction, `6`
for a non-Swaputer transaction and `7` for verification failures.

## License

MIT
