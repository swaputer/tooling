import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { bytesToHex, decodeVMReceipt, encodeVMReceipt } from "../receipt-codec/dist/src/index.js";
import {
  HttpJsonRpcTransport,
  SwapVMIndexer,
  EVENTS_TOPIC,
  migrate,
  openIndexerDatabase,
  parseEvents,
  registerDeclaredEventAbi
} from "../indexer/dist/src/index.js";
import { estimateMiniVMFee, simulateMiniVM } from "../tinysol/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const temporary = mkdtempSync(join(tmpdir(), "swapvm-stage6e-"));
const databasePath = join(temporary, "stage6e.sqlite");
const chainId = 960_000_000n + BigInt(Math.floor(Math.random() * 1_000_000));
const byteGasPrice = 1_000_000_000_000n;
const byteGasLimit = 5_000;
const minNetTokenOut = 1n;
const ethInput = 1_000_000_000_000_000_000n;
const zero32 = `0x${"00".repeat(32)}`;
const key = `0x${randomBytes(32).toString("hex")}`;
let anvil;
let rpcUrl;
let rpcId = 0;

function json(value) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function fail(message, details = {}) {
  const error = new Error(`STAGE6E:${message}`);
  error.details = details;
  throw error;
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("PORT"));
      server.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
    });
  });
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const body = await response.json();
  if (body.error !== undefined || !("result" in body)) fail(`RPC_${method}`, { error: body.error });
  return body.result;
}

async function command(program, args, env = {}) {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolveOutput(stdout)
      : reject(Object.assign(new Error(`${program} ${args.join(" ")} exited ${code}`), { stdout, stderr })));
  });
}

async function waitForAnvil() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await rpc("eth_chainId"); return; } catch { await new Promise((done) => setTimeout(done, 50)); }
  }
  fail("ANVIL_TIMEOUT");
}

function capture(output, name, pattern) {
  const match = output.match(pattern);
  if (match?.[1] === undefined) fail(`MISSING_${name}`, { output: output.slice(-2_000) });
  return match[1];
}

function address(output, name) {
  return capture(output, name, new RegExp(`${name}\\s+(0x[0-9a-fA-F]{40})`)).toLowerCase();
}

function metric(output, name) {
  return BigInt(capture(output, name, new RegExp(`${name}\\s+(-?[0-9]+)`)));
}

function word(value) { return BigInt(value).toString(16).padStart(64, "0"); }
function account(addressValue) { return `0x${addressValue.slice(2).padStart(64, "0")}`.toLowerCase(); }
function bytes32Text(value) { return Buffer.from(value, "utf8").toString("hex").padEnd(64, "0"); }

function scriptEnvironment(system, reference = zero32, custom = zero32) {
  return {
    STAGE6E_PRIVATE_KEY: key,
    STAGE6E_MANAGER: system.manager ?? "0x0000000000000000000000000000000000000000",
    STAGE6E_TOKEN: system.token ?? "0x0000000000000000000000000000000000000000",
    STAGE6E_KERNEL: system.kernel ?? "0x0000000000000000000000000000000000000000",
    STAGE6E_HOOK: system.hook ?? "0x0000000000000000000000000000000000000000",
    STAGE6E_ROUTER: system.router ?? "0x0000000000000000000000000000000000000000",
    STAGE6E_FAILURE_EXECUTOR: system.failureExecutor ?? "0x0000000000000000000000000000000000000000",
    STAGE6E_REFERENCE: reference,
    STAGE6E_CUSTOM: custom
  };
}

async function forgeScript(signature, system = {}, reference = zero32, custom = zero32, broadcast = true) {
  const args = [
    "script", "script/Stage6EE2E.s.sol:Stage6EE2EScript", "--sig", signature,
    "--rpc-url", rpcUrl, "--private-key", key, "-vv"
  ];
  if (broadcast) args.splice(6, 0, "--broadcast", "--slow");
  return await command("forge", args, scriptEnvironment(system, reference, custom));
}

async function blockNumber() { return BigInt(await rpc("eth_blockNumber")); }

async function receiptsBetween(first, last) {
  const receipts = [];
  for (let number = first; number <= last; number += 1n) {
    const block = await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
    for (const hash of block.transactions) receipts.push(await rpc("eth_getTransactionReceipt", [hash]));
  }
  return receipts;
}

async function runBroadcast(signature, system, reference = zero32, custom = zero32) {
  const before = await blockNumber();
  const output = await forgeScript(signature, system, reference, custom, true);
  const after = await blockNumber();
  const receipts = await receiptsBetween(before + 1n, after);
  return { output, receipts, before, after };
}

function kernelLogs(receipt, kernel) {
  return receipt.logs.filter((log) =>
    log.address.toLowerCase() === kernel && log.topics[0]?.toLowerCase() === EVENTS_TOPIC.toLowerCase());
}

function parseExecution(receipt, kernel) {
  const logs = kernelLogs(receipt, kernel);
  assert.equal(logs.length, 1, "successful VM buy must emit exactly one Kernel Events");
  const parsed = parseEvents(logs[0], kernel);
  assert.deepEqual(decodeVMReceipt(parsed.payload), parsed.receipt);
  assert.equal(bytesToHex(encodeVMReceipt({ records: parsed.receipt.records })), parsed.payload);
  assert.equal(parsed.receipt.records.at(-1)?.kind, "worldExecution");
  assert.equal(parsed.receipt.records.filter((record) => record.kind === "worldExecution").length, 1);
  return parsed;
}

function vmReceiptTransaction(result, kernel) {
  const matches = result.receipts.filter((receipt) => kernelLogs(receipt, kernel).length > 0);
  assert.equal(matches.length, 1, "one broadcast operation must contain one VM execution transaction");
  return matches[0];
}

async function castCall(target, signature, args = []) {
  return (await command("cast", ["call", target, signature, ...args, "--rpc-url", rpcUrl])).trim();
}

function decimalOutput(value) {
  const match = value.match(/^-?[0-9]+/);
  if (match === null) fail("INVALID_CAST_DECIMAL", { value });
  return BigInt(match[0]);
}

async function totalSupply(system) {
  return decimalOutput(await castCall(system.token, "totalSupply()(uint256)"));
}

async function tokenBalance(system, owner) {
  return decimalOutput(await castCall(system.token, "balanceOf(address)(uint256)", [owner]));
}

async function height(system) {
  return decimalOutput(await castCall(system.kernel, "executionHeight(bytes32)(uint64)", [system.worldId]));
}

async function meter(system) {
  return decimalOutput(await castCall(system.kernel, "executedBytes(bytes32)(uint32)", [system.worldId]));
}

async function actorNonce(system, actorId) {
  return decimalOutput(await castCall(system.kernel, "nonces(bytes32,bytes32)(uint64)", [system.worldId, actorId]));
}

async function storageAt(system, target, slot) {
  return (await castCall(system.kernel, "programStorageAt(bytes32,bytes32,bytes32)(bytes32)", [system.worldId, target, slot])).toLowerCase();
}

async function assertSettled(system) {
  assert.equal(decimalOutput(await castCall(system.router, "nonzeroDeltaCount()(uint256)")), 0n);
}

function normalizeRecord(record) {
  return { emitter: record.emitter, topics: [...record.topics], data: record.data };
}

function decodeKernelReturn(output) {
  if (typeof output !== "string" || output.length < 2 + 128 * 2) return null;
  const body = output.slice(2);
  const executedBytes = Number(BigInt(`0x${body.slice(0, 64)}`));
  const actualBurn = BigInt(`0x${body.slice(64, 128)}`);
  const offset = Number(BigInt(`0x${body.slice(128, 192)}`));
  const actor = `0x${body.slice(192, 256)}`.toLowerCase();
  const lengthOffset = offset * 2;
  const length = Number(BigInt(`0x${body.slice(lengthOffset, lengthOffset + 64)}`));
  const returnData = `0x${body.slice(lengthOffset + 64, lengthOffset + 64 + length * 2)}`.toLowerCase();
  return { executedBytes, actualBurn, returnData, actor };
}

function findKernelReturn(frame, kernel, expectedBytes) {
  if (frame === null || typeof frame !== "object") return null;
  if (frame.to?.toLowerCase() === kernel && typeof frame.output === "string") {
    const decoded = decodeKernelReturn(frame.output);
    if (decoded?.executedBytes === expectedBytes) return decoded;
  }
  for (const child of frame.calls ?? []) {
    const found = findKernelReturn(child, kernel, expectedBytes);
    if (found !== null) return found;
  }
  return null;
}

async function sendFailure(system) {
  const transactionHash = (await command("cast", [
    "send", "--async", "--gas-limit", "8000000", "--private-key", key, "--rpc-url", rpcUrl,
    system.failureExecutor, "execute()"
  ])).trim();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [transactionHash]);
    if (receipt !== null) return receipt;
    await new Promise((done) => setTimeout(done, 25));
  }
  fail("FAILURE_RECEIPT_TIMEOUT", { transactionHash });
}

function count(database, table, where = "") {
  return database.prepare(`SELECT count(*) value FROM ${table} ${where}`).get().value;
}

async function main() {
  const port = await availablePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn("anvil", ["--silent", "--accounts", "0", "--port", String(port), "--chain-id", chainId.toString()], {
    cwd: root,
    stdio: "ignore"
  });
  await waitForAnvil();
  const actor = (await command("cast", ["wallet", "address", "--private-key", key])).trim().toLowerCase();
  await rpc("anvil_setBalance", [actor, "0x1000000000000000000000000000000"]);

  const setup = await forgeScript("setup()", {}, zero32, zero32, true);
  const system = {
    actor,
    manager: address(setup, "STAGE6E_MANAGER"),
    token: address(setup, "STAGE6E_TOKEN"),
    kernel: address(setup, "STAGE6E_KERNEL"),
    hook: address(setup, "STAGE6E_HOOK"),
    router: address(setup, "STAGE6E_ROUTER"),
    registry: address(setup, "STAGE6E_REGISTRY"),
    failureExecutor: address(setup, "STAGE6E_FAILURE_EXECUTOR"),
    worldId: capture(setup, "STAGE6E_WORLD", /\n\s+(0x[0-9a-fA-F]{64})\s*\n/).toLowerCase()
  };
  assert.equal(BigInt(system.hook) & 0x3fffn, 0x0044n, "Hook address permission bits");
  await assertSettled(system);
  const startBlock = await blockNumber() + 1n;
  const branchPoint = await rpc("evm_snapshot");

  const referenceArtifact = JSON.parse(readFileSync(resolve(root, "reference/SRC20-v1.json"), "utf8"));
  const customArtifact = JSON.parse(readFileSync(resolve(root, "tooling/tinysol/fixtures/compiler/MiniToken.json"), "utf8"));
  const actorId = account(actor);
  const referenceConstructor = `0x${bytes32Text("Stage6E Token")}${bytes32Text("S6E")}${word(18)}${word(1000)}${actorId.slice(2)}`;
  const transferPayload = `${referenceArtifact.selectors["transfer(bytes32,uint256)"]}${account("0x000000000000000000000000000000000000beef").slice(2)}${word(125)}`.toLowerCase();

  const deploy = await runBroadcast("deployReferenceBuy()", system);
  const reference = capture(deploy.output, "STAGE6E_REFERENCE", /STAGE6E_REFERENCE\s+(0x[0-9a-fA-F]{64})/).toLowerCase();
  const deployReceipt = vmReceiptTransaction(deploy, system.kernel);
  const parsedDeploy = parseExecution(deployReceipt, system.kernel);
  assert.equal(parsedDeploy.worldId, system.worldId);
  assert.equal(parsedDeploy.receipt.records.at(-2)?.kind, "miniContractDeployed");
  assert.equal(parsedDeploy.receipt.records.at(-2)?.decoded.contractId, reference);
  assert.equal(parsedDeploy.receipt.records.at(-2)?.decoded.codeHash, referenceArtifact.codeHash);
  await assertSettled(system);

  const deployContext = {
    worldId: system.worldId,
    executionHeight: parsedDeploy.executionHeight.toString(),
    byteGasPrice: byteGasPrice.toString(),
    buy: {
      ethAmountIn: ethInput.toString(),
      grossTokenOut: parsedDeploy.receipt.worldExecution.grossTokenOut.toString(),
      tickAfter: Number(metric(deploy.output, "STAGE6E_DEPLOY_TICK")),
      liquidityAfter: metric(deploy.output, "STAGE6E_DEPLOY_LIQUIDITY").toString()
    },
    block: {
      number: BigInt(deployReceipt.blockNumber).toString(),
      timestamp: BigInt((await rpc("eth_getBlockByNumber", [deployReceipt.blockNumber, false])).timestamp).toString()
    }
  };
  const simulatedDeploy = simulateMiniVM({
    state: { packages: { [referenceArtifact.codeHash]: referenceArtifact.package }, programs: {}, storage: {}, creatorNonces: {} },
    action: { op: "DEPLOY", actor: actorId, targetOrCodeHash: referenceArtifact.codeHash, payload: referenceConstructor, byteLimit: byteGasLimit },
    context: deployContext
  });
  assert.equal(simulatedDeploy.success, true);
  assert.equal(simulatedDeploy.rootTarget, reference);
  assert.equal(simulatedDeploy.executedBytes, parsedDeploy.receipt.worldExecution.executedBytes);
  assert.equal(simulatedDeploy.deploymentDiff.length, 1);
  assert.equal(simulatedDeploy.deploymentDiff[0].contractId, reference);
  assert.equal(simulatedDeploy.deploymentDiff[0].creator, actorId);
  assert.equal(simulatedDeploy.deploymentDiff[0].codeHash, referenceArtifact.codeHash);
  assert.deepEqual(simulatedDeploy.virtualRecords.map(normalizeRecord), parsedDeploy.receipt.records.filter((record) => record.kind === "application").map(normalizeRecord));

  const quoteOutput = await forgeScript("quoteReferenceCall()", system, reference, zero32, false);
  const quoted = {
    executedBytes: Number(metric(quoteOutput, "STAGE6E_QUOTE_EXECUTED")),
    burn: metric(quoteOutput, "STAGE6E_QUOTE_BURN"),
    gross: metric(quoteOutput, "STAGE6E_QUOTE_GROSS"),
    net: metric(quoteOutput, "STAGE6E_QUOTE_NET"),
    tick: Number(metric(quoteOutput, "STAGE6E_QUOTE_TICK")),
    liquidity: metric(quoteOutput, "STAGE6E_QUOTE_LIQUIDITY")
  };
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const nextTimestamp = BigInt(latest.timestamp) + 1n;
  await rpc("evm_setNextBlockTimestamp", [`0x${nextTimestamp.toString(16)}`]);
  const estimate = estimateMiniVMFee({
    state: simulatedDeploy.state,
    action: { op: "CALL", actor: actorId, targetOrCodeHash: reference, payload: transferPayload, byteLimit: byteGasLimit },
    context: {
      worldId: system.worldId,
      executionHeight: "2",
      byteGasPrice: byteGasPrice.toString(),
      buy: { ethAmountIn: ethInput.toString(), grossTokenOut: quoted.gross.toString(), tickAfter: quoted.tick, liquidityAfter: quoted.liquidity.toString() },
      block: { number: ((await blockNumber()) + 1n).toString(), timestamp: nextTimestamp.toString() }
    },
    minNetTokenOut: minNetTokenOut.toString()
  });
  assert.equal(estimate.mode, "exact");
  assert.equal(estimate.signable, true);
  assert.equal(estimate.estimatedExecutedBytes, quoted.executedBytes);
  assert.equal(BigInt(estimate.estimatedActualBurn), quoted.burn);
  assert.equal(BigInt(estimate.estimatedNetTokenOutput), quoted.net);
  assert.equal(estimate.coversMaximumExposureAndMinNet, true);

  const balanceBeforeCall = await tokenBalance(system, actor);
  const supplyBeforeCall = await totalSupply(system);
  const storageBefore = new Map();
  for (const diff of estimate.simulation.storageDiff) storageBefore.set(`${diff.target}:${diff.slot}`, await storageAt(system, diff.target, diff.slot));
  const call = await runBroadcast("referenceCallBuy()", system, reference);
  const callReceipt = vmReceiptTransaction(call, system.kernel);
  const parsedCall = parseExecution(callReceipt, system.kernel);
  const summary = parsedCall.receipt.worldExecution;
  assert.equal(parsedCall.worldId, system.worldId);
  assert.equal(parsedCall.executionHeight, 2n);
  assert.equal(summary.executedBytes, estimate.estimatedExecutedBytes);
  assert.equal(summary.tokenBurned, BigInt(estimate.estimatedActualBurn));
  assert.equal(summary.grossTokenOut, quoted.gross);
  assert.equal(summary.netTokenOut, BigInt(estimate.estimatedNetTokenOutput));
  assert.equal(await totalSupply(system), supplyBeforeCall - summary.tokenBurned);
  assert.equal(await tokenBalance(system, actor), balanceBeforeCall + summary.netTokenOut);
  assert.deepEqual(estimate.simulation.virtualRecords.map(normalizeRecord), parsedCall.receipt.records.filter((record) => record.kind === "application").map(normalizeRecord));
  for (const diff of estimate.simulation.storageDiff) {
    assert.equal(storageBefore.get(`${diff.target}:${diff.slot}`), diff.previousValue);
    assert.equal(await storageAt(system, diff.target, diff.slot), diff.value);
  }
  const trace = await rpc("debug_traceTransaction", [callReceipt.transactionHash, { tracer: "callTracer" }]);
  const tracedKernel = findKernelReturn(trace, system.kernel, summary.executedBytes);
  assert.ok(tracedKernel, "Kernel return tuple must be present in the production transaction trace");
  assert.equal(tracedKernel.actualBurn, summary.tokenBurned);
  assert.equal(tracedKernel.returnData, estimate.simulation.output);
  assert.equal(tracedKernel.actor, actorId);
  assert.ok(callReceipt.logs.length > 1, "transaction should also contain non-VM Ethereum logs");
  assert.equal(callReceipt.logs.filter((log) => log.topics[0]?.toLowerCase() === EVENTS_TOPIC.toLowerCase()).length, 1);
  await assertSettled(system);

  const customDeploy = await runBroadcast("deployCustomBuy()", system, reference);
  const custom = capture(customDeploy.output, "STAGE6E_CUSTOM", /STAGE6E_CUSTOM\s+(0x[0-9a-fA-F]{64})/).toLowerCase();
  parseExecution(vmReceiptTransaction(customDeploy, system.kernel), system.kernel);
  const customCall = await runBroadcast("customCallBuy()", system, reference, custom);
  parseExecution(vmReceiptTransaction(customCall, system.kernel), system.kernel);
  await assertSettled(system);

  const sellHeight = await height(system);
  const sellMeter = await meter(system);
  const sellSupply = await totalSupply(system);
  const sell = await runBroadcast("sell()", system, reference, custom);
  assert.equal(sell.receipts.flatMap((receipt) => kernelLogs(receipt, system.kernel)).length, 0);
  assert.equal(await height(system), sellHeight);
  assert.equal(await meter(system), sellMeter);
  assert.equal(await totalSupply(system), sellSupply);
  assert.equal(metric(sell.output, "STAGE6E_SELL_BURN"), 0n);
  await assertSettled(system);

  const rollbackStorage = await storageAt(system, reference, estimate.simulation.storageDiff[0].slot);
  for (const [configureSignature, expectedError] of [["configureRevert()", "EXPLICIT_REVERT"], ["configureOutOfByteGas()", "OUT_OF_BYTE_GAS"]]) {
    await runBroadcast(configureSignature, system, reference, custom);
    const before = {
      height: await height(system),
      meter: await meter(system),
      nonce: await actorNonce(system, actorId),
      supply: await totalSupply(system),
      balance: await tokenBalance(system, actor),
      storage: await storageAt(system, reference, estimate.simulation.storageDiff[0].slot)
    };
    const failedReceipt = await sendFailure(system);
    assert.equal(BigInt(failedReceipt.status), 0n, `${expectedError} transaction status`);
    assert.equal(kernelLogs(failedReceipt, system.kernel).length, 0);
    assert.equal(await height(system), before.height);
    assert.equal(await meter(system), before.meter);
    assert.equal(await actorNonce(system, actorId), before.nonce);
    assert.equal(await totalSupply(system), before.supply);
    assert.equal(await tokenBalance(system, actor), before.balance);
    assert.equal(await storageAt(system, reference, estimate.simulation.storageDiff[0].slot), before.storage);
    await assertSettled(system);
  }
  assert.equal(await storageAt(system, reference, estimate.simulation.storageDiff[0].slot), rollbackStorage);

  let database = openIndexerDatabase(databasePath);
  migrate(database);
  registerDeclaredEventAbi(database, customArtifact.events, { source: "tinysol:MiniToken", now: "2026-08-29T00:00:00.000Z" });
  const config = { chainId, kernelAddress: system.kernel, startBlock, confirmations: 0n, chunkSize: 50n, maxReorgDepth: 128n, maxRpcRetries: 3, retryBaseDelayMs: 5 };
  const indexer = new SwapVMIndexer(database, new HttpJsonRpcTransport(rpcUrl));
  const firstSync = await indexer.sync(config);
  assert.equal(firstSync.executionsCommitted, 4n);
  assert.equal(count(database, "vm_executions", "WHERE canonical=1"), 4n);
  const expectedRecords = [deploy, call, customDeploy, customCall]
    .map((result) => parseExecution(vmReceiptTransaction(result, system.kernel), system.kernel).receipt.recordCount)
    .reduce((sum, value) => sum + BigInt(value), 0n);
  const expectedDecodedEvents = [deploy, call, customDeploy, customCall]
    .map((result) => parseExecution(vmReceiptTransaction(result, system.kernel), system.kernel).receipt.records
      .filter((record) => record.kind === "application").length)
    .reduce((sum, value) => sum + BigInt(value), 0n);
  assert.equal(count(database, "vm_records", "WHERE canonical=1"), expectedRecords);
  assert.equal(count(database, "program_abi_bindings", "WHERE trust_level='verified_reference' AND code_hash='" + referenceArtifact.codeHash + "'"), 1n);
  assert.equal(count(database, "program_abi_bindings", "WHERE trust_level='declared_unverified' AND code_hash='" + customArtifact.codeHash + "'"), 1n);
  assert.equal(count(database, "program_abi_bindings", "WHERE trust_level='verified_reference' AND code_hash='" + customArtifact.codeHash + "'"), 0n);
  assert.equal(count(database, "decoded_events d JOIN vm_executions e ON e.id=d.execution_id", "WHERE e.canonical=1 AND d.decode_status='decoded'"), expectedDecodedEvents);
  const storedCall = database.prepare("SELECT raw_receipt_payload FROM vm_executions WHERE transaction_hash=?").get(callReceipt.transactionHash.toLowerCase());
  assert.equal(storedCall.raw_receipt_payload, parsedCall.payload);
  const secondSync = await indexer.sync(config);
  assert.equal(secondSync.executionsCommitted, 0n);
  assert.equal(count(database, "vm_executions", "WHERE canonical=1"), 4n);
  database.close();
  database = openIndexerDatabase(databasePath);
  migrate(database);
  const restartedSync = await new SwapVMIndexer(database, new HttpJsonRpcTransport(rpcUrl)).sync(config);
  assert.equal(restartedSync.executionsCommitted, 0n);
  assert.equal(count(database, "vm_executions", "WHERE canonical=1"), 4n);

  assert.equal(await rpc("evm_revert", [branchPoint]), true);
  await runBroadcast("branchB()", system, reference, custom);
  const reorgSync = await new SwapVMIndexer(database, new HttpJsonRpcTransport(rpcUrl)).sync(config);
  assert.equal(reorgSync.reorgsApplied, 1n);
  assert.equal(count(database, "vm_executions", "WHERE canonical=1"), 4n);
  assert.equal(count(database, "vm_executions", "WHERE canonical=0"), 4n);
  assert.equal(count(database, "decoded_events d JOIN vm_executions e ON e.id=d.execution_id", "WHERE e.canonical=1"), 0n);
  assert.equal(count(database, "decoded_events d JOIN vm_executions e ON e.id=d.execution_id", "WHERE e.canonical=0 AND d.decode_status='decoded'"), expectedDecodedEvents);
  const orphanCall = database.prepare("SELECT raw_receipt_payload, canonical FROM vm_executions WHERE transaction_hash=?").get(callReceipt.transactionHash.toLowerCase());
  assert.equal(orphanCall.raw_receipt_payload, parsedCall.payload);
  assert.equal(orphanCall.canonical, 0n);
  database.close();

  const evidence = {
    chainId,
    system,
    productionPath: ["DEPLOY buy", "CALL buy", "TOKEN->ETH sell", "reverting buy", "OutOfByteGas buy"],
    call: {
      transactionHash: callReceipt.transactionHash,
      worldId: parsedCall.worldId,
      executionHeight: parsedCall.executionHeight,
      ethereumLogCount: callReceipt.logs.length,
      kernelEventsCount: kernelLogs(callReceipt, system.kernel).length,
      orderedRecords: parsedCall.receipt.records.map((record, index) => ({ index, kind: record.kind, emitter: record.emitter, topics: record.topics, data: record.data })),
      returnData: tracedKernel.returnData,
      executedBytes: summary.executedBytes,
      estimatedActualBurn: estimate.estimatedActualBurn,
      actualBurn: summary.tokenBurned,
      grossTokenOutput: summary.grossTokenOut,
      estimatedNetTokenOutput: estimate.estimatedNetTokenOutput,
      actualNetTokenOutput: summary.netTokenOut,
      maximumTokenExposure: estimate.maximumTokenExposure,
      minNetTokenOut,
      coverage: estimate.coversMaximumExposureAndMinNet
    },
    indexer: { branchAExecutions: 4, branchBExecutions: 4, orphanExecutionsRetained: 4, schemaVersion: 2 },
    result: "PASS"
  };
  console.log(json(evidence));
}

try {
  await main();
} finally {
  if (anvil !== undefined && anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise((done) => {
      const force = setTimeout(() => { if (anvil?.exitCode === null) anvil.kill("SIGKILL"); }, 2_000);
      anvil.once("exit", () => { clearTimeout(force); done(); });
    });
  }
  rmSync(temporary, { recursive: true, force: true });
  rmSync(resolve(root, "broadcast/Stage6EE2E.s.sol", chainId.toString()), { recursive: true, force: true });
  rmSync(resolve(root, "cache/Stage6EE2E.s.sol", chainId.toString()), { recursive: true, force: true });
}
