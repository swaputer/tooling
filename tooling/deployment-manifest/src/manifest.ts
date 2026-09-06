import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalJson, keccakHex, keccakUtf8 } from "./canonical.js";
import { ManifestError } from "./errors.js";
import type {
  Address,
  Bytes32,
  CodeIdentity,
  DeploymentManifest,
  DeploymentObservation,
  DeploymentSignature,
  Hex,
  PoolKeyManifest
} from "./types.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX65 = /^0x[0-9a-fA-F]{130}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const ISA_HASH_BY_PROTOCOL = Object.freeze({
  "1.1": "0x2f0059846af771cb9f77e74d5f728744a9b8dbe69313d146b8a5e7fdcbe7c118",
  "1.2": "0x5958f1a3baf744e5ed92f096a964ee14779db2e32e70a2982c53080eb3cd92c2"
} as const);
const VM_VERSION_BY_PROTOCOL = Object.freeze({ "1.1": 1, "1.2": 2 } as const);
const WORLD_CONFIG_TYPE = "SwapVMWorldConfigV1(uint256 chainId,address factory,address poolManager,bytes32 poolManagerCodeHash,address router,address referenceRegistry,bytes32 worldId,address worldDeployer,address gasToken,address kernel,address hook,uint256 initialSupply,address initialHolder,bytes32 distributionCommitment,uint128 byteGasPrice,uint24 poolFee,int24 tickSpacing,uint160 initialSqrtPriceX96,bytes32 gasTokenCodeHash,bytes32 kernelCodeHash,bytes32 hookCodeHash)";

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ManifestError("INVALID_TYPE", path, "expected object");
  }
  return value as Record<string, unknown>;
}

function field(input: Record<string, unknown>, name: string, path: string): unknown {
  if (!(name in input)) throw new ManifestError("MISSING_FIELD", `${path}.${name}`, "required field is missing");
  return input[name];
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!expected.has(key)) throw new ManifestError("FORBIDDEN_FIELD", `${path}.${key}`, "field is not part of schema v1");
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ManifestError("INVALID_TYPE", path, "expected string");
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ManifestError("INVALID_INTEGER", path, "expected safe integer in range");
  }
  return value;
}

function address(value: unknown, path: string): Address {
  const output = string(value, path);
  if (!ADDRESS.test(output)) throw new ManifestError("INVALID_HEX", path, "expected 20-byte address");
  return output.toLowerCase() as Address;
}

function bytes32(value: unknown, path: string): Bytes32 {
  const output = string(value, path);
  if (!BYTES32.test(output)) throw new ManifestError("INVALID_HEX", path, "expected bytes32");
  return output.toLowerCase() as Bytes32;
}

function decimal(value: unknown, path: string): string {
  const output = string(value, path);
  if (!/^(0|[1-9][0-9]*)$/.test(output) || BigInt(output) > UINT256_MAX) {
    throw new ManifestError("INVALID_INTEGER", path, "expected canonical uint256 decimal string");
  }
  return output;
}

function codeIdentity(value: unknown, path: string, extras: readonly string[] = []): CodeIdentity {
  const input = object(value, path);
  exactKeys(input, ["address", "extcodehash", "runtimeCodeHash", ...extras], path);
  return Object.freeze({
    address: address(field(input, "address", path), `${path}.address`),
    extcodehash: bytes32(field(input, "extcodehash", path), `${path}.extcodehash`),
    runtimeCodeHash: bytes32(field(input, "runtimeCodeHash", path), `${path}.runtimeCodeHash`)
  });
}

function word(value: bigint): Uint8Array {
  if (value < 0n || value > UINT256_MAX) throw new ManifestError("INVALID_INTEGER", "$", "ABI word out of range");
  const output = new Uint8Array(32);
  for (let i = 31; i >= 0; --i) {
    output[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return output;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function addressWord(value: Address): Uint8Array {
  return word(BigInt(value));
}

function bytes32Word(value: Bytes32): Uint8Array {
  return hexBytes(value);
}

function signedWord(value: number): Uint8Array {
  return word(value < 0 ? (1n << 256n) + BigInt(value) : BigInt(value));
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.length; }
  return output;
}

export function computeWorldId(poolKey: PoolKeyManifest): Bytes32 {
  if (poolKey.currency0 !== "ETH") throw new ManifestError("INVALID_TYPE", "$.world.poolKey.currency0", "must be ETH");
  if (poolKey.fee < 0 || poolKey.fee > 0xffffff) throw new ManifestError("INVALID_INTEGER", "$.world.poolKey.fee", "uint24 out of range");
  if (poolKey.tickSpacing < -0x800000 || poolKey.tickSpacing > 0x7fffff) throw new ManifestError("INVALID_INTEGER", "$.world.poolKey.tickSpacing", "int24 out of range");
  return keccakHex(concat(word(0n), addressWord(poolKey.currency1), word(BigInt(poolKey.fee)), signedWord(poolKey.tickSpacing), addressWord(poolKey.hooks)));
}

export function unsignedPayload(manifest: DeploymentManifest): unknown {
  const copy = structuredClone(manifest) as unknown as Record<string, unknown>;
  const integrity = object(copy.integrity, "$.integrity");
  delete integrity.manifestHash;
  delete integrity.signature;
  return copy;
}

export function computeManifestHash(manifest: DeploymentManifest): Bytes32 {
  return keccakHex(new TextEncoder().encode(canonicalJson(unsignedPayload(manifest))));
}

export function computeWorldConfigHash(manifest: DeploymentManifest): Bytes32 {
  const key = manifest.world.poolKey;
  return keccakHex(concat(
    bytes32Word(keccakUtf8(WORLD_CONFIG_TYPE)),
    word(BigInt(manifest.chainId)),
    addressWord(manifest.factory.address),
    addressWord(manifest.poolManager.address),
    bytes32Word(manifest.poolManager.extcodehash),
    addressWord(manifest.router.address),
    addressWord(manifest.referenceRegistry.address),
    bytes32Word(manifest.world.worldId),
    addressWord(manifest.worldDeployer.address),
    addressWord(manifest.gasToken.address),
    addressWord(manifest.kernel.address),
    addressWord(manifest.hook.address),
    word(BigInt(manifest.gasToken.initialSupply)),
    addressWord(manifest.gasToken.initialHolder),
    bytes32Word(manifest.gasToken.distributionCommitment),
    word(BigInt(manifest.world.byteGasPrice)),
    word(BigInt(key.fee)),
    signedWord(key.tickSpacing),
    word(BigInt(manifest.world.initialSqrtPriceX96)),
    bytes32Word(manifest.gasToken.extcodehash),
    bytes32Word(manifest.kernel.extcodehash),
    bytes32Word(manifest.hook.extcodehash)
  ));
}

export function finalizeManifest(value: DeploymentManifest): DeploymentManifest {
  const draft = structuredClone(value) as unknown as DeploymentManifest;
  (draft.world as { worldId: Bytes32 }).worldId = computeWorldId(draft.world.poolKey);
  (draft as { worldConfigHash: Bytes32 }).worldConfigHash = computeWorldConfigHash(draft);
  (draft.integrity as { manifestHash: Bytes32; signature: null }).signature = null;
  (draft.integrity as { manifestHash: Bytes32 }).manifestHash = computeManifestHash(draft);
  return validateManifest(draft);
}

export function attachEip191Signature(manifest: DeploymentManifest, privateKey: Uint8Array): DeploymentManifest {
  const finalized = finalizeManifest(manifest);
  const signed = structuredClone(finalized) as unknown as DeploymentManifest;
  (signed.integrity as { signature: DeploymentSignature | null }).signature = signEip191(finalized, privateKey);
  return validateManifest(signed);
}

export function validateManifest(value: unknown): DeploymentManifest {
  const root = object(value, "$");
  exactKeys(root, ["schemaVersion", "protocolVersion", "release", "chainId", "worldConfigHash", "poolManager", "factory", "referenceRegistry", "worldDeployer", "artifactStores", "world", "gasToken", "kernel", "hook", "router", "limits", "referencePrograms", "compiler", "deployment", "integrity"], "$");
  const protocolVersion = field(root, "protocolVersion", "$");
  if (
    field(root, "schemaVersion", "$") !== "1"
      || (protocolVersion !== "1.1" && protocolVersion !== "1.2")
  ) {
    throw new ManifestError("UNSUPPORTED_SCHEMA", "$", "expected schema 1 and protocol 1.1 or 1.2");
  }
  const worldInput = object(field(root, "world", "$"), "$.world");
  const releaseInput = object(field(root, "release", "$"), "$.release");
  exactKeys(releaseInput, ["environment", "auditStatus", "auditCandidateTag", "auditCandidateCommit", "economicValue", "publicMainnetDeploymentAllowed", "auditedReleaseArtifact"], "$.release");
  const environment = string(field(releaseInput, "environment", "$.release"), "$.release.environment");
  if (
    (environment !== "local" && environment !== "testnet")
      || field(releaseInput, "auditStatus", "$.release") !== "unaudited"
      || field(releaseInput, "auditCandidateTag", "$.release") !== "swaputer-v1.1-stage7c-rc2"
      || field(releaseInput, "auditCandidateCommit", "$.release") !== "afa54c2e02e7e91430b14b6884faff5e3f5867d9"
      || field(releaseInput, "economicValue", "$.release") !== "none"
      || field(releaseInput, "publicMainnetDeploymentAllowed", "$.release") !== false
      || field(releaseInput, "auditedReleaseArtifact", "$.release") !== null
  ) throw new ManifestError("CONFIG_HASH_MISMATCH", "$.release", "Stage 7D-U1 manifests must be unaudited zero-value local/testnet releases");
  exactKeys(worldInput, ["poolKey", "worldId", "byteGasPrice", "maxByteGasLimit", "initialSqrtPriceX96", "sealed", "sealedAtBlock"], "$.world");
  const poolInput = object(field(worldInput, "poolKey", "$.world"), "$.world.poolKey");
  exactKeys(poolInput, ["currency0", "currency1", "fee", "tickSpacing", "hooks"], "$.world.poolKey");
  const poolKey: PoolKeyManifest = Object.freeze({
    currency0: string(field(poolInput, "currency0", "$.world.poolKey"), "$.world.poolKey.currency0") as "ETH",
    currency1: address(field(poolInput, "currency1", "$.world.poolKey"), "$.world.poolKey.currency1"),
    fee: integer(field(poolInput, "fee", "$.world.poolKey"), "$.world.poolKey.fee"),
    tickSpacing: integer(field(poolInput, "tickSpacing", "$.world.poolKey"), "$.world.poolKey.tickSpacing", -0x800000),
    hooks: address(field(poolInput, "hooks", "$.world.poolKey"), "$.world.poolKey.hooks")
  });
  const gasInput = object(field(root, "gasToken", "$"), "$.gasToken");
  const routerInput = object(field(root, "router", "$"), "$.router");
  const storesInput = object(field(root, "artifactStores", "$"), "$.artifactStores");
  const kernelStoreInput = object(field(storesInput, "kernelCreationCode", "$.artifactStores"), "$.artifactStores.kernelCreationCode");
  const hookStoreInput = object(field(storesInput, "hookCreationCode", "$.artifactStores"), "$.artifactStores.hookCreationCode");
  const limitsInput = object(field(root, "limits", "$"), "$.limits");
  const refsInput = object(field(root, "referencePrograms", "$"), "$.referencePrograms");
  const compilerInput = object(field(root, "compiler", "$"), "$.compiler");
  const deploymentInput = object(field(root, "deployment", "$"), "$.deployment");
  const integrityInput = object(field(root, "integrity", "$"), "$.integrity");
  exactKeys(gasInput, ["address", "extcodehash", "runtimeCodeHash", "decimals", "initialSupply", "initialHolder", "distributionCommitment"], "$.gasToken");
  exactKeys(routerInput, ["address", "extcodehash", "runtimeCodeHash", "supportsCanonicalVMInput", "supportsSignedVm"], "$.router");
  exactKeys(storesInput, ["kernelCreationCode", "hookCreationCode"], "$.artifactStores");
  exactKeys(kernelStoreInput, ["address", "extcodehash", "runtimeCodeHash", "payloadHash"], "$.artifactStores.kernelCreationCode");
  exactKeys(hookStoreInput, ["address", "extcodehash", "runtimeCodeHash", "payloadHash"], "$.artifactStores.hookCreationCode");
  exactKeys(limitsInput, ["vmVersion", "receiptVersion", "isaHash", "maxCodeBytes", "maxStackWords", "maxMemoryBytes", "maxCallDepth", "maxReceiptPayloadBytes"], "$.limits");
  exactKeys(refsInput, ["src20", "src721", "src1155", "cpamm"], "$.referencePrograms");
  exactKeys(compilerInput, ["name", "version", "hash"], "$.compiler");
  exactKeys(deploymentInput, ["blockHash", "blockNumber", "txHash", "factoryAddress", "routerAddress", "factoryEventTxIndex"], "$.deployment");
  exactKeys(integrityInput, ["sourceControlCommit", "treeCommitment", "artifactCommitment", "specKeccak256", "isaKeccak256", "manifestHash", "signature"], "$.integrity");
  const signatureInput = field(integrityInput, "signature", "$.integrity");
  let signature: DeploymentSignature | null = null;
  if (signatureInput !== null) {
    const item = object(signatureInput, "$.integrity.signature");
    exactKeys(item, ["signer", "algorithm", "message", "signature"], "$.integrity.signature");
    const signatureHex = string(field(item, "signature", "$.integrity.signature"), "$.integrity.signature.signature");
    if (!HEX65.test(signatureHex)) throw new ManifestError("INVALID_HEX", "$.integrity.signature.signature", "expected 65-byte signature");
    signature = Object.freeze({
      signer: address(field(item, "signer", "$.integrity.signature"), "$.integrity.signature.signer"),
      algorithm: string(field(item, "algorithm", "$.integrity.signature"), "$.integrity.signature.algorithm") as "EIP-191",
      message: bytes32(field(item, "message", "$.integrity.signature"), "$.integrity.signature.message"),
      signature: signatureHex.toLowerCase() as Hex
    });
    if (signature.algorithm !== "EIP-191") throw new ManifestError("SIGNATURE_INVALID", "$.integrity.signature.algorithm", "only EIP-191 is supported");
  }
  const chainId = integer(field(root, "chainId", "$"), "$.chainId", 1);
  const manifest = {
    schemaVersion: "1", protocolVersion,
    release: Object.freeze({ environment: environment as "local" | "testnet", auditStatus: "unaudited" as const, auditCandidateTag: "swaputer-v1.1-stage7c-rc2" as const, auditCandidateCommit: "afa54c2e02e7e91430b14b6884faff5e3f5867d9" as const, economicValue: "none" as const, publicMainnetDeploymentAllowed: false as const, auditedReleaseArtifact: null }),
    chainId,
    worldConfigHash: bytes32(field(root, "worldConfigHash", "$"), "$.worldConfigHash"),
    poolManager: codeIdentity(field(root, "poolManager", "$"), "$.poolManager"),
    factory: codeIdentity(field(root, "factory", "$"), "$.factory"),
    referenceRegistry: codeIdentity(field(root, "referenceRegistry", "$"), "$.referenceRegistry"),
    worldDeployer: codeIdentity(field(root, "worldDeployer", "$"), "$.worldDeployer"),
    artifactStores: Object.freeze({
      kernelCreationCode: Object.freeze({ ...codeIdentity(kernelStoreInput, "$.artifactStores.kernelCreationCode", ["payloadHash"]), payloadHash: bytes32(field(kernelStoreInput, "payloadHash", "$.artifactStores.kernelCreationCode"), "$.artifactStores.kernelCreationCode.payloadHash") }),
      hookCreationCode: Object.freeze({ ...codeIdentity(hookStoreInput, "$.artifactStores.hookCreationCode", ["payloadHash"]), payloadHash: bytes32(field(hookStoreInput, "payloadHash", "$.artifactStores.hookCreationCode"), "$.artifactStores.hookCreationCode.payloadHash") })
    }),
    world: Object.freeze({
      poolKey, worldId: bytes32(field(worldInput, "worldId", "$.world"), "$.world.worldId"),
      byteGasPrice: decimal(field(worldInput, "byteGasPrice", "$.world"), "$.world.byteGasPrice"),
      maxByteGasLimit: integer(field(worldInput, "maxByteGasLimit", "$.world"), "$.world.maxByteGasLimit", 1),
      initialSqrtPriceX96: decimal(field(worldInput, "initialSqrtPriceX96", "$.world"), "$.world.initialSqrtPriceX96"),
      sealed: field(worldInput, "sealed", "$.world") as true,
      sealedAtBlock: integer(field(worldInput, "sealedAtBlock", "$.world"), "$.world.sealedAtBlock")
    }),
    gasToken: Object.freeze({ ...codeIdentity(gasInput, "$.gasToken", ["decimals", "initialSupply", "initialHolder", "distributionCommitment"]), decimals: integer(field(gasInput, "decimals", "$.gasToken"), "$.gasToken.decimals") as 18, initialSupply: decimal(field(gasInput, "initialSupply", "$.gasToken"), "$.gasToken.initialSupply"), initialHolder: address(field(gasInput, "initialHolder", "$.gasToken"), "$.gasToken.initialHolder"), distributionCommitment: bytes32(field(gasInput, "distributionCommitment", "$.gasToken"), "$.gasToken.distributionCommitment") }),
    kernel: codeIdentity(field(root, "kernel", "$"), "$.kernel"), hook: codeIdentity(field(root, "hook", "$"), "$.hook"),
    router: Object.freeze({ ...codeIdentity(routerInput, "$.router", ["supportsCanonicalVMInput", "supportsSignedVm"]), supportsCanonicalVMInput: field(routerInput, "supportsCanonicalVMInput", "$.router") as true, supportsSignedVm: field(routerInput, "supportsSignedVm", "$.router") as true }),
    limits: Object.freeze({ vmVersion: integer(field(limitsInput, "vmVersion", "$.limits"), "$.limits.vmVersion") as 1 | 2, receiptVersion: integer(field(limitsInput, "receiptVersion", "$.limits"), "$.limits.receiptVersion") as 1, isaHash: bytes32(field(limitsInput, "isaHash", "$.limits"), "$.limits.isaHash"), maxCodeBytes: integer(field(limitsInput, "maxCodeBytes", "$.limits"), "$.limits.maxCodeBytes", 1), maxStackWords: integer(field(limitsInput, "maxStackWords", "$.limits"), "$.limits.maxStackWords", 1), maxMemoryBytes: integer(field(limitsInput, "maxMemoryBytes", "$.limits"), "$.limits.maxMemoryBytes", 1), maxCallDepth: integer(field(limitsInput, "maxCallDepth", "$.limits"), "$.limits.maxCallDepth", 1), maxReceiptPayloadBytes: integer(field(limitsInput, "maxReceiptPayloadBytes", "$.limits"), "$.limits.maxReceiptPayloadBytes", 1) }),
    referencePrograms: Object.freeze({ src20: bytes32(field(refsInput, "src20", "$.referencePrograms"), "$.referencePrograms.src20"), src721: bytes32(field(refsInput, "src721", "$.referencePrograms"), "$.referencePrograms.src721"), src1155: bytes32(field(refsInput, "src1155", "$.referencePrograms"), "$.referencePrograms.src1155"), cpamm: bytes32(field(refsInput, "cpamm", "$.referencePrograms"), "$.referencePrograms.cpamm") }),
    compiler: Object.freeze({ name: string(field(compilerInput, "name", "$.compiler"), "$.compiler.name"), version: string(field(compilerInput, "version", "$.compiler"), "$.compiler.version"), hash: bytes32(field(compilerInput, "hash", "$.compiler"), "$.compiler.hash") }),
    deployment: Object.freeze({ blockHash: bytes32(field(deploymentInput, "blockHash", "$.deployment"), "$.deployment.blockHash"), blockNumber: integer(field(deploymentInput, "blockNumber", "$.deployment"), "$.deployment.blockNumber"), txHash: bytes32(field(deploymentInput, "txHash", "$.deployment"), "$.deployment.txHash"), factoryAddress: address(field(deploymentInput, "factoryAddress", "$.deployment"), "$.deployment.factoryAddress"), routerAddress: address(field(deploymentInput, "routerAddress", "$.deployment"), "$.deployment.routerAddress"), factoryEventTxIndex: integer(field(deploymentInput, "factoryEventTxIndex", "$.deployment"), "$.deployment.factoryEventTxIndex") }),
    integrity: Object.freeze({ sourceControlCommit: string(field(integrityInput, "sourceControlCommit", "$.integrity"), "$.integrity.sourceControlCommit"), treeCommitment: bytes32(field(integrityInput, "treeCommitment", "$.integrity"), "$.integrity.treeCommitment"), artifactCommitment: bytes32(field(integrityInput, "artifactCommitment", "$.integrity"), "$.integrity.artifactCommitment"), specKeccak256: bytes32(field(integrityInput, "specKeccak256", "$.integrity"), "$.integrity.specKeccak256"), isaKeccak256: bytes32(field(integrityInput, "isaKeccak256", "$.integrity"), "$.integrity.isaKeccak256"), manifestHash: bytes32(field(integrityInput, "manifestHash", "$.integrity"), "$.integrity.manifestHash"), signature })
  } as const satisfies DeploymentManifest;
  if (manifest.world.sealed !== true || manifest.gasToken.decimals !== 18 || manifest.router.supportsCanonicalVMInput !== true || manifest.router.supportsSignedVm !== true || manifest.limits.vmVersion !== VM_VERSION_BY_PROTOCOL[manifest.protocolVersion] || manifest.limits.receiptVersion !== 1) throw new ManifestError("INVALID_TYPE", "$", "frozen manifest constants mismatch");
  if (manifest.world.maxByteGasLimit !== 1_000_000 || manifest.limits.isaHash !== ISA_HASH_BY_PROTOCOL[manifest.protocolVersion] || manifest.limits.maxCodeBytes !== 16_384 || manifest.limits.maxStackWords !== 1_024 || manifest.limits.maxMemoryBytes !== 65_536 || manifest.limits.maxCallDepth !== 32 || manifest.limits.maxReceiptPayloadBytes !== 65_536) throw new ManifestError("CONFIG_HASH_MISMATCH", "$.limits", "frozen ceilings or protocol ISA hash mismatch");
  if (BigInt(manifest.world.byteGasPrice) > UINT128_MAX || BigInt(manifest.world.initialSqrtPriceX96) > UINT160_MAX) throw new ManifestError("INVALID_INTEGER", "$.world", "onchain integer width exceeded");
  if (BigInt(manifest.world.byteGasPrice) === 0n || BigInt(manifest.gasToken.initialSupply) === 0n || manifest.gasToken.initialHolder === ZERO_ADDRESS || manifest.gasToken.distributionCommitment === ZERO_BYTES32) throw new ManifestError("CONFIG_HASH_MISMATCH", "$", "zero release parameter is forbidden");
  if (manifest.compiler.name.length === 0 || manifest.compiler.version.length === 0 || manifest.integrity.sourceControlCommit.length === 0) throw new ManifestError("INVALID_TYPE", "$", "release identity strings must be nonempty");
  const identities: readonly [string, CodeIdentity][] = [
    ["poolManager", manifest.poolManager], ["factory", manifest.factory], ["referenceRegistry", manifest.referenceRegistry],
    ["worldDeployer", manifest.worldDeployer], ["gasToken", manifest.gasToken], ["kernel", manifest.kernel],
    ["hook", manifest.hook], ["router", manifest.router],
    ["artifactStores.kernelCreationCode", manifest.artifactStores.kernelCreationCode],
    ["artifactStores.hookCreationCode", manifest.artifactStores.hookCreationCode]
  ];
  for (const [name, identity] of identities) {
    if (identity.extcodehash !== identity.runtimeCodeHash) throw new ManifestError("CONFIG_HASH_MISMATCH", `$.${name}.runtimeCodeHash`, "runtime bytecode hash must equal EXTCODEHASH");
    if (identity.address === ZERO_ADDRESS || identity.extcodehash === ZERO_BYTES32) throw new ManifestError("CONFIG_HASH_MISMATCH", `$.${name}`, "deployed code identity cannot be zero");
  }
  if (manifest.world.poolKey.currency1 !== manifest.gasToken.address) throw new ManifestError("CONFIG_HASH_MISMATCH", "$.world.poolKey.currency1", "must equal gas token address");
  if (manifest.world.poolKey.hooks !== manifest.hook.address) throw new ManifestError("CONFIG_HASH_MISMATCH", "$.world.poolKey.hooks", "must equal hook address");
  if (manifest.deployment.factoryAddress !== manifest.factory.address) throw new ManifestError("CONFIG_HASH_MISMATCH", "$.deployment.factoryAddress", "must equal factory address");
  if (manifest.deployment.routerAddress !== manifest.router.address) throw new ManifestError("CONFIG_HASH_MISMATCH", "$.deployment.routerAddress", "must equal router address");
  if (computeWorldId(manifest.world.poolKey) !== manifest.world.worldId) throw new ManifestError("WORLD_ID_MISMATCH", "$.world.worldId", "PoolKey.toId mismatch");
  if (computeWorldConfigHash(manifest) !== manifest.worldConfigHash) throw new ManifestError("CONFIG_HASH_MISMATCH", "$.worldConfigHash", "onchain config hash mismatch");
  if (computeManifestHash(manifest) !== manifest.integrity.manifestHash) throw new ManifestError("MANIFEST_HASH_MISMATCH", "$.integrity.manifestHash", "canonical manifest hash mismatch");
  if (manifest.integrity.signature !== null) verifyEip191Signature(manifest);
  return Object.freeze(manifest);
}

function eip191Digest(manifestHash: Bytes32): Uint8Array {
  return keccak_256(concat(new TextEncoder().encode("\x19Ethereum Signed Message:\n32"), hexBytes(manifestHash)));
}

export function signEip191(manifest: DeploymentManifest, privateKey: Uint8Array): DeploymentSignature {
  const manifestHash = computeManifestHash(manifest);
  const signature = secp256k1.sign(eip191Digest(manifestHash), privateKey, { lowS: true });
  const compact = signature.toCompactRawBytes();
  const recovery = signature.recovery;
  if (recovery === undefined) throw new ManifestError("SIGNATURE_INVALID", "$.integrity.signature", "missing recovery id");
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const signer = `0x${Buffer.from(keccak_256(publicKey.slice(1)).slice(12)).toString("hex")}` as Address;
  return Object.freeze({ signer, algorithm: "EIP-191", message: manifestHash, signature: `0x${Buffer.from(compact).toString("hex")}${(27 + recovery).toString(16).padStart(2, "0")}` });
}

export function verifyEip191Signature(manifest: DeploymentManifest): void {
  const item = manifest.integrity.signature;
  if (item === null || item.message !== manifest.integrity.manifestHash) throw new ManifestError("SIGNATURE_INVALID", "$.integrity.signature", "signature message mismatch");
  try {
    const raw = hexBytes(item.signature); const recovery = raw[64];
    if (recovery !== 27 && recovery !== 28) throw new Error("bad recovery id");
    const signature = secp256k1.Signature.fromCompact(raw.slice(0, 64));
    if (signature.hasHighS()) throw new Error("high-s signature");
    const publicKey = signature.addRecoveryBit(recovery - 27).recoverPublicKey(eip191Digest(item.message)).toRawBytes(false);
    const recovered = `0x${Buffer.from(keccak_256(publicKey.slice(1)).slice(12)).toString("hex")}`;
    if (recovered !== item.signer.toLowerCase()) throw new Error("signer mismatch");
  } catch (cause) {
    throw new ManifestError("SIGNATURE_INVALID", "$.integrity.signature", cause instanceof Error ? cause.message : "invalid signature");
  }
}

export function verifyObservation(manifest: DeploymentManifest, observation: DeploymentObservation): void {
  const compare = (actual: unknown, expected: unknown, path: string): void => { if (actual !== expected) throw new ManifestError("OBSERVATION_MISMATCH", path, `expected ${String(expected)}, got ${String(actual)}`); };
  compare(observation.chainId, manifest.chainId, "$.chainId"); compare(observation.worldId, manifest.world.worldId, "$.world.worldId"); compare(observation.worldConfigHash, manifest.worldConfigHash, "$.worldConfigHash"); compare(observation.blockHash, manifest.deployment.blockHash, "$.deployment.blockHash"); compare(observation.blockNumber, manifest.deployment.blockNumber, "$.deployment.blockNumber"); compare(observation.txHash, manifest.deployment.txHash, "$.deployment.txHash"); compare(observation.sealed, true, "$.world.sealed");
  compare(observation.treeCommitment, manifest.integrity.treeCommitment, "$.integrity.treeCommitment"); compare(observation.artifactCommitment, manifest.integrity.artifactCommitment, "$.integrity.artifactCommitment"); compare(observation.compilerHash, manifest.compiler.hash, "$.compiler.hash");
  for (const name of ["src20", "src721", "src1155", "cpamm"] as const) compare(observation.referencePrograms[name], manifest.referencePrograms[name], `$.referencePrograms.${name}`);
  compare(observation.artifactPayloads.kernelCreationCode, manifest.artifactStores.kernelCreationCode.payloadHash, "$.artifactStores.kernelCreationCode.payloadHash"); compare(observation.artifactPayloads.hookCreationCode, manifest.artifactStores.hookCreationCode.payloadHash, "$.artifactStores.hookCreationCode.payloadHash");
  const identities: Readonly<Record<string, CodeIdentity>> = { poolManager: manifest.poolManager, factory: manifest.factory, referenceRegistry: manifest.referenceRegistry, worldDeployer: manifest.worldDeployer, gasToken: manifest.gasToken, kernel: manifest.kernel, hook: manifest.hook, router: manifest.router, kernelCreationCodeStore: manifest.artifactStores.kernelCreationCode, hookCreationCodeStore: manifest.artifactStores.hookCreationCode };
  for (const [name, identity] of Object.entries(identities)) { const seen = observation.code[name]; if (seen === undefined) throw new ManifestError("OBSERVATION_MISMATCH", `$.code.${name}`, "observation missing"); compare(seen.address, identity.address, `$.code.${name}.address`); compare(seen.extcodehash, identity.extcodehash, `$.code.${name}.extcodehash`); }
}
