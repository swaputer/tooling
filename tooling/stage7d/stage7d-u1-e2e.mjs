import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  HttpJsonRpcTransport,
  SwapVMIndexer,
  EVENTS_TOPIC,
  backupIndexerDatabase,
  getIndexerHealth,
  installVerifiedReferenceRegistry,
  migrate,
  openIndexerDatabase,
  rebuildDecodedEvents,
  restoreIndexerDatabase
} from "../indexer/dist/src/index.js";
import {
  assertExperimentalManifest,
  deprecateWorld,
  finalizeManifest,
  keccakHex,
  verifyObservation
} from "../deployment-manifest/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const temporary = mkdtempSync(join(tmpdir(), "swapvm-stage7d-u1-"));
const localKey = `0x${randomBytes(32).toString("hex")}`;
const release = Object.freeze({
  environment: "local", auditStatus: "unaudited", auditCandidateTag: "swaputer-v1.1-stage7c-rc2",
  auditCandidateCommit: "afa54c2e02e7e91430b14b6884faff5e3f5867d9", economicValue: "none",
  publicMainnetDeploymentAllowed: false, auditedReleaseArtifact: null
});
const vectors = [
  { vector: 1, byteGasPrice: 1_000_000_000n, fee: 500, spacing: 10 },
  { vector: 2, byteGasPrice: 1_000_000_000_000n, fee: 3_000, spacing: 60 },
  { vector: 3, byteGasPrice: 10_000_000_000_000n, fee: 10_000, spacing: 200 },
  { vector: 4, byteGasPrice: 10_000_000_000n, fee: 3_000, spacing: 60 }
];
let anvil;
let rpcUrl;
let rpcId = 0;

function json(value) { return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2); }
function hashFile(path) { return keccakHex(readFileSync(resolve(root, path))); }
function capture(output, label, expression) {
  const match = output.match(expression);
  if (match?.[1] === undefined) throw new Error(`MISSING_${label}`);
  return match[1].toLowerCase();
}
function address(output, label) { return capture(output, label, new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`)); }
function metric(output, label) { return BigInt(capture(output, label, new RegExp(`${label}\\s+([0-9]+)`))); }
function multilineWord(output, label) { return capture(output, label, new RegExp(`${label}\\s*\\n\\s*(0x[0-9a-fA-F]{64})`)); }

async function port() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address();
      if (value === null || typeof value === "string") return reject(new Error("PORT"));
      server.close((error) => error === undefined ? resolvePort(value.port) : reject(error));
    });
  });
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error !== undefined || !("result" in body)) throw new Error(`RPC_${method}`);
  return body.result;
}

async function command(program, args, env = {}) {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(program, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveOutput(stdout) : reject(Object.assign(new Error(`${program} failed`), { stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) })));
  });
}

async function waitForAnvil() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await rpc("eth_chainId"); return; } catch { await new Promise((done) => setTimeout(done, 50)); }
  }
  throw new Error("ANVIL_TIMEOUT");
}

async function codeIdentity(value) {
  const code = await rpc("eth_getCode", [value, "latest"]);
  assert.notEqual(code, "0x", `missing runtime code ${value}`);
  const hash = keccakHex(Buffer.from(code.slice(2), "hex"));
  return { address: value, extcodehash: hash, runtimeCodeHash: hash };
}

async function runVector(parameters) {
  const before = BigInt(await rpc("eth_blockNumber"));
  const output = await command("forge", [
    "script", "script/Stage7DU1Rehearsal.s.sol:Stage7DU1RehearsalScript", "--rpc-url", rpcUrl,
    "--broadcast", "--slow", "-vv"
  ], {
    STAGE7D_LOCAL_PRIVATE_KEY: localKey,
    STAGE7D_VECTOR: String(parameters.vector),
    STAGE7D_BYTE_GAS_PRICE: parameters.byteGasPrice.toString(),
    STAGE7D_POOL_FEE: String(parameters.fee),
    STAGE7D_TICK_SPACING: String(parameters.spacing)
  });
  const result = {
    ...parameters,
    startBlock: before + 1n,
    endBlock: BigInt(await rpc("eth_blockNumber")),
    manager: address(output, "STAGE7D_MANAGER"), factory: address(output, "STAGE7D_FACTORY"),
    router: address(output, "STAGE7D_ROUTER"), registry: address(output, "STAGE7D_REGISTRY"),
    kernelStore: address(output, "STAGE7D_KERNEL_STORE"), hookStore: address(output, "STAGE7D_HOOK_STORE"),
    worldDeployer: address(output, "STAGE7D_WORLD_DEPLOYER"), token: address(output, "STAGE7D_TOKEN"),
    kernel: address(output, "STAGE7D_KERNEL"), hook: address(output, "STAGE7D_HOOK"),
    worldId: multilineWord(output, "STAGE7D_WORLD_ID"), configHash: multilineWord(output, "STAGE7D_CONFIG_HASH"),
    distributionCommitment: multilineWord(output, "STAGE7D_DISTRIBUTION_COMMITMENT"),
    height: metric(output, "STAGE7D_HEIGHT"), simulatedSealedBlock: metric(output, "STAGE7D_SEALED_BLOCK"),
    supply: metric(output, "STAGE7D_SUPPLY")
  };
  const sealedTopic = keccakHex(new TextEncoder().encode("WorldSealed(bytes32,bytes32)"));
  const sealedLogs = await rpc("eth_getLogs", [{
    address: result.factory, fromBlock: `0x${result.startBlock.toString(16)}`,
    toBlock: `0x${result.endBlock.toString(16)}`, topics: [sealedTopic, result.worldId]
  }]);
  assert.equal(sealedLogs.length, 1, "one WorldSealed event per release");
  result.sealedBlock = BigInt(sealedLogs[0].blockNumber);
  result.deploymentTx = sealedLogs[0].transactionHash;
  result.deploymentTxIndex = BigInt(sealedLogs[0].transactionIndex);
  assert.equal(result.height, 5n);
  assert.equal(BigInt(result.hook) & 0x3fffn, 0x20ccn);
  return result;
}

async function indexSystem(system, databasePath) {
  const database = openIndexerDatabase(databasePath);
  try {
    migrate(database); installVerifiedReferenceRegistry(database);
    const indexer = new SwapVMIndexer(database, new HttpJsonRpcTransport(rpcUrl));
    const config = { chainId: 31337n, kernelAddress: system.kernel, startBlock: system.startBlock, confirmations: 0n, chunkSize: 100n, maxReorgDepth: 256n };
    const first = await indexer.sync(config);
    const second = await indexer.sync(config);
    assert.equal(first.executionsCommitted, 5n);
    assert.equal(second.executionsCommitted, 0n);
    assert.equal((database.prepare("SELECT count(*) value FROM vm_executions WHERE canonical = 1").get()).value, 5n);
    assert.equal((database.prepare("SELECT count(*) value FROM ingestion_errors").get()).value, 0n);
    rebuildDecodedEvents(database, {}, "2026-08-29T00:00:00.000Z");
    return getIndexerHealth(database, { databasePath, observedHead: system.endBlock, lastSuccessfulScanAt: "2026-08-29T00:00:00.000Z", now: "2026-08-29T00:00:00.000Z" });
  } finally { database.close(); }
}

async function buildManifest(system, actor) {
  const artifacts = JSON.parse(readFileSync(resolve(root, "audit/artifacts.json"), "utf8"));
  const kernelArtifact = artifacts.contracts.SwaputerKernel ?? artifacts.contracts.SwapVMKernel;
  const hookArtifact = artifacts.contracts.SwaputerHook ?? artifacts.contracts.SwapVMHook;
  assert.ok(kernelArtifact && hookArtifact, "missing Kernel/Hook artifact inventory");
  const block = await rpc("eth_getBlockByNumber", [`0x${system.sealedBlock.toString(16)}`, false]);
  const references = Object.fromEntries(["SRC20", "SRC721", "SRC1155", "CPAMM"].map((name) => [name.toLowerCase(), JSON.parse(readFileSync(resolve(root, `reference/${name}-v1.json`), "utf8")).codeHash]));
  const manifest = finalizeManifest({
    schemaVersion: "1", protocolVersion: "1.1", release, chainId: 31337, worldConfigHash: system.configHash,
    poolManager: await codeIdentity(system.manager), factory: await codeIdentity(system.factory), referenceRegistry: await codeIdentity(system.registry), worldDeployer: await codeIdentity(system.worldDeployer),
    artifactStores: {
      kernelCreationCode: { ...await codeIdentity(system.kernelStore), payloadHash: kernelArtifact.creationCodeHash },
      hookCreationCode: { ...await codeIdentity(system.hookStore), payloadHash: hookArtifact.creationCodeHash }
    },
    world: { poolKey: { currency0: "ETH", currency1: system.token, fee: system.fee, tickSpacing: system.spacing, hooks: system.hook }, worldId: system.worldId, byteGasPrice: system.byteGasPrice.toString(), maxByteGasLimit: 1_000_000, initialSqrtPriceX96: "79228162514264337593543950336", sealed: true, sealedAtBlock: Number(system.sealedBlock) },
    gasToken: { ...await codeIdentity(system.token), decimals: 18, initialSupply: "1000000000000000000000000000000000000", initialHolder: actor, distributionCommitment: system.distributionCommitment },
    kernel: await codeIdentity(system.kernel), hook: await codeIdentity(system.hook), router: { ...await codeIdentity(system.router), supportsCanonicalVMInput: true, supportsSignedVm: true },
    limits: { vmVersion: 1, receiptVersion: 1, isaHash: "0x2f0059846af771cb9f77e74d5f728744a9b8dbe69313d146b8a5e7fdcbe7c118", maxCodeBytes: 16384, maxStackWords: 1024, maxMemoryBytes: 65536, maxCallDepth: 32, maxReceiptPayloadBytes: 65536 },
    referencePrograms: { src20: references.src20, src721: references.src721, src1155: references.src1155, cpamm: references.cpamm },
    compiler: { name: "TinySol", version: "0.3.0-experimental", hash: "0x90dc23464f9d04da55862e15dec7b4fd1d61421ca04b81074c11920a6e2af5ec" },
    deployment: { blockHash: block.hash, blockNumber: Number(system.sealedBlock), txHash: system.deploymentTx, factoryAddress: system.factory, routerAddress: system.router, factoryEventTxIndex: Number(system.deploymentTxIndex) },
    integrity: { sourceControlCommit: release.auditCandidateCommit, treeCommitment: hashFile("audit/source-files.sha256"), artifactCommitment: hashFile("audit/artifacts.json"), specKeccak256: hashFile("docs/spec/SwapVM-v1.1-frozen-spec.md"), isaKeccak256: hashFile("docs/spec/SwapVM-ISA-v1.json"), manifestHash: `0x${"00".repeat(32)}`, signature: null }
  });
  assert.equal(manifest.worldConfigHash, system.configHash);
  assertExperimentalManifest(manifest);
  const identities = { poolManager: manifest.poolManager, factory: manifest.factory, referenceRegistry: manifest.referenceRegistry, worldDeployer: manifest.worldDeployer, gasToken: manifest.gasToken, kernel: manifest.kernel, hook: manifest.hook, router: manifest.router, kernelCreationCodeStore: manifest.artifactStores.kernelCreationCode, hookCreationCodeStore: manifest.artifactStores.hookCreationCode };
  verifyObservation(manifest, { chainId: 31337, worldId: manifest.world.worldId, worldConfigHash: manifest.worldConfigHash, blockHash: manifest.deployment.blockHash, blockNumber: manifest.deployment.blockNumber, txHash: manifest.deployment.txHash, sealed: true, treeCommitment: manifest.integrity.treeCommitment, artifactCommitment: manifest.integrity.artifactCommitment, compilerHash: manifest.compiler.hash, referencePrograms: manifest.referencePrograms, artifactPayloads: { kernelCreationCode: manifest.artifactStores.kernelCreationCode.payloadHash, hookCreationCode: manifest.artifactStores.hookCreationCode.payloadHash }, code: Object.fromEntries(Object.entries(identities).map(([name, item]) => [name, { address: item.address, extcodehash: item.extcodehash }])) });
  const path = join(temporary, `manifest-vector-${system.vector}.json`);
  writeFileSync(path, `${json(manifest)}\n`, { mode: 0o600 });
  return manifest;
}

async function main() {
  const selectedPort = await port(); rpcUrl = `http://127.0.0.1:${selectedPort}`;
  anvil = spawn("anvil", ["--silent", "--accounts", "0", "--port", String(selectedPort), "--chain-id", "31337"], { cwd: root, stdio: "ignore" });
  await waitForAnvil();
  const actor = (await command("cast", ["wallet", "address", "--private-key", localKey])).trim().toLowerCase();
  await rpc("anvil_setBalance", [actor, "0x1000000000000000000000000000000"]);

  const first = await runVector(vectors[0]);
  const firstDb = join(temporary, "vector-1.sqlite");
  const firstHealth = await indexSystem(first, firstDb);
  const backup = join(temporary, "vector-1.backup.sqlite");
  const restored = join(temporary, "vector-1.restored.sqlite");
  const backupResult = await backupIndexerDatabase(firstDb, backup);
  const restoreResult = await restoreIndexerDatabase(backup, restored);
  const restoredDatabase = openIndexerDatabase(restored);
  assert.equal((restoredDatabase.prepare("SELECT count(*) value FROM vm_executions WHERE canonical = 1").get()).value, 5n);
  restoredDatabase.close();
  const firstManifest = await buildManifest(first, actor);

  const second = await runVector(vectors[1]);
  await indexSystem(second, join(temporary, "vector-2.sqlite"));
  await buildManifest(second, actor);

  const branchPoint = await rpc("evm_snapshot");
  const orphan = await runVector(vectors[2]);
  const orphanDbPath = join(temporary, "orphan.sqlite");
  await indexSystem(orphan, orphanDbPath);
  assert.equal(await rpc("evm_revert", [branchPoint]), true);
  const replacement = await runVector(vectors[3]);
  await indexSystem(replacement, join(temporary, "replacement.sqlite"));
  const replacementManifest = await buildManifest(replacement, actor);

  const orphanDatabase = openIndexerDatabase(orphanDbPath);
  try {
    const indexer = new SwapVMIndexer(orphanDatabase, new HttpJsonRpcTransport(rpcUrl));
    await indexer.sync({ chainId: 31337n, kernelAddress: orphan.kernel, startBlock: orphan.startBlock, confirmations: 0n, chunkSize: 100n, maxReorgDepth: 256n });
    assert.equal((orphanDatabase.prepare("SELECT count(*) value FROM vm_executions WHERE canonical = 1").get()).value, 0n);
    assert.equal((orphanDatabase.prepare("SELECT count(*) value FROM vm_executions WHERE canonical = 0").get()).value, 5n);
  } finally { orphanDatabase.close(); }
  const catalog = deprecateWorld([
    { worldId: firstManifest.world.worldId, status: "experimental", replacementWorldId: null, reason: null },
    { worldId: replacementManifest.world.worldId, status: "experimental", replacementWorldId: null, reason: null }
  ], firstManifest.world.worldId, replacementManifest.world.worldId, "local incident migration rehearsal");
  assert.equal(catalog[0].status, "deprecated");

  process.stdout.write(`${json({ status: "PASS", environment: "isolated-anvil", publicRpcUsed: false, auditStatus: "unaudited", successfulReleaseRehearsals: 4, canonicalReleaseVectors: [1, 2, 4], orphanedReleaseVector: 3, executionsPerRelease: 5, backup: backupResult.integrity, restore: restoreResult.integrity, firstIndexerStatus: firstHealth.status, reorgOrphanExecutions: 5, manifestsVerified: 3, projectLiquidityWithdrawalRehearsed: true, deprecationMigrationRehearsed: true })}\n`);
}

try { await main(); } finally {
  if (anvil !== undefined && anvil.exitCode === null) anvil.kill("SIGTERM");
  rmSync(temporary, { recursive: true, force: true });
}
