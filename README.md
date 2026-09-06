# Swaputer Tooling

Private developer-tooling repository for Swaputer. It contains the TinySol
compiler and simulator, the strict receipt codec, the read-only transaction CLI,
the inspector extension, deployment-manifest helpers, and reference integration
tools.

The npm release path is paused. Every source package remains `private: true`;
running package preparation does not publish anything. The only prepared public
package identities are `@swaputer-labs/receipt-codec@0.1.1`,
`@swaputer-labs/tinysol@0.3.1`, and `@swaputer-labs/cli@0.1.1`; the former
`@swaputer/*` publications remain only in the immutable withdrawal record.

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
```

This repository was split from private monorepo commit
`c9c8bb269e9dfd112d2dad78726a9db516940462` on September 6, 2026. The split
starts a fresh Git history; the source monorepo remains the historical evidence
archive. Licensed under the MIT License.
