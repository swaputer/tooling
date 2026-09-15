import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const active = JSON.parse(await readFile(resolve(root, "deployments/active/ethereum-mainnet.json"), "utf8"));
const packaged = JSON.parse(await readFile(resolve(root, "tooling/cli/deployments/ethereum-mainnet.json"), "utf8"));

assert.equal(packaged.releaseName, active.release.name);
assert.equal(packaged.protocolVersion, active.release.protocolVersion);
assert.equal(packaged.chainId, active.network.chainId);
assert.equal(packaged.networkName, active.network.name);
assert.equal(packaged.kernel.toLowerCase(), active.core.kernel.toLowerCase());
assert.equal(packaged.kernelRuntimeCodeHash.toLowerCase(), active.runtimeCodeHashes.kernel.toLowerCase());
assert.equal(packaged.worldId.toLowerCase(), active.core.worldId.toLowerCase());
assert.equal(packaged.sourceManifestHash.toLowerCase(), active.integrity.manifestHash.toLowerCase());

process.stdout.write("Packaged Ethereum Mainnet deployment matches the active release.\n");
