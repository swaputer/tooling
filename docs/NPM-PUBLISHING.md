# npm publishing runbook

Swaputer can prepare three public npm packages while keeping every source workspace
`private: true`:

- `@swaputer/receipt-codec` — strict `VMReceiptV1` encoding and decoding.
- `@swaputer/tinysol` — TinySol compiler, assembler, simulator and offline CLI.
- `@swaputer/cli` — read-only on-chain SVM transaction inspection and receipt decoding.

The source manifests are deliberately not publishable. Public manifests are
generated in a temporary directory from `release/npm/packages.json`, and only an
allowlisted set of built files is copied. This avoids accidental publication and
keeps npm-only metadata outside the frozen TinySol compiler identity.

The Swaputer repository uses the MIT License. This npm workflow has a separate,
strict publication boundary: only the allowlisted files inside the three
generated package archives are uploaded to npm. Contracts, applications,
services, deployment sources and operational tooling are never copied into the
npm staging directories.

## Prepare and inspect

Use Node.js 22 or newer. From the repository root:

```sh
npm ci --prefix tooling/receipt-codec
npm ci --prefix tooling/tinysol
npm ci --prefix tooling/cli
node script/prepare-npm-packages.mjs
```

The command runs each package test suite, scans the staged files for common
secret and local-path patterns, checks the exact npm file list, and writes three
unpublished tarballs plus `artifacts/npm/npm-package-evidence.json`.

Before any publish, inspect the evidence and each tarball:

```sh
tar -tzf ./artifacts/npm/swaputer-receipt-codec-0.1.0.tgz
tar -tzf ./artifacts/npm/swaputer-tinysol-0.3.0.tgz
tar -tzf ./artifacts/npm/swaputer-cli-0.1.0.tgz
```

Do not store an npm token in this repository or any `.env.local` file. Prefer an
npm trusted publisher from a protected GitHub Actions environment. npm trusted
publishing requires a current npm CLI (at least 11.5.1) and a supported Node.js
runtime. Require two-factor authentication for manual publication and account
changes.

## Withdrawal record

The first public versions were published and then withdrawn on September 6,
2026. They are no longer installable from the public registry. Exact publication
and withdrawal timestamps, integrity hashes, source commit and the package-only
boundary are recorded in `release/npm/publication.json`.

- `@swaputer/receipt-codec@0.1.0` — withdrawn
- `@swaputer/tinysol@0.3.0` — withdrawn
- `@swaputer/cli@0.1.0` — withdrawn

npm does not permit these exact `name@version` combinations to be reused. A
future release must use at least `0.1.1`, `0.3.1`, and `0.1.1` respectively,
and must also update the CLI's exact receipt-codec dependency. npm also blocks
republishing each package name for 24 hours after withdrawal.

## Publication order

The package scope must exist and the publishing account must be authorized for
`@swaputer`. Each generated package contains its own MIT `LICENSE`.

Publish a newly versioned release in dependency order. Never reuse the withdrawn
tarball versions shown above:

```sh
npm publish ./artifacts/npm/swaputer-receipt-codec-<new-version>.tgz --access public
npm publish ./artifacts/npm/swaputer-tinysol-<new-version>.tgz --access public
npm publish ./artifacts/npm/swaputer-cli-<new-version>.tgz --access public
```

These commands are release-operator instructions; package preparation and CI never publish.
For the first release, use npm staged publishing when available or publish from a
protected environment, verify package contents and provenance on npm, then test
installation in a fresh empty directory. Only after the registry versions are
verified should public documentation change from source/local setup to npm
installation commands.
