# npm publishing runbook

Swaputer publishes three public npm packages while keeping every source workspace
`private: true`:

- `@swaputer-labs/receipt-codec@0.1.2` — strict `VMReceiptV1` encoding and decoding.
- `@swaputer-labs/tinysol@0.3.2` — TinySol compiler, assembler, simulator and offline CLI.
- `@swaputer-labs/cli@0.1.2` — read-only on-chain SVM transaction inspection and receipt decoding.

The public CLI `0.1.2` has only its Node.js root export. It does not contain the
`./browser` export now present on the private `0.1.3-dev.0` source line. The
published binary also prints `0.1.1` for `--version`; that is a historical
display-only defect, not permission to replace or republish `0.1.2`. Registry
metadata and the recorded integrity hash remain the authoritative identity.

`0.3.2` is the TinySol npm package version. The assembler/build-manifest
toolchain identity is `@swaputer-labs/tinysol@0.1.0`, preserving its independent
manifest version. The compiler semantic version remains `0.2.0-experimental`
because this patch changes public documentation and package metadata, not the
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

- `@swaputer-labs/receipt-codec@0.1.2`
- `@swaputer-labs/tinysol@0.3.2`
- `@swaputer-labs/cli@0.1.2`

The source package manifests remain `private: true`; the public identities exist
only in the allowlisted generated tarballs.

`release/npm/packages.json`, `artifacts/npm/npm-package-evidence.json`, and
`release/npm/swaputer-labs-publication.json` describe that completed release.
Treat their package identities and integrity values as immutable historical
evidence. In particular, do not update them to describe the current private CLI
source line.

## Prepare and inspect a future release

Use Node.js 22 or newer. From the repository root:

```sh
npm ci --prefix tooling/receipt-codec
npm ci --prefix tooling/tinysol
npm ci --prefix tooling/cli
```

The default release plan records versions that are already published, so the
preparation command now rejects it before building, cleaning the output
directory, or creating a tarball:

```sh
node script/prepare-npm-packages.mjs
```

For an authorized future publication, create and review a new JSON plan such as
`release/npm/packages.next.json`. Give every included package an unused version,
set its source manifest to the same version, set plan status to
`prepared-not-published`, and include only the package or packages actually
being released. Then run:

```sh
node script/prepare-npm-packages.mjs \
  --config release/npm/packages.next.json
```

The guard requires pre-publication status, compares the plan with immutable
publication evidence, refuses any known published `name@version`, and checks
that every planned identity is absent from the public registry. Registry errors
fail closed. A valid new plan then runs each included package test suite, scans
staged files for common secret and local-path patterns, checks the exact npm
file list, and writes unpublished tarballs plus
`artifacts/npm/npm-package-evidence.json`.

Before any publish, confirm that every planned identity is unused in the npm
registry, inspect the evidence and each newly generated tarball, and compare its
manifest version with its CLI output where applicable. For example:

```sh
tar -tzf ./artifacts/npm/<new-package-tarball>.tgz
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
initial replacement packages therefore used the new `@swaputer-labs` scope and
versions `0.1.1`, `0.3.1`, and `0.1.1`. The historical
`release/npm/publication.json` record is not rewritten for the new scope.

## Publication order

The package scope must exist and the publishing account must be authorized for
`@swaputer-labs`. Each generated package contains its own MIT `LICENSE`.

Publish only newly versioned archives, in dependency order. Never reuse any
identity in either publication record, including the currently published
`@swaputer-labs` versions:

```sh
npm publish ./artifacts/npm/<new-package-tarball>.tgz --access public
```

These commands are release-operator instructions; package preparation and CI never publish.
For a future release, use npm staged publishing when available or publish from a
protected environment, verify package contents and provenance on npm, then test
installation and version output in a fresh empty directory. Only after registry
verification succeeds should a new immutable publication record be committed.
