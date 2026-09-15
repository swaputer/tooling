import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HOOK_PERMISSION_MASK,
  REQUIRED_HOOK_PERMISSION_BITS,
  ReleaseError,
  deprecateWorld,
  predictCreate2,
  predictFirstCreate,
  preflightTestnetRelease,
  validateTestnetReleaseConfig
} from "../src/index.js";
import type { Address, ArtifactInventory, Bytes32, ReleaseObservation, TestnetReleaseConfig } from "../src/index.js";

const addr = (value: number): Address => `0x${value.toString(16).padStart(40, "0")}`;
const word = (value: number | bigint): Bytes32 => `0x${value.toString(16).padStart(64, "0")}`;
const inventory = JSON.parse(readFileSync("../../audit/artifacts.json", "utf8")) as ArtifactInventory;

function artifact(name: string) {
  const result = inventory.contracts[name];
  assert.ok(result);
  return result;
}

function fixture(): { raw: Record<string, unknown>; observation: ReleaseObservation } {
  const factory = addr(0x100);
  const tokenSalt = word(0x201);
  const bootstrapSalt = word(0x202);
  const tokenInit = word(0x301);
  const deployerInit = word(0x302);
  const hookInit = word(0x303);
  const deployer = predictCreate2(factory, bootstrapSalt, deployerInit);
  const kernel = predictFirstCreate(deployer);
  let hookSalt = word(1);
  let hook = predictCreate2(deployer, hookSalt, hookInit);
  for (let candidate = 2n; (BigInt(hook) & HOOK_PERMISSION_MASK) !== REQUIRED_HOOK_PERMISSION_BITS; candidate += 1n) {
    hookSalt = word(candidate);
    hook = predictCreate2(deployer, hookSalt, hookInit);
  }
  const kernelStore = addr(0x401);
  const hookStore = addr(0x402);
  const storeRuntime = artifact("SwapVMCreationCodeStore").deployedRuntimeCodeHash;
  const raw = {
    schemaVersion: "1",
    environment: "local",
    releaseStatus: {
      auditStatus: "unaudited",
      auditCandidateTag: "swaputer-v1.1-stage7c-rc2",
      auditCandidateCommit: "afa54c2e02e7e91430b14b6884faff5e3f5867d9",
      economicValue: "none",
      publicMainnetDeploymentAllowed: false
    },
    chainId: 31337,
    networkName: "isolated-anvil",
    poolManager: { address: addr(0x501), expectedExtcodehash: word(0x502) },
    factory: {
      address: factory,
      kernelCreationCodeStore: { address: kernelStore, runtimeCodeHash: storeRuntime, payloadHash: artifact("SwapVMKernel").creationCodeHash },
      hookCreationCodeStore: { address: hookStore, runtimeCodeHash: storeRuntime, payloadHash: artifact("SwapVMHook").creationCodeHash },
      artifactHashes: {
        factoryCreationCode: artifact("SwapVMWorldFactory").creationCodeHash,
        factoryRuntime: artifact("SwapVMWorldFactory").deployedRuntimeCodeHash,
        routerRuntime: artifact("SwapVMRouter").deployedRuntimeCodeHash,
        gasTokenCreationCode: artifact("SwapVMGasToken").creationCodeHash,
        gasTokenRuntime: artifact("SwapVMGasToken").deployedRuntimeCodeHash,
        kernelCreationCode: artifact("SwapVMKernel").creationCodeHash,
        kernelRuntime: artifact("SwapVMKernel").deployedRuntimeCodeHash,
        hookCreationCode: artifact("SwapVMHook").creationCodeHash,
        hookRuntime: artifact("SwapVMHook").deployedRuntimeCodeHash,
        worldDeployerCreationCode: artifact("SwapVMWorldDeployer").creationCodeHash,
        worldDeployerRuntime: artifact("SwapVMWorldDeployer").deployedRuntimeCodeHash,
        referenceRegistryRuntime: artifact("SwapVMReferenceRegistry").deployedRuntimeCodeHash
      },
      initCodeHashes: { gasToken: tokenInit, worldDeployer: deployerInit, hook: hookInit }
    },
    vm: { byteGasPrice: "1000000000000", maxByteGasLimit: 1_000_000 },
    token: { initialSupply: "1000000000000000000000000", initialHolder: addr(0x601), distributionCommitment: word(0x602), decimals: 18 },
    pool: { fee: 3000, tickSpacing: 60, initialSqrtPriceX96: "79228162514264337593543950336" },
    salts: { tokenSalt, bootstrapSalt, hookSalt },
    predicted: { token: predictCreate2(factory, tokenSalt, tokenInit), worldDeployer: deployer, kernel, hook },
    liquidityPlan: { description: "project-owned valueless fixtures", maximumProjectToken: "1000000000000000000", maximumProjectNativeWei: "1000000000000000000", thirdPartyFundsAllowed: false },
    finality: { confirmations: 2, maximumReorgDepth: 8, pollIntervalSeconds: 1 },
    rpcEnvironmentVariables: ["SWAPVM_LOCAL_RPC_PRIMARY", "SWAPVM_LOCAL_RPC_SECONDARY"],
    manifestPublisher: "UNSET_ZERO_VALUE_EXPERIMENT",
    containsPlaceholders: false
  };
  const observation: ReleaseObservation = {
    chainId: 31337,
    poolManager: { address: addr(0x501), extcodehash: word(0x502) },
    code: {
      kernelCreationCodeStore: { address: kernelStore, extcodehash: storeRuntime },
      hookCreationCodeStore: { address: hookStore, extcodehash: storeRuntime }
    },
    occupiedAddresses: []
  };
  return { raw, observation };
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof ReleaseError && error.code === code);
}

test("strict zero-value preflight verifies release identity, artifacts, stores, predictions and exposure", () => {
  const { raw, observation } = fixture();
  const result = preflightTestnetRelease(raw, observation, inventory);
  assert.equal(result.status, "PASS");
  assert.equal(result.auditStatus, "unaudited");
  assert.equal(result.maximumTokenExposure, "1000000000000000000");
  assert.equal(BigInt(result.predictions.hook) & HOOK_PERMISSION_MASK, REQUIRED_HOOK_PERMISSION_BITS);
  assert.equal(result.checks.length, 11);
});

test("preflight accepts the renamed Swaputer core artifact inventory", () => {
  const contracts = { ...inventory.contracts };
  const names: ReadonlyArray<readonly [string, string]> = [
    ["SwaputerWorldFactory", "SwapVMWorldFactory"],
    ["SwaputerAppRouter", "SwapVMRouter"],
    ["SwaputerToken", "SwapVMGasToken"],
    ["SwaputerKernel", "SwapVMKernel"],
    ["SwaputerHook", "SwapVMHook"],
    ["SwaputerWorldDeployer", "SwapVMWorldDeployer"],
    ["SwaputerProgramRegistry", "SwapVMReferenceRegistry"]
  ];
  for (const [currentName, legacyName] of names) {
    const legacyArtifact = contracts[legacyName];
    assert.ok(legacyArtifact);
    contracts[currentName] = legacyArtifact;
    delete contracts[legacyName];
  }
  const renamedInventory: ArtifactInventory = { ...inventory, contracts };

  const { raw, observation } = fixture();
  assert.equal(preflightTestnetRelease(raw, observation, renamedInventory).status, "PASS");
});

test("release policy fails closed for mainnet, false audit claims and placeholders", () => {
  const mainnet = fixture(); (mainnet.raw as { chainId: number }).chainId = 1;
  expectCode(() => validateTestnetReleaseConfig(mainnet.raw), "MAINNET_FORBIDDEN");
  const audited = fixture(); ((audited.raw.releaseStatus as Record<string, unknown>).auditStatus) = "audited";
  expectCode(() => validateTestnetReleaseConfig(audited.raw), "UNAUDITED_STATUS_REQUIRED");
  const placeholder = fixture(); (placeholder.raw as { containsPlaceholders: boolean }).containsPlaceholders = true;
  expectCode(() => preflightTestnetRelease(placeholder.raw, placeholder.observation, inventory), "PLACEHOLDERS_PRESENT");
});

test("each observed identity and prediction mismatch has a stable fail-closed code", () => {
  for (const [mutate, code] of [
    [(raw: Record<string, unknown>, observation: ReleaseObservation) => Object.assign(observation as { chainId: number }, { chainId: 31338 }), "CHAIN_ID_MISMATCH"],
    [(raw: Record<string, unknown>, observation: ReleaseObservation) => Object.assign(observation.poolManager as { extcodehash: Bytes32 }, { extcodehash: word(999) }), "POOL_MANAGER_MISMATCH"],
    [(raw: Record<string, unknown>) => ((raw.factory as { artifactHashes: Record<string, unknown> }).artifactHashes.kernelRuntime = word(999)), "ARTIFACT_MISMATCH"],
    [(raw: Record<string, unknown>) => ((raw.factory as { kernelCreationCodeStore: Record<string, unknown> }).kernelCreationCodeStore.payloadHash = word(999)), "STORE_COMMITMENT_MISMATCH"],
    [(raw: Record<string, unknown>) => ((raw.predicted as Record<string, unknown>).kernel = addr(999)), "PREDICTION_MISMATCH"]
  ] as const) {
    const value = fixture(); mutate(value.raw, value.observation);
    expectCode(() => preflightTestnetRelease(value.raw, value.observation, inventory), code);
  }
  const collision = fixture();
  (collision.observation as { occupiedAddresses: readonly Address[] }).occupiedAddresses = [(collision.raw.predicted as { hook: Address }).hook];
  expectCode(() => preflightTestnetRelease(collision.raw, collision.observation, inventory), "SALT_COLLISION");
});

test("factory economic and pool boundaries are checked", () => {
  const exposure = fixture(); (exposure.raw.token as { initialSupply: string }).initialSupply = "1000000000000000000";
  expectCode(() => preflightTestnetRelease(exposure.raw, exposure.observation, inventory), "PARAMETER_OUT_OF_RANGE");
  const fee = fixture(); (fee.raw.pool as { fee: number }).fee = 1_000_000;
  expectCode(() => preflightTestnetRelease(fee.raw, fee.observation, inventory), "PARAMETER_OUT_OF_RANGE");
});

test("published example is schema-shaped but intentionally cannot authorize deployment", () => {
  const example = JSON.parse(readFileSync("../../config/testnet-release.example.json", "utf8")) as unknown;
  const decoded = validateTestnetReleaseConfig(example);
  assert.equal(decoded.containsPlaceholders, true);
  const observation: ReleaseObservation = { chainId: decoded.chainId, poolManager: { address: decoded.poolManager.address, extcodehash: decoded.poolManager.expectedExtcodehash }, code: {}, occupiedAddresses: [] };
  expectCode(() => preflightTestnetRelease(example, observation, inventory), "PLACEHOLDERS_PRESENT");
  const schema = JSON.parse(readFileSync("../../config/testnet-release.schema.json", "utf8")) as { properties: Record<string, unknown> };
  assert.ok(schema.properties.releaseStatus);
  assert.ok(schema.properties.predicted);
});

test("deprecation is an explicit offchain recommendation transition, not a chain pause", () => {
  const oldWorld = word(700);
  const replacement = word(701);
  const result = deprecateWorld([
    { worldId: oldWorld, status: "experimental", replacementWorldId: null, reason: null },
    { worldId: replacement, status: "experimental", replacementWorldId: null, reason: null }
  ], oldWorld, replacement, "incident migration rehearsal");
  assert.deepEqual(result[0], { worldId: oldWorld, status: "deprecated", replacementWorldId: replacement, reason: "incident migration rehearsal" });
  expectCode(() => deprecateWorld(result, oldWorld, replacement, "again"), "WORLD_STATE_INVALID");
});

test("validated config remains deeply typed and immutable at its public boundary", () => {
  const decoded: TestnetReleaseConfig = validateTestnetReleaseConfig(fixture().raw);
  assert.equal(decoded.environment, "local");
  assert.equal(decoded.releaseStatus.auditStatus, "unaudited");
  assert.ok(Object.isFrozen(decoded));
});
