import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ManifestError,
  attachEip191Signature,
  canonicalJson,
  computeManifestHash,
  computeWorldConfigHash,
  computeWorldId,
  finalizeManifest,
  parseStrictJson,
  validateManifest,
  verifyObservation
} from "../src/index.js";
import type { Address, Bytes32, DeploymentManifest, DeploymentObservation } from "../src/index.js";

const address = (value: number): Address => `0x${value.toString(16).padStart(40, "0")}`;
const hash = (value: number): Bytes32 => `0x${value.toString(16).padStart(64, "0")}`;
const code = (value: number) => ({ address: address(value), extcodehash: hash(value + 100), runtimeCodeHash: hash(value + 100) });

function sample(): DeploymentManifest {
  const manifest = {
    schemaVersion: "1", protocolVersion: "1.1",
    release: { environment: "local", auditStatus: "unaudited", auditCandidateTag: "swaputer-v1.1-stage7c-rc2", auditCandidateCommit: "afa54c2e02e7e91430b14b6884faff5e3f5867d9", economicValue: "none", publicMainnetDeploymentAllowed: false, auditedReleaseArtifact: null },
    chainId: 31337, worldConfigHash: hash(0),
    poolManager: code(1), factory: code(2), referenceRegistry: code(3), worldDeployer: code(4),
    artifactStores: {
      kernelCreationCode: { ...code(5), payloadHash: hash(501) },
      hookCreationCode: { ...code(6), payloadHash: hash(601) }
    },
    world: {
      poolKey: { currency0: "ETH", currency1: address(7), fee: 3000, tickSpacing: 60, hooks: address(9) },
      worldId: hash(0), byteGasPrice: "1000000000000", maxByteGasLimit: 1_000_000,
      initialSqrtPriceX96: "79228162514264337593543950336", sealed: true, sealedAtBlock: 42
    },
    gasToken: { ...code(7), decimals: 18, initialSupply: "1000000000000000000000000", initialHolder: address(20), distributionCommitment: hash(701) },
    kernel: code(8), hook: code(9),
    router: { ...code(10), supportsCanonicalVMInput: true, supportsSignedVm: true },
    limits: { vmVersion: 1, receiptVersion: 1, isaHash: "0x2f0059846af771cb9f77e74d5f728744a9b8dbe69313d146b8a5e7fdcbe7c118", maxCodeBytes: 16384, maxStackWords: 1024, maxMemoryBytes: 65536, maxCallDepth: 32, maxReceiptPayloadBytes: 65536 },
    referencePrograms: { src20: hash(20), src721: hash(21), src1155: hash(22), cpamm: hash(23) },
    compiler: { name: "TinySol", version: "1.0.0", hash: hash(30) },
    deployment: { blockHash: hash(40), blockNumber: 42, txHash: hash(41), factoryAddress: address(2), routerAddress: address(10), factoryEventTxIndex: 0 },
    integrity: { sourceControlCommit: "0123456789abcdef", treeCommitment: hash(50), artifactCommitment: hash(51), specKeccak256: hash(52), isaKeccak256: hash(53), manifestHash: hash(0), signature: null }
  } as unknown as DeploymentManifest;
  (manifest.world as { worldId: Bytes32 }).worldId = computeWorldId(manifest.world.poolKey);
  (manifest as { worldConfigHash: Bytes32 }).worldConfigHash = computeWorldConfigHash(manifest);
  (manifest.integrity as { manifestHash: Bytes32 }).manifestHash = computeManifestHash(manifest);
  return manifest;
}

function sampleV12(): DeploymentManifest {
  const manifest = structuredClone(sample()) as unknown as DeploymentManifest & {
    protocolVersion: "1.2";
    limits: { vmVersion: 2; isaHash: Bytes32 };
    integrity: { manifestHash: Bytes32 };
  };
  manifest.protocolVersion = "1.2";
  manifest.limits.vmVersion = 2;
  manifest.limits.isaHash = "0x5958f1a3baf744e5ed92f096a964ee14779db2e32e70a2982c53080eb3cd92c2";
  manifest.integrity.manifestHash = computeManifestHash(manifest);
  return manifest;
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof ManifestError && error.code === code);
}

test("canonical manifest validates and hashes without self-reference", () => {
  const manifest = sample();
  assert.equal(manifest.worldConfigHash, "0x2e83890640ddf1743e749e9f0aa79c8ebb6705b8c9ba74dabeee961665bd4fa3");
  const decoded = validateManifest(manifest);
  assert.equal(decoded.world.worldId, computeWorldId(decoded.world.poolKey));
  assert.equal(decoded.worldConfigHash, computeWorldConfigHash(decoded));
  assert.equal(decoded.integrity.manifestHash, computeManifestHash(decoded));
  const changed = structuredClone(decoded) as unknown as { integrity: { manifestHash: Bytes32; signature: unknown } };
  changed.integrity.manifestHash = hash(999);
  changed.integrity.signature = { ignored: true };
  assert.equal(computeManifestHash(changed as unknown as DeploymentManifest), decoded.integrity.manifestHash);
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
});

test("protocol 1.2 manifests require VM version 2 and ISA v2 hash", () => {
  const decoded = validateManifest(sampleV12());
  assert.equal(decoded.protocolVersion, "1.2");
  assert.equal(decoded.limits.vmVersion, 2);
  assert.equal(decoded.limits.isaHash, "0x5958f1a3baf744e5ed92f096a964ee14779db2e32e70a2982c53080eb3cd92c2");

  const badVmVersion = structuredClone(sampleV12()) as unknown as { limits: { vmVersion: number } };
  badVmVersion.limits.vmVersion = 1;
  expectCode(() => validateManifest(badVmVersion), "INVALID_TYPE");

  const badIsa = structuredClone(sampleV12()) as unknown as { limits: { isaHash: Bytes32 } };
  badIsa.limits.isaHash = "0x2f0059846af771cb9f77e74d5f728744a9b8dbe69313d146b8a5e7fdcbe7c118";
  expectCode(() => validateManifest(badIsa), "CONFIG_HASH_MISMATCH");
});

test("EIP-191 detached signature recovers the declared publisher", () => {
  const manifest = sample();
  const privateKey = new Uint8Array(32); privateKey[31] = 7;
  const decoded = attachEip191Signature(manifest, privateKey);
  assert.equal(decoded.integrity.signature?.message, decoded.integrity.manifestHash);
  assert.equal(decoded.integrity.signature?.algorithm, "EIP-191");
});

test("finalize deterministically replaces draft world, config and manifest hashes", () => {
  const draft = structuredClone(sample()) as unknown as DeploymentManifest;
  (draft.world as { worldId: Bytes32 }).worldId = hash(999);
  (draft as { worldConfigHash: Bytes32 }).worldConfigHash = hash(998);
  (draft.integrity as { manifestHash: Bytes32 }).manifestHash = hash(997);
  assert.deepEqual(finalizeManifest(draft), sample());
});

test("worldId, configHash and manifestHash tampering have stable errors", () => {
  const badWorld = structuredClone(sample()) as unknown as { world: { worldId: Bytes32 } }; badWorld.world.worldId = hash(99);
  expectCode(() => validateManifest(badWorld), "WORLD_ID_MISMATCH");
  const badConfig = structuredClone(sample()) as unknown as { worldConfigHash: Bytes32 }; badConfig.worldConfigHash = hash(99);
  expectCode(() => validateManifest(badConfig), "CONFIG_HASH_MISMATCH");
  const badManifest = structuredClone(sample()) as unknown as { compiler: { version: string } }; badManifest.compiler.version = "tampered";
  expectCode(() => validateManifest(badManifest), "MANIFEST_HASH_MISMATCH");
});

test("canonical JSON rejects duplicate decoded names, malformed numbers and Unicode ambiguity", () => {
  expectCode(() => parseStrictJson('{"world":1,"world":2}'), "INVALID_JSON");
  expectCode(() => parseStrictJson('{"world":1,"\\u0077orld":2}'), "INVALID_JSON");
  expectCode(() => parseStrictJson('{"n":01}'), "INVALID_JSON");
  expectCode(() => parseStrictJson('{"n":1} trailing'), "INVALID_JSON");
  assert.deepEqual(parseStrictJson('{"界":"值","a":[true,null,-1,1.5]}'), { "界": "值", a: [true, null, -1, 1.5] });
});

test("environment fields and malformed integers are rejected", () => {
  const environment = { ...sample(), rpcUrl: "http://localhost:8545" };
  expectCode(() => validateManifest(environment), "FORBIDDEN_FIELD");
  const unsafe = structuredClone(sample()) as unknown as { world: { byteGasPrice: string } }; unsafe.world.byteGasPrice = "01";
  expectCode(() => validateManifest(unsafe), "INVALID_INTEGER");
  const tooWide = structuredClone(sample()) as unknown as { world: { byteGasPrice: string } }; tooWide.world.byteGasPrice = (1n << 128n).toString();
  expectCode(() => validateManifest(tooWide), "INVALID_INTEGER");
  const nested = structuredClone(sample()) as unknown as { compiler: Record<string, unknown> }; nested.compiler.machinePath = "/tmp/build";
  expectCode(() => validateManifest(nested), "FORBIDDEN_FIELD");
  const auditedClaim = structuredClone(sample()) as unknown as { release: { auditStatus: string } };
  auditedClaim.release.auditStatus = "audited";
  expectCode(() => validateManifest(auditedClaim), "CONFIG_HASH_MISMATCH");
});

test("schema parses and frozen ceilings match runtime validation", () => {
  const schema = JSON.parse(readFileSync("schema/deployment-manifest-v1.schema.json", "utf8")) as { properties: { world: { properties: { maxByteGasLimit: { const: number } } }; limits: { properties: Record<string, { const: unknown }> } } };
  assert.equal(schema.properties.world.properties.maxByteGasLimit.const, 1_000_000);
  assert.equal(schema.properties.limits.properties.maxCodeBytes?.const, 16_384);
  assert.equal(schema.properties.limits.properties.maxCallDepth?.const, 32);
  const bad = structuredClone(sample()) as unknown as { limits: { maxCodeBytes: number } };
  bad.limits.maxCodeBytes = 16_383;
  expectCode(() => validateManifest(bad), "CONFIG_HASH_MISMATCH");
});

test("explicit chain observation must match every committed address and code hash", () => {
  const manifest = validateManifest(sample());
  const identities = { poolManager: manifest.poolManager, factory: manifest.factory, referenceRegistry: manifest.referenceRegistry, worldDeployer: manifest.worldDeployer, gasToken: manifest.gasToken, kernel: manifest.kernel, hook: manifest.hook, router: manifest.router, kernelCreationCodeStore: manifest.artifactStores.kernelCreationCode, hookCreationCodeStore: manifest.artifactStores.hookCreationCode };
  const codeObservation = Object.fromEntries(Object.entries(identities).map(([name, item]) => [name, { address: item.address, extcodehash: item.extcodehash }]));
  const observation: DeploymentObservation = { chainId: manifest.chainId, worldId: manifest.world.worldId, worldConfigHash: manifest.worldConfigHash, blockHash: manifest.deployment.blockHash, blockNumber: manifest.deployment.blockNumber, txHash: manifest.deployment.txHash, sealed: true, treeCommitment: manifest.integrity.treeCommitment, artifactCommitment: manifest.integrity.artifactCommitment, compilerHash: manifest.compiler.hash, referencePrograms: manifest.referencePrograms, artifactPayloads: { kernelCreationCode: manifest.artifactStores.kernelCreationCode.payloadHash, hookCreationCode: manifest.artifactStores.hookCreationCode.payloadHash }, code: codeObservation };
  verifyObservation(manifest, observation);
  const bad = structuredClone(observation) as DeploymentObservation & { code: Record<string, { address: Address; extcodehash: Bytes32 }> }; bad.code.kernel!.extcodehash = hash(999);
  expectCode(() => verifyObservation(manifest, bad), "OBSERVATION_MISMATCH");
  for (const mutate of [
    (item: Record<string, unknown>) => { item.txHash = hash(900); },
    (item: Record<string, unknown>) => { item.blockHash = hash(901); },
    (item: Record<string, unknown>) => { item.treeCommitment = hash(902); },
    (item: Record<string, unknown>) => { item.artifactCommitment = hash(903); },
    (item: Record<string, unknown>) => { item.compilerHash = hash(904); }
  ]) {
    const changed = structuredClone(observation) as unknown as Record<string, unknown>; mutate(changed);
    expectCode(() => verifyObservation(manifest, changed as unknown as DeploymentObservation), "OBSERVATION_MISMATCH");
  }
  const payloadDrift = structuredClone(observation) as DeploymentObservation & { artifactPayloads: { kernelCreationCode: Bytes32; hookCreationCode: Bytes32 } };
  payloadDrift.artifactPayloads.kernelCreationCode = hash(905);
  expectCode(() => verifyObservation(manifest, payloadDrift), "OBSERVATION_MISMATCH");
});

test("manifest publication rejects high-s, bad-v and self-referential signature mutations", () => {
  const privateKey = new Uint8Array(32); privateKey[31] = 9;
  const signed = attachEip191Signature(sample(), privateKey);
  const raw = signed.integrity.signature!.signature.slice(2);
  const r = raw.slice(0, 64); const s = BigInt(`0x${raw.slice(64, 128)}`);
  const order = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  const highS = (order - s).toString(16).padStart(64, "0");
  const high = structuredClone(signed) as unknown as { integrity: { signature: { signature: string } } };
  high.integrity.signature.signature = `0x${r}${highS}${raw.slice(128)}`;
  expectCode(() => validateManifest(high), "SIGNATURE_INVALID");
  const badV = structuredClone(signed) as unknown as { integrity: { signature: { signature: string } } };
  badV.integrity.signature.signature = `0x${raw.slice(0, 128)}00`;
  expectCode(() => validateManifest(badV), "SIGNATURE_INVALID");
  const selfReference = structuredClone(signed) as unknown as { integrity: Record<string, unknown> };
  selfReference.integrity.signatureHash = hash(999);
  expectCode(() => validateManifest(selfReference), "FORBIDDEN_FIELD");
});
