import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  canonicalJson,
  finalizeManifest,
  keccakHex,
  keccakUtf8,
  verifyObservation
} from "../deployment-manifest/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const config = JSON.parse(readFileSync(resolve(root, "config/base-sepolia-release.json"), "utf8"));
const artifacts = JSON.parse(readFileSync(resolve(root, "audit/artifacts.json"), "utf8"));
const rpcUrl = process.env.SWAPVM_BASE_SEPOLIA_RPC_SECONDARY;
if (rpcUrl === undefined || rpcUrl.length === 0) throw new Error("RPC_ENV_UNSET");

const CREATE_WORLD_TX = "0x853060bcf2051a4ea6d7022dfdff3e3733c31663b4c8bfa37ddca0569ec08dd9";
const WORLD_ID = "0x9c414214b34b78217698b02c5b1a7af65f6d43c500ed2bd865ea4c54ed4360b9";
const RC2_COMMIT = "afa54c2e02e7e91430b14b6884faff5e3f5867d9";
const ZERO_WORD = `0x${"00".repeat(32)}`;
let rpcId = 0;

function hashFile(path) {
  return keccakHex(readFileSync(resolve(root, path)));
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
  const body = await response.json();
  if (body.error !== undefined || !("result" in body)) throw new Error(`RPC_${method}`);
  return body.result;
}

async function codeIdentity(address) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  assert.notEqual(code, "0x", `missing runtime code at ${address}`);
  const hash = keccakHex(Buffer.from(code.slice(2), "hex"));
  return Object.freeze({ address: address.toLowerCase(), extcodehash: hash, runtimeCodeHash: hash });
}

function selector(signature) {
  return keccakUtf8(signature).slice(0, 10);
}

async function addressGetter(target, signature) {
  const result = await rpc("eth_call", [{ to: target, data: selector(signature) }, "latest"]);
  assert.match(result, /^0x[0-9a-fA-F]{64}$/);
  return `0x${result.slice(-40)}`.toLowerCase();
}

async function uintGetter(target, signature) {
  const result = await rpc("eth_call", [{ to: target, data: selector(signature) }, "latest"]);
  assert.match(result, /^0x[0-9a-fA-F]{64}$/);
  return BigInt(result);
}

async function main() {
  assert.equal(Number(BigInt(await rpc("eth_chainId"))), config.chainId);
  const receipt = await rpc("eth_getTransactionReceipt", [CREATE_WORLD_TX]);
  assert.equal(receipt.status, "0x1");
  assert.equal(receipt.to.toLowerCase(), config.factory.address.toLowerCase());
  const sealedTopic = keccakUtf8("WorldSealed(bytes32,bytes32)");
  const sealedLogs = receipt.logs.filter((log) =>
    log.address.toLowerCase() === config.factory.address.toLowerCase()
      && log.topics[0]?.toLowerCase() === sealedTopic
      && log.topics[1]?.toLowerCase() === WORLD_ID
  );
  assert.equal(sealedLogs.length, 1, "expected exactly one WorldSealed event");
  assert.equal(sealedLogs[0].topics.length, 3);
  const worldConfigHash = sealedLogs[0].topics[2].toLowerCase();
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  assert.equal(block.hash.toLowerCase(), receipt.blockHash.toLowerCase());

  const factoryAddress = config.factory.address.toLowerCase();
  const routerAddress = await addressGetter(factoryAddress, "router()");
  const registryAddress = await addressGetter(factoryAddress, "referenceRegistry()");
  assert.equal(await addressGetter(factoryAddress, "poolManager()"), config.poolManager.address.toLowerCase());
  assert.equal(await addressGetter(routerAddress, "factory()"), factoryAddress);
  assert.equal(await addressGetter(routerAddress, "poolManager()"), config.poolManager.address.toLowerCase());
  assert.equal(await addressGetter(config.predicted.kernel, "hook()"), config.predicted.hook.toLowerCase());
  assert.equal(await addressGetter(config.predicted.hook, "kernel()"), config.predicted.kernel.toLowerCase());
  assert.equal(await addressGetter(config.predicted.hook, "poolManager()"), config.poolManager.address.toLowerCase());
  assert.equal(await addressGetter(config.predicted.hook, "gasToken()"), config.predicted.token.toLowerCase());
  assert.equal(await uintGetter(config.predicted.hook, "byteGasPrice()"), BigInt(config.vm.byteGasPrice));
  assert.equal(await uintGetter(config.predicted.token, "decimals()"), 18n);

  const references = Object.fromEntries(
    ["SRC20", "SRC721", "SRC1155", "CPAMM"].map((name) => [
      name.toLowerCase(),
      JSON.parse(readFileSync(resolve(root, `reference/${name}-v1.json`), "utf8")).codeHash
    ])
  );
  const identities = {
    poolManager: await codeIdentity(config.poolManager.address),
    factory: await codeIdentity(factoryAddress),
    referenceRegistry: await codeIdentity(registryAddress),
    worldDeployer: await codeIdentity(config.predicted.worldDeployer),
    gasToken: await codeIdentity(config.predicted.token),
    kernel: await codeIdentity(config.predicted.kernel),
    hook: await codeIdentity(config.predicted.hook),
    router: await codeIdentity(routerAddress),
    kernelCreationCodeStore: await codeIdentity(config.factory.kernelCreationCodeStore.address),
    hookCreationCodeStore: await codeIdentity(config.factory.hookCreationCodeStore.address)
  };

  const manifest = finalizeManifest({
    schemaVersion: "1",
    protocolVersion: "1.1",
    release: {
      environment: "testnet",
      auditStatus: "unaudited",
      auditCandidateTag: "swaputer-v1.1-stage7c-rc2",
      auditCandidateCommit: RC2_COMMIT,
      economicValue: "none",
      publicMainnetDeploymentAllowed: false,
      auditedReleaseArtifact: null
    },
    chainId: config.chainId,
    worldConfigHash,
    poolManager: identities.poolManager,
    factory: identities.factory,
    referenceRegistry: identities.referenceRegistry,
    worldDeployer: identities.worldDeployer,
    artifactStores: {
      kernelCreationCode: { ...identities.kernelCreationCodeStore, payloadHash: artifacts.contracts.SwapVMKernel.creationCodeHash },
      hookCreationCode: { ...identities.hookCreationCodeStore, payloadHash: artifacts.contracts.SwapVMHook.creationCodeHash }
    },
    world: {
      poolKey: {
        currency0: "ETH",
        currency1: config.predicted.token.toLowerCase(),
        fee: config.pool.fee,
        tickSpacing: config.pool.tickSpacing,
        hooks: config.predicted.hook.toLowerCase()
      },
      worldId: WORLD_ID,
      byteGasPrice: config.vm.byteGasPrice,
      maxByteGasLimit: config.vm.maxByteGasLimit,
      initialSqrtPriceX96: config.pool.initialSqrtPriceX96,
      sealed: true,
      sealedAtBlock: Number(BigInt(receipt.blockNumber))
    },
    gasToken: {
      ...identities.gasToken,
      decimals: 18,
      initialSupply: config.token.initialSupply,
      initialHolder: config.token.initialHolder.toLowerCase(),
      distributionCommitment: config.token.distributionCommitment
    },
    kernel: identities.kernel,
    hook: identities.hook,
    router: { ...identities.router, supportsCanonicalVMInput: true, supportsSignedVm: true },
    limits: {
      vmVersion: 1,
      receiptVersion: 1,
      isaHash: "0x2f0059846af771cb9f77e74d5f728744a9b8dbe69313d146b8a5e7fdcbe7c118",
      maxCodeBytes: 16_384,
      maxStackWords: 1_024,
      maxMemoryBytes: 65_536,
      maxCallDepth: 32,
      maxReceiptPayloadBytes: 65_536
    },
    referencePrograms: {
      src20: references.src20,
      src721: references.src721,
      src1155: references.src1155,
      cpamm: references.cpamm
    },
    compiler: {
      name: "TinySol",
      version: "0.2.0-experimental",
      hash: "0x90dc23464f9d04da55862e15dec7b4fd1d61421ca04b81074c11920a6e2af5ec"
    },
    deployment: {
      blockHash: receipt.blockHash,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      txHash: CREATE_WORLD_TX,
      factoryAddress,
      routerAddress,
      factoryEventTxIndex: Number(BigInt(receipt.transactionIndex))
    },
    integrity: {
      sourceControlCommit: RC2_COMMIT,
      treeCommitment: hashFile("audit/source-files.sha256"),
      artifactCommitment: hashFile("audit/artifacts.json"),
      specKeccak256: hashFile("docs/spec/SwapVM-v1.1-frozen-spec.md"),
      isaKeccak256: hashFile("docs/spec/SwapVM-ISA-v1.json"),
      manifestHash: ZERO_WORD,
      signature: null
    }
  });
  assert.equal(manifest.world.worldId, WORLD_ID);
  assert.equal(manifest.worldConfigHash, worldConfigHash);

  verifyObservation(manifest, {
    chainId: config.chainId,
    worldId: manifest.world.worldId,
    worldConfigHash: manifest.worldConfigHash,
    blockHash: manifest.deployment.blockHash,
    blockNumber: manifest.deployment.blockNumber,
    txHash: manifest.deployment.txHash,
    sealed: true,
    treeCommitment: manifest.integrity.treeCommitment,
    artifactCommitment: manifest.integrity.artifactCommitment,
    compilerHash: manifest.compiler.hash,
    referencePrograms: manifest.referencePrograms,
    artifactPayloads: {
      kernelCreationCode: manifest.artifactStores.kernelCreationCode.payloadHash,
      hookCreationCode: manifest.artifactStores.hookCreationCode.payloadHash
    },
    code: Object.fromEntries(Object.entries(identities).map(([name, item]) => [name, {
      address: item.address,
      extcodehash: item.extcodehash
    }]))
  });

  const outputPath = resolve(root, "deployments/base-sepolia/swapvm-v1.1-stage7d-u2.json");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${canonicalJson(manifest)}\n`, { mode: 0o644 });
  process.stdout.write(`${canonicalJson({
    status: "PASS",
    auditStatus: manifest.release.auditStatus,
    signature: manifest.integrity.signature,
    worldId: manifest.world.worldId,
    worldConfigHash: manifest.worldConfigHash,
    manifestHash: manifest.integrity.manifestHash,
    sealedAtBlock: manifest.world.sealedAtBlock,
    output: "deployments/base-sepolia/swapvm-v1.1-stage7d-u2.json"
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${canonicalJson({ error: error instanceof Error ? error.message : "UNKNOWN" })}\n`);
  process.exitCode = 1;
});
