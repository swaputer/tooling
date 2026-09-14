# `@swaputer-labs/cli`

Read-only command-line verification for Swaputer SVM transactions. The CLI
fetches an Ethereum receipt through an explicitly named RPC environment
variable, verifies the configured chain, canonical containing block and
transaction envelope, finalized head, at least one observed confirmation,
historical Kernel runtime code hash, World ID, `Events(bytes32,uint64,bytes)`
envelope and complete `VMReceiptV1`, then emits a human summary or JSON.

It never loads a wallet, signs or sends transactions. RPC URLs are not accepted
as command-line arguments, printed in output or included in structured errors.

## Installation

```sh
npm install --global @swaputer-labs/cli@0.1.2
swaputer --help
```

It can also be run without a global installation:

```sh
npx @swaputer-labs/cli@0.1.2 --help
```

Requires Node.js 22 or newer.

## Published and source versions

The public npm package is currently `@swaputer-labs/cli@0.1.2`. That immutable
tarball provides the Node.js CLI and root library export only; it does not
provide `@swaputer-labs/cli/browser`. Its `swaputer --version` output says
`0.1.1` because of a historical display-only defect in the published binary;
the npm package manifest and registry integrity identify it as `0.1.2`.

This private source tree is the unreleased `0.1.3-dev.0` line. It fixes the
displayed version and adds a browser-safe entry point for source-integrated
applications. Do not document or install that browser subpath as an npm API
until a newly versioned package has been reviewed and published.

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
Finality: finalized at 46449820 (23 confirmations observed)
Execution 1: height=1526 actor=0x... target=0x... bytes=191 burned=191000000000000
```

`--json` serializes bigint fields as decimal strings for scripts and other
automated consumers.

The package currently includes a verified Base Sepolia release descriptor. It
does not contain a Base Mainnet configuration.

Exit codes are stable: `2` for input/usage, `3` for RPC configuration or
transport, `4` for a missing transaction, `5` for a reverted transaction, `6`
for a non-Swaputer transaction and `7` for verification failures.

## TinySol compatibility

The verifier authenticates the EVM transaction, Kernel, World, program identity and complete
`VMReceiptV1`; it does not reinterpret TinySol source syntax or function return data. It can therefore
verify transactions from programs compiled with the prepared TinySol `0.4.0` line, including bounded
`string<N>`, `bytes<N>` and `T[<=N]`, without changing the public CLI `0.1.2` receipt boundary. Clients
must still verify the deployed program code hash against the exact compiler artifact they intended.

## License

MIT
