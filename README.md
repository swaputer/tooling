# Swaputer Tooling

Private developer-tooling repository for Swaputer. It contains the TinySol
compiler and simulator, the strict receipt codec, the read-only transaction CLI,
the inspector extension, deployment-manifest helpers, and reference integration
tools.

The npm packages are publicly available while every source package remains
`private: true`; running package preparation alone does not publish anything.
The current public package identities are `@swaputer-labs/receipt-codec@0.1.2`,
`@swaputer-labs/tinysol@0.4.0`, and `@swaputer-labs/cli@0.1.2`; the former
`@swaputer/*` publications remain only in the immutable withdrawal record.

The public CLI `0.1.2` is the Node.js command/library recorded in the npm
publication evidence; it does not expose `@swaputer-labs/cli/browser`. The
browser-safe entry point on `main` belongs to the private `0.1.3-dev.0` source
line and is not currently available from npm. This distinction prevents a new
source tree from being mistaken for the already-published `0.1.2` tarball.

## Source layout

- `tooling/tinysol` — compiler, assembler, simulator, fixtures, and programs.
- `tooling/receipt-codec` — strict `VMReceiptV1` codec and fixtures.
- `tooling/cli` — read-only SVM transaction inspection.
- `apps/swaputer-inspector` — browser inspection extension.
- `tooling/deployment-manifest` — release-manifest validation.
- `tooling/indexer` — legacy TypeScript reference indexer.

The `src`, `docs/spec`, `reference`, `deployments`, `config`, and `audit`
directories are immutable compatibility snapshots used by the toolchain's drift
tests. Their authoritative source is `swaputer/protocol`.

## Verification

```sh
npm ci --prefix tooling/receipt-codec
npm test --prefix tooling/receipt-codec
npm ci --prefix tooling/tinysol
npm test --prefix tooling/tinysol
npm ci --prefix tooling/cli
npm test --prefix tooling/cli
node --test script/*.test.mjs
```

This repository was split from private monorepo commit
`c9c8bb269e9dfd112d2dad78726a9db516940462` on September 6, 2026. The split
starts a fresh Git history; the source monorepo remains the historical evidence
archive. Licensed under the MIT License.
