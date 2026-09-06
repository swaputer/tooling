# npm publishing runbook

Swaputer publishes three public npm packages while keeping every source workspace
`private: true`:

- `@swaputer-labs/receipt-codec@0.1.1` — strict `VMReceiptV1` encoding and decoding.
- `@swaputer-labs/tinysol@0.3.1` — TinySol compiler, assembler, simulator and offline CLI.
- `@swaputer-labs/cli@0.1.1` — read-only on-chain SVM transaction inspection and receipt decoding.

`0.3.1` is the TinySol npm package version. The assembler/build-manifest
toolchain identity is `@swaputer-labs/tinysol@0.1.0`, preserving its independent
manifest version while changing only the scope name. The compiler semantic
version remains `0.2.0-experimental` because this rename does not change
language or code-generation semantics. The reproducibility source fingerprint
and dependency-lock hash are regenerated for the new package metadata while
compiled program bytecode hashes remain unchanged.

The source manifests are deliberately not publishable. Public manifests are
generated in a temporary directory from `release/npm/packages.json`, and only an
allowlisted set of built files is copied. This avoids accidental publication and
keeps npm-only metadata outside the frozen TinySol compiler identity.

The Swaputer repository uses the MIT License. This npm workflow has a separate,
strict publication boundary: only the allowlisted files inside the three
generated package archives are uploaded to npm. Contracts, applications,
services, deployment sources and operational tooling are never copied into the
npm staging directories.

## Current publication

The `@swaputer-labs` packages were published on September 6, 2026. Exact
registry timestamps, integrity hashes, source commit and the package-only
boundary are recorded in `release/npm/swaputer-labs-publication.json`:

- `@swaputer-labs/receipt-codec@0.1.1`
- `@swaputer-labs/tinysol@0.3.1`
- `@swaputer-labs/cli@0.1.1`

The source package manifests remain `private: true`; the public identities exist
only in the allowlisted generated tarballs.

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
tar -tzf ./artifacts/npm/swaputer-labs-receipt-codec-0.1.1.tgz
tar -tzf ./artifacts/npm/swaputer-labs-tinysol-0.3.1.tgz
tar -tzf ./artifacts/npm/swaputer-labs-cli-0.1.1.tgz
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

npm does not permit these exact `name@version` combinations to be reused. The
prepared packages therefore use the new `@swaputer-labs` scope and versions
`0.1.1`, `0.3.1`, and `0.1.1`; the CLI pins the prepared receipt codec exactly.
The historical `release/npm/publication.json` record is not rewritten for the
new scope. npm also blocks republishing a withdrawn package name for 24 hours.

## Publication order

The package scope must exist and the publishing account must be authorized for
`@swaputer-labs`. Each generated package contains its own MIT `LICENSE`.

Publish a newly versioned release in dependency order. Never reuse the withdrawn
tarball versions shown above:

```sh
npm publish ./artifacts/npm/swaputer-labs-receipt-codec-0.1.1.tgz --access public
npm publish ./artifacts/npm/swaputer-labs-tinysol-0.3.1.tgz --access public
npm publish ./artifacts/npm/swaputer-labs-cli-0.1.1.tgz --access public
```

These commands are release-operator instructions; package preparation and CI never publish.
For a future release, use npm staged publishing when available or publish from a
protected environment, verify package contents and provenance on npm, then test
installation in a fresh empty directory. Never attempt to republish the versions
recorded above; prepare new versions and evidence first.
