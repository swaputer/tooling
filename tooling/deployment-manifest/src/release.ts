import { keccak_256 } from "@noble/hashes/sha3";

import type { Address, Bytes32, DeploymentManifest } from "./types.js";

export const STAGE7C_RC2_TAG = "swaputer-v1.1-stage7c-rc2";
export const STAGE7C_RC2_COMMIT = "afa54c2e02e7e91430b14b6884faff5e3f5867d9";
export const REQUIRED_HOOK_PERMISSION_BITS = 0x20ccn;
export const HOOK_PERMISSION_MASK = 0x3fffn;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const MIN_SQRT_PRICE_X96 = 4_295_128_739n;
const MAX_SQRT_PRICE_X96 = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;
const KNOWN_MAINNET_CHAIN_IDS = new Set([1, 10, 56, 100, 137, 250, 324, 1101, 8453, 42161, 42220, 43114, 59144, 81457, 534352]);

export type ReleaseErrorCode =
  | "INVALID_RELEASE_CONFIG"
  | "MAINNET_FORBIDDEN"
  | "UNAUDITED_STATUS_REQUIRED"
  | "PLACEHOLDERS_PRESENT"
  | "CHAIN_ID_MISMATCH"
  | "POOL_MANAGER_MISMATCH"
  | "ARTIFACT_MISMATCH"
  | "STORE_COMMITMENT_MISMATCH"
  | "PREDICTION_MISMATCH"
  | "HOOK_PERMISSION_MISMATCH"
  | "SALT_COLLISION"
  | "PARAMETER_OUT_OF_RANGE"
  | "MANIFEST_RELEASE_MISMATCH"
  | "WORLD_STATE_INVALID";

export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;
  readonly path: string;

  constructor(code: ReleaseErrorCode, path: string, message: string) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
    this.path = path;
  }

  toJSON(): Readonly<{ code: ReleaseErrorCode; path: string }> {
    return Object.freeze({ code: this.code, path: this.path });
  }
}

export interface ExperimentalReleaseStatus {
  readonly auditStatus: "unaudited";
  readonly auditCandidateTag: typeof STAGE7C_RC2_TAG;
  readonly auditCandidateCommit: typeof STAGE7C_RC2_COMMIT;
  readonly economicValue: "none";
  readonly publicMainnetDeploymentAllowed: false;
}

interface StoreConfig {
  readonly address: Address;
  readonly runtimeCodeHash: Bytes32;
  readonly payloadHash: Bytes32;
}

export interface TestnetReleaseConfig {
  readonly schemaVersion: "1";
  readonly environment: "local" | "testnet";
  readonly releaseStatus: ExperimentalReleaseStatus;
  readonly chainId: number;
  readonly networkName: string;
  readonly poolManager: Readonly<{ address: Address; expectedExtcodehash: Bytes32 }>;
  readonly factory: Readonly<{
    address: Address;
    kernelCreationCodeStore: StoreConfig;
    hookCreationCodeStore: StoreConfig;
    artifactHashes: Readonly<{
      factoryCreationCode: Bytes32;
      factoryRuntime: Bytes32;
      routerRuntime: Bytes32;
      gasTokenCreationCode: Bytes32;
      gasTokenRuntime: Bytes32;
      kernelCreationCode: Bytes32;
      kernelRuntime: Bytes32;
      hookCreationCode: Bytes32;
      hookRuntime: Bytes32;
      worldDeployerCreationCode: Bytes32;
      worldDeployerRuntime: Bytes32;
      referenceRegistryRuntime: Bytes32;
    }>;
    initCodeHashes: Readonly<{ gasToken: Bytes32; worldDeployer: Bytes32; hook: Bytes32 }>;
  }>;
  readonly vm: Readonly<{ byteGasPrice: string; maxByteGasLimit: number }>;
  readonly token: Readonly<{
    initialSupply: string;
    initialHolder: Address;
    distributionCommitment: Bytes32;
    decimals: 18;
  }>;
  readonly pool: Readonly<{ fee: number; tickSpacing: number; initialSqrtPriceX96: string }>;
  readonly salts: Readonly<{ tokenSalt: Bytes32; bootstrapSalt: Bytes32; hookSalt: Bytes32 }>;
  readonly predicted: Readonly<{ worldDeployer: Address; kernel: Address; hook: Address; token: Address }>;
  readonly liquidityPlan: Readonly<{
    description: string;
    maximumProjectToken: string;
    maximumProjectNativeWei: string;
    thirdPartyFundsAllowed: false;
  }>;
  readonly finality: Readonly<{ confirmations: number; maximumReorgDepth: number; pollIntervalSeconds: number }>;
  readonly rpcEnvironmentVariables: readonly string[];
  readonly manifestPublisher: string;
  readonly containsPlaceholders: boolean;
}

export interface ReleaseObservation {
  readonly chainId: number;
  readonly poolManager: Readonly<{ address: Address; extcodehash: Bytes32 }>;
  readonly code: Readonly<Record<string, Readonly<{ address: Address; extcodehash: Bytes32 }>>>;
  readonly occupiedAddresses: readonly Address[];
}

export interface ArtifactInventory {
  readonly contracts: Readonly<Record<string, Readonly<{
    creationCodeHash: Bytes32;
    deployedRuntimeCodeHash: Bytes32;
  }>>>;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseError("INVALID_RELEASE_CONFIG", path, "expected object");
  }
  return value as Record<string, unknown>;
}

function exact(input: Record<string, unknown>, names: readonly string[], path: string): void {
  const allowed = new Set(names);
  for (const name of names) if (!(name in input)) throw new ReleaseError("INVALID_RELEASE_CONFIG", `${path}.${name}`, "missing field");
  for (const name of Object.keys(input)) if (!allowed.has(name)) throw new ReleaseError("INVALID_RELEASE_CONFIG", `${path}.${name}`, "unknown field");
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ReleaseError("INVALID_RELEASE_CONFIG", path, "expected non-empty string");
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ReleaseError("INVALID_RELEASE_CONFIG", path, "expected safe integer");
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ReleaseError("INVALID_RELEASE_CONFIG", path, "expected boolean");
  return value;
}

function address(value: unknown, path: string): Address {
  const output = stringValue(value, path);
  if (!ADDRESS.test(output) || BigInt(output) === 0n) throw new ReleaseError("INVALID_RELEASE_CONFIG", path, "expected nonzero address");
  return output.toLowerCase() as Address;
}

function bytes32(value: unknown, path: string): Bytes32 {
  const output = stringValue(value, path);
  if (!BYTES32.test(output) || BigInt(output) === 0n) throw new ReleaseError("INVALID_RELEASE_CONFIG", path, "expected nonzero bytes32");
  return output.toLowerCase() as Bytes32;
}

function decimal(value: unknown, path: string): string {
  const output = stringValue(value, path);
  if (!/^(0|[1-9][0-9]*)$/.test(output) || BigInt(output) > UINT256_MAX) {
    throw new ReleaseError("INVALID_RELEASE_CONFIG", path, "expected canonical uint256 decimal");
  }
  return output;
}

function codeIdentity(value: unknown, path: string): { address: Address; expectedExtcodehash: Bytes32 } {
  const input = object(value, path);
  exact(input, ["address", "expectedExtcodehash"], path);
  return { address: address(input.address, `${path}.address`), expectedExtcodehash: bytes32(input.expectedExtcodehash, `${path}.expectedExtcodehash`) };
}

function store(value: unknown, path: string): StoreConfig {
  const input = object(value, path);
  exact(input, ["address", "runtimeCodeHash", "payloadHash"], path);
  return Object.freeze({
    address: address(input.address, `${path}.address`),
    runtimeCodeHash: bytes32(input.runtimeCodeHash, `${path}.runtimeCodeHash`),
    payloadHash: bytes32(input.payloadHash, `${path}.payloadHash`)
  });
}

function hashObject(input: Record<string, unknown>, names: readonly string[], path: string): Record<string, Bytes32> {
  exact(input, names, path);
  return Object.fromEntries(names.map((name) => [name, bytes32(input[name], `${path}.${name}`)]));
}

export function validateTestnetReleaseConfig(value: unknown): TestnetReleaseConfig {
  const root = object(value, "$" as string);
  exact(root, ["schemaVersion", "environment", "releaseStatus", "chainId", "networkName", "poolManager", "factory", "vm", "token", "pool", "salts", "predicted", "liquidityPlan", "finality", "rpcEnvironmentVariables", "manifestPublisher", "containsPlaceholders"], "$");
  if (root.schemaVersion !== "1" || (root.environment !== "local" && root.environment !== "testnet")) {
    throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.environment", "only local or testnet schema v1 is supported");
  }
  const chainId = integer(root.chainId, "$.chainId", 1);
  if (KNOWN_MAINNET_CHAIN_IDS.has(chainId)) throw new ReleaseError("MAINNET_FORBIDDEN", "$.chainId", "known mainnet chain id");

  const release = object(root.releaseStatus, "$.releaseStatus");
  exact(release, ["auditStatus", "auditCandidateTag", "auditCandidateCommit", "economicValue", "publicMainnetDeploymentAllowed"], "$.releaseStatus");
  if (release.auditStatus !== "unaudited" || release.auditCandidateTag !== STAGE7C_RC2_TAG || release.auditCandidateCommit !== STAGE7C_RC2_COMMIT || release.economicValue !== "none" || release.publicMainnetDeploymentAllowed !== false) {
    throw new ReleaseError("UNAUDITED_STATUS_REQUIRED", "$.releaseStatus", "Stage 7D-U1 must remain unaudited and zero-value");
  }

  const factory = object(root.factory, "$.factory");
  exact(factory, ["address", "kernelCreationCodeStore", "hookCreationCodeStore", "artifactHashes", "initCodeHashes"], "$.factory");
  const artifactNames = ["factoryCreationCode", "factoryRuntime", "routerRuntime", "gasTokenCreationCode", "gasTokenRuntime", "kernelCreationCode", "kernelRuntime", "hookCreationCode", "hookRuntime", "worldDeployerCreationCode", "worldDeployerRuntime", "referenceRegistryRuntime"] as const;
  const artifacts = hashObject(object(factory.artifactHashes, "$.factory.artifactHashes"), artifactNames, "$.factory.artifactHashes") as TestnetReleaseConfig["factory"]["artifactHashes"];
  const initHashes = hashObject(object(factory.initCodeHashes, "$.factory.initCodeHashes"), ["gasToken", "worldDeployer", "hook"], "$.factory.initCodeHashes") as TestnetReleaseConfig["factory"]["initCodeHashes"];

  const vm = object(root.vm, "$.vm"); exact(vm, ["byteGasPrice", "maxByteGasLimit"], "$.vm");
  const token = object(root.token, "$.token"); exact(token, ["initialSupply", "initialHolder", "distributionCommitment", "decimals"], "$.token");
  const pool = object(root.pool, "$.pool"); exact(pool, ["fee", "tickSpacing", "initialSqrtPriceX96"], "$.pool");
  const salts = object(root.salts, "$.salts"); exact(salts, ["tokenSalt", "bootstrapSalt", "hookSalt"], "$.salts");
  const predicted = object(root.predicted, "$.predicted"); exact(predicted, ["worldDeployer", "kernel", "hook", "token"], "$.predicted");
  const liquidity = object(root.liquidityPlan, "$.liquidityPlan"); exact(liquidity, ["description", "maximumProjectToken", "maximumProjectNativeWei", "thirdPartyFundsAllowed"], "$.liquidityPlan");
  const finality = object(root.finality, "$.finality"); exact(finality, ["confirmations", "maximumReorgDepth", "pollIntervalSeconds"], "$.finality");
  const rpcNames = root.rpcEnvironmentVariables;
  if (!Array.isArray(rpcNames) || rpcNames.length === 0 || rpcNames.some((item) => typeof item !== "string" || !ENVIRONMENT_NAME.test(item)) || new Set(rpcNames).size !== rpcNames.length) {
    throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.rpcEnvironmentVariables", "expected unique environment variable names");
  }
  if (token.decimals !== 18 || liquidity.thirdPartyFundsAllowed !== false) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.token", "fixed token/funding policy violated");

  return Object.freeze({
    schemaVersion: "1",
    environment: root.environment,
    releaseStatus: Object.freeze({ auditStatus: "unaudited", auditCandidateTag: STAGE7C_RC2_TAG, auditCandidateCommit: STAGE7C_RC2_COMMIT, economicValue: "none", publicMainnetDeploymentAllowed: false }),
    chainId,
    networkName: stringValue(root.networkName, "$.networkName"),
    poolManager: Object.freeze(codeIdentity(root.poolManager, "$.poolManager")),
    factory: Object.freeze({ address: address(factory.address, "$.factory.address"), kernelCreationCodeStore: store(factory.kernelCreationCodeStore, "$.factory.kernelCreationCodeStore"), hookCreationCodeStore: store(factory.hookCreationCodeStore, "$.factory.hookCreationCodeStore"), artifactHashes: Object.freeze(artifacts), initCodeHashes: Object.freeze(initHashes) }),
    vm: Object.freeze({ byteGasPrice: decimal(vm.byteGasPrice, "$.vm.byteGasPrice"), maxByteGasLimit: integer(vm.maxByteGasLimit, "$.vm.maxByteGasLimit", 1) }),
    token: Object.freeze({ initialSupply: decimal(token.initialSupply, "$.token.initialSupply"), initialHolder: address(token.initialHolder, "$.token.initialHolder"), distributionCommitment: bytes32(token.distributionCommitment, "$.token.distributionCommitment"), decimals: 18 }),
    pool: Object.freeze({ fee: integer(pool.fee, "$.pool.fee"), tickSpacing: integer(pool.tickSpacing, "$.pool.tickSpacing", 1), initialSqrtPriceX96: decimal(pool.initialSqrtPriceX96, "$.pool.initialSqrtPriceX96") }),
    salts: Object.freeze({ tokenSalt: bytes32(salts.tokenSalt, "$.salts.tokenSalt"), bootstrapSalt: bytes32(salts.bootstrapSalt, "$.salts.bootstrapSalt"), hookSalt: bytes32(salts.hookSalt, "$.salts.hookSalt") }),
    predicted: Object.freeze({ worldDeployer: address(predicted.worldDeployer, "$.predicted.worldDeployer"), kernel: address(predicted.kernel, "$.predicted.kernel"), hook: address(predicted.hook, "$.predicted.hook"), token: address(predicted.token, "$.predicted.token") }),
    liquidityPlan: Object.freeze({ description: stringValue(liquidity.description, "$.liquidityPlan.description"), maximumProjectToken: decimal(liquidity.maximumProjectToken, "$.liquidityPlan.maximumProjectToken"), maximumProjectNativeWei: decimal(liquidity.maximumProjectNativeWei, "$.liquidityPlan.maximumProjectNativeWei"), thirdPartyFundsAllowed: false }),
    finality: Object.freeze({ confirmations: integer(finality.confirmations, "$.finality.confirmations"), maximumReorgDepth: integer(finality.maximumReorgDepth, "$.finality.maximumReorgDepth", 1), pollIntervalSeconds: integer(finality.pollIntervalSeconds, "$.finality.pollIntervalSeconds", 1) }),
    rpcEnvironmentVariables: Object.freeze([...rpcNames] as string[]),
    manifestPublisher: stringValue(root.manifestPublisher, "$.manifestPublisher"),
    containsPlaceholders: booleanValue(root.containsPlaceholders, "$.containsPlaceholders")
  });
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function hashHex(value: Uint8Array): Bytes32 {
  return `0x${Buffer.from(keccak_256(value)).toString("hex")}` as Bytes32;
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.length; }
  return output;
}

export function predictCreate2(deployer: Address, salt: Bytes32, initCodeHash: Bytes32): Address {
  const digest = hashHex(concat(Uint8Array.of(0xff), hexBytes(deployer), hexBytes(salt), hexBytes(initCodeHash)));
  return `0x${digest.slice(-40)}` as Address;
}

export function predictFirstCreate(deployer: Address): Address {
  const digest = hashHex(concat(Uint8Array.of(0xd6, 0x94), hexBytes(deployer), Uint8Array.of(0x01)));
  return `0x${digest.slice(-40)}` as Address;
}

function same(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }

const LEGACY_ARTIFACT_ALIASES: Readonly<Record<string, string>> = {
  SwaputerWorldFactory: "SwapVMWorldFactory",
  SwaputerAppRouter: "SwapVMRouter",
  SwaputerToken: "SwapVMGasToken",
  SwaputerKernel: "SwapVMKernel",
  SwaputerHook: "SwapVMHook",
  SwaputerWorldDeployer: "SwapVMWorldDeployer",
  SwaputerProgramRegistry: "SwapVMReferenceRegistry"
};

function artifact(inventory: ArtifactInventory, name: string): ArtifactInventory["contracts"][string] {
  const legacyName = LEGACY_ARTIFACT_ALIASES[name];
  const item = inventory.contracts[name] ?? (legacyName === undefined ? undefined : inventory.contracts[legacyName]);
  if (item === undefined) throw new ReleaseError("ARTIFACT_MISMATCH", `$.artifacts.${name}`, "missing artifact inventory entry");
  return item;
}

export function preflightTestnetRelease(rawConfig: unknown, observation: ReleaseObservation, inventory: ArtifactInventory) {
  const config = validateTestnetReleaseConfig(rawConfig);
  if (config.containsPlaceholders) throw new ReleaseError("PLACEHOLDERS_PRESENT", "$.containsPlaceholders", "example config cannot authorize deployment");
  if (observation.chainId !== config.chainId) throw new ReleaseError("CHAIN_ID_MISMATCH", "$.chainId", "observed chain mismatch");
  if (!same(observation.poolManager.address, config.poolManager.address) || !same(observation.poolManager.extcodehash, config.poolManager.expectedExtcodehash)) {
    throw new ReleaseError("POOL_MANAGER_MISMATCH", "$.poolManager", "address or extcodehash mismatch");
  }

  const expectedArtifacts: readonly [keyof TestnetReleaseConfig["factory"]["artifactHashes"], string, "creationCodeHash" | "deployedRuntimeCodeHash"][] = [
    ["factoryCreationCode", "SwaputerWorldFactory", "creationCodeHash"], ["factoryRuntime", "SwaputerWorldFactory", "deployedRuntimeCodeHash"],
    ["routerRuntime", "SwaputerAppRouter", "deployedRuntimeCodeHash"], ["gasTokenCreationCode", "SwaputerToken", "creationCodeHash"],
    ["gasTokenRuntime", "SwaputerToken", "deployedRuntimeCodeHash"], ["kernelCreationCode", "SwaputerKernel", "creationCodeHash"],
    ["kernelRuntime", "SwaputerKernel", "deployedRuntimeCodeHash"], ["hookCreationCode", "SwaputerHook", "creationCodeHash"],
    ["hookRuntime", "SwaputerHook", "deployedRuntimeCodeHash"], ["worldDeployerCreationCode", "SwaputerWorldDeployer", "creationCodeHash"],
    ["worldDeployerRuntime", "SwaputerWorldDeployer", "deployedRuntimeCodeHash"], ["referenceRegistryRuntime", "SwaputerProgramRegistry", "deployedRuntimeCodeHash"]
  ];
  for (const [field, contract, property] of expectedArtifacts) {
    if (!same(config.factory.artifactHashes[field], artifact(inventory, contract)[property])) {
      throw new ReleaseError("ARTIFACT_MISMATCH", `$.factory.artifactHashes.${field}`, "audit artifact mismatch");
    }
  }
  if (!same(config.factory.kernelCreationCodeStore.payloadHash, config.factory.artifactHashes.kernelCreationCode) || !same(config.factory.hookCreationCodeStore.payloadHash, config.factory.artifactHashes.hookCreationCode)) {
    throw new ReleaseError("STORE_COMMITMENT_MISMATCH", "$.factory", "creation-code store payload mismatch");
  }
  for (const [name, storeConfig] of [["kernelCreationCodeStore", config.factory.kernelCreationCodeStore], ["hookCreationCodeStore", config.factory.hookCreationCodeStore]] as const) {
    const observed = observation.code[name];
    if (observed === undefined || !same(observed.address, storeConfig.address) || !same(observed.extcodehash, storeConfig.runtimeCodeHash)) {
      throw new ReleaseError("STORE_COMMITMENT_MISMATCH", `$.observation.code.${name}`, "store runtime mismatch");
    }
  }

  const computedToken = predictCreate2(config.factory.address, config.salts.tokenSalt, config.factory.initCodeHashes.gasToken);
  const computedDeployer = predictCreate2(config.factory.address, config.salts.bootstrapSalt, config.factory.initCodeHashes.worldDeployer);
  const computedKernel = predictFirstCreate(computedDeployer);
  const computedHook = predictCreate2(computedDeployer, config.salts.hookSalt, config.factory.initCodeHashes.hook);
  for (const [name, actual, expected] of [["token", config.predicted.token, computedToken], ["worldDeployer", config.predicted.worldDeployer, computedDeployer], ["kernel", config.predicted.kernel, computedKernel], ["hook", config.predicted.hook, computedHook]] as const) {
    if (!same(actual, expected)) throw new ReleaseError("PREDICTION_MISMATCH", `$.predicted.${name}`, "CREATE/CREATE2 prediction mismatch");
  }
  if ((BigInt(config.predicted.hook) & HOOK_PERMISSION_MASK) !== REQUIRED_HOOK_PERMISSION_BITS) {
    throw new ReleaseError("HOOK_PERMISSION_MISMATCH", "$.predicted.hook", "v4 permission bits mismatch");
  }
  const occupied = new Set(observation.occupiedAddresses.map((item) => item.toLowerCase()));
  for (const item of Object.values(config.predicted)) if (occupied.has(item.toLowerCase())) throw new ReleaseError("SALT_COLLISION", "$.predicted", "predicted address already has code");

  const price = BigInt(config.vm.byteGasPrice);
  const exposure = price * BigInt(config.vm.maxByteGasLimit);
  const supply = BigInt(config.token.initialSupply);
  const sqrtPrice = BigInt(config.pool.initialSqrtPriceX96);
  if (price === 0n || price > UINT128_MAX || config.vm.maxByteGasLimit > 1_000_000 || exposure > UINT256_MAX || exposure >= supply) {
    throw new ReleaseError("PARAMETER_OUT_OF_RANGE", "$.vm", "byte price/limit/exposure unsafe");
  }
  if (config.pool.fee >= 1_000_000 || config.pool.tickSpacing <= 0 || config.pool.tickSpacing > 32_767 || sqrtPrice <= MIN_SQRT_PRICE_X96 || sqrtPrice >= MAX_SQRT_PRICE_X96) {
    throw new ReleaseError("PARAMETER_OUT_OF_RANGE", "$.pool", "pool parameters out of range");
  }

  return Object.freeze({
    status: "PASS" as const,
    environment: config.environment,
    auditStatus: "unaudited" as const,
    economicValue: "none" as const,
    chainId: config.chainId,
    maximumTokenExposure: exposure.toString(),
    predictions: Object.freeze({ token: computedToken, worldDeployer: computedDeployer, kernel: computedKernel, hook: computedHook }),
    checks: Object.freeze(["release-policy", "chain-identity", "pool-manager-codehash", "artifact-hashes", "creation-code-stores", "address-predictions", "hook-permissions", "salt-collisions", "factory-parameters", "maximum-exposure", "pool-parameters"])
  });
}

export function assertExperimentalManifest(manifest: DeploymentManifest): void {
  const release = manifest.release;
  if (release.auditStatus !== "unaudited" || !["local", "testnet"].includes(release.environment as string) || release.auditCandidateTag !== STAGE7C_RC2_TAG || release.auditCandidateCommit !== STAGE7C_RC2_COMMIT || release.economicValue !== "none" || release.publicMainnetDeploymentAllowed) {
    throw new ReleaseError("MANIFEST_RELEASE_MISMATCH", "$.release", "manifest is not an rc2 zero-value experimental release");
  }
}

export interface WorldReleaseRecord {
  readonly worldId: Bytes32;
  readonly status: "experimental" | "deprecated";
  readonly replacementWorldId: Bytes32 | null;
  readonly reason: string | null;
}

export function deprecateWorld(records: readonly WorldReleaseRecord[], worldId: Bytes32, replacementWorldId: Bytes32, reason: string): readonly WorldReleaseRecord[] {
  if (same(worldId, replacementWorldId) || reason.length === 0) throw new ReleaseError("WORLD_STATE_INVALID", "$.worlds", "invalid migration");
  const old = records.find((item) => same(item.worldId, worldId));
  const replacement = records.find((item) => same(item.worldId, replacementWorldId));
  if (old === undefined || replacement === undefined || old.status !== "experimental" || replacement.status !== "experimental") {
    throw new ReleaseError("WORLD_STATE_INVALID", "$.worlds", "both worlds must be experimental and known");
  }
  return Object.freeze(records.map((item) => same(item.worldId, worldId)
    ? Object.freeze({ ...item, status: "deprecated" as const, replacementWorldId, reason })
    : item));
}
