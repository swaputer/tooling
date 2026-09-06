# SwapVM deployment manifest tooling

Strict Stage 7A2/7D-U1 tooling for canonical deployment manifests and fail-closed zero-value release preflight. Its core accepts schema `1` for protocol `1.1` and the local unaudited protocol `1.2` line, checks the matching VM version and ISA hash, recomputes `PoolKey.toId()`, the onchain `SwapVMWorldConfigV1` hash and the canonical JSON manifest hash, and compares the result with an explicit chain observation snapshot. The Stage 7D testnet release preflight remains locked to the v1.1 rc2 unaudited release policy.

The canonical JSON serializer recursively sorts object keys, emits UTF-8 with no insignificant whitespace, and rejects unsafe numbers, `undefined` and environment-specific fields. `integrity.manifestHash` and `integrity.signature` are excluded from the hash payload, so the hash is not self-referential.

The optional detached publisher signature is EIP-191/secp256k1 over the 32-byte `manifestHash`. The library exposes signing for offline callers; the CLI deliberately does not accept private keys. A signature is only publication provenance—verification still requires independent chain reconstruction.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm audit

swaputer-manifest verify manifest.json observation.json
swaputer-manifest canonicalize manifest.json
swaputer-manifest finalize draft.json
swaputer-release preflight --config release.json --observation observation.json --artifacts ../../audit/artifacts.json
swaputer-release live-preflight --config release.json --artifacts ../../audit/artifacts.json --rpc-env SWAPVM_TESTNET_RPC_PRIMARY
```

Library API: `finalizeManifest`, `validateManifest`, `computeWorldId`,
`computeWorldConfigHash`, `computeManifestHash`, `attachEip191Signature`,
`verifyEip191Signature`, `verifyObservation`, `preflightTestnetRelease`,
`validateTestnetReleaseConfig`, `predictCreate2`, and `canonicalJson`. Signing is
available only as an explicit library call for an offline publisher process.

The optional live preflight performs only `eth_chainId` and `eth_getCode` through
an environment-variable name explicitly allowed by the config. The RPC-free
snapshot mode remains available. Neither mode accepts a private key, sends a
transaction, prints the RPC URL, or places URLs, machine paths or timestamps in
a manifest.
