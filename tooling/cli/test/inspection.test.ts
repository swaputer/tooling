import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3";
import { loadDeployment, parseDeployment } from "../src/deployment.js";
import { InspectionError, InspectionErrorCode } from "../src/errors.js";
import { EVENTS_TOPIC, decodeOuterPayload, inspectRpcReceipt, inspectTransaction } from "../src/inspect.js";
import { jsonStringify } from "../src/json.js";
import type { Hex, RpcLog, RpcReceipt, RpcTransport, SwaputerDeployment } from "../src/index.js";

const PAYLOAD = "0x0100000100000105ff00000000000000000000000000000000000000000000000000000000000001013112cedead241c6530b184adc877ddaf0a4157aa13a4a0988b4bde6ce794defc000000c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000e8d4a510000000000000000000000000000000000000000000000000000dd60d504991f6f10000000000000000000000000000000000000000000000000dd60c6774ece6f1";
const WORLD_ID = "0xe6d4af2ba5520c2f666e49f8566b4a8498baf2993fe13f5725f48b72de8804b5";
const TRANSACTION_HASH = `0x${"a".repeat(64)}`;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeOuter(payload: string): string {
  const body = payload.slice(2);
  const padding = "0".repeat((64 - (body.length % 64)) % 64);
  return `0x${word(32n)}${word(BigInt(body.length / 2))}${body}${padding}`;
}

function codeHash(code: string): Hex {
  return `0x${Buffer.from(keccak_256(Buffer.from(code.slice(2), "hex"))).toString("hex")}`;
}

const deployment: SwaputerDeployment = Object.freeze({
  schemaVersion: "swaputer-cli-deployment/1",
  id: "base-sepolia",
  releaseName: "test",
  protocolVersion: "1.2",
  chainId: 84532n,
  networkName: "Base Sepolia",
  kernel: "0x1111111111111111111111111111111111111111",
  kernelRuntimeCodeHash: codeHash("0x6000"),
  worldId: WORLD_ID,
  sourceManifest: "test",
  sourceManifestHash: `0x${"2".repeat(64)}`
});

function log(overrides: Partial<RpcLog> = {}): RpcLog {
  return {
    address: deployment.kernel,
    topics: [EVENTS_TOPIC, WORLD_ID, `0x${word(1n)}`],
    data: encodeOuter(PAYLOAD),
    logIndex: "0x2",
    transactionIndex: "0x1",
    blockNumber: "0x2",
    blockHash: `0x${"b".repeat(64)}`,
    transactionHash: TRANSACTION_HASH,
    ...overrides
  };
}

function receipt(overrides: Partial<RpcReceipt> = {}): RpcReceipt {
  return {
    blockHash: `0x${"b".repeat(64)}`,
    blockNumber: "0x2",
    contractAddress: null,
    from: "0x1111111111111111111111111111111111111111",
    transactionHash: TRANSACTION_HASH,
    transactionIndex: "0x1",
    to: deployment.kernel,
    status: "0x1",
    logs: [log()],
    ...overrides
  };
}

test("loads the packaged active Base Sepolia deployment", async () => {
  const current = await loadDeployment("base-sepolia");
  assert.equal(current.chainId, 84532n);
  assert.equal(current.releaseName, "swaputer-v1.2-rc4");
  assert.equal(current.kernel, "0xcc0f598e82e14035213ef470f19f3149005b5191");
  assert.throws(() => parseDeployment({ ...current, unexpected: true }), (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.INVALID_DEPLOYMENT);
});

test("strictly recognizes and decodes a Kernel Events receipt", () => {
  const decoded = inspectRpcReceipt(receipt(), deployment);
  assert.equal(decoded.executions.length, 1);
  assert.equal(decoded.executions[0]?.executionHeight, 1n);
  assert.equal(decoded.executions[0]?.receipt.worldExecution.executedBytes, 1);
  assert.equal(decodeOuterPayload(encodeOuter(PAYLOAD)), PAYLOAD);
  assert.throws(() => inspectRpcReceipt(receipt({ status: "0x0", logs: [] }), deployment), (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.TRANSACTION_REVERTED);
  assert.throws(
    () => inspectRpcReceipt(receipt({ blockHash: "bad" }), deployment),
    (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.MALFORMED_EVENTS
  );
  assert.throws(
    () => inspectRpcReceipt(receipt({ logs: [log({ transactionHash: `0x${"c".repeat(64)}` })] }), deployment),
    (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.MALFORMED_EVENTS
  );
});

function canonicalTransport(overrides: {
  readonly containingHash?: string;
  readonly finalizedNumber?: string;
  readonly latestNumber?: string;
  readonly transactionBlockHash?: string;
} = {}): RpcTransport {
  return {
    async request<T>(_url: string, method: string, params: readonly unknown[]): Promise<T> {
      if (method === "eth_chainId") return "0x14a34" as T;
      if (method === "eth_getTransactionReceipt") return receipt() as T;
      if (method === "eth_getCode") return "0x6000" as T;
      if (method === "eth_getTransactionByHash") return {
        hash: TRANSACTION_HASH,
        blockHash: overrides.transactionBlockHash ?? `0x${"b".repeat(64)}`,
        blockNumber: "0x2",
        transactionIndex: "0x1",
        chainId: "0x14a34",
        from: "0x1111111111111111111111111111111111111111",
        to: deployment.kernel,
        nonce: "0x7"
      } as T;
      if (method === "eth_getBlockByNumber") {
        const block = params[0];
        if (block === "0x2") return { number: "0x2", hash: overrides.containingHash ?? `0x${"b".repeat(64)}` } as T;
        if (block === "finalized") return { number: overrides.finalizedNumber ?? "0x10", hash: `0x${"c".repeat(64)}` } as T;
        if (block === "latest") return { number: overrides.latestNumber ?? "0x20", hash: `0x${"d".repeat(64)}` } as T;
      }
      throw new Error(`unexpected method ${method}`);
    }
  };
}

test("online inspection verifies canonical finality and historical Kernel code without exposing the RPC URL", async () => {
  const result = await inspectTransaction(TRANSACTION_HASH, {
    deployment,
    rpcUrl: "https://secret.invalid/key",
    rpcEnvironment: "TEST_RPC",
    transport: canonicalTransport()
  });
  assert.equal(result.rpcEnvironment, "TEST_RPC");
  assert.equal(result.finalizedBlockNumber, 16n);
  assert.equal(result.confirmations, 31n);
  assert.equal(jsonStringify(result).includes("secret.invalid"), false);
});

test("online inspection rejects orphaned, unfinalized, and envelope-mismatched receipts", async () => {
  await assert.rejects(
    () => inspectTransaction(TRANSACTION_HASH, { deployment, rpcUrl: "https://rpc.invalid", rpcEnvironment: "TEST_RPC", transport: canonicalTransport({ containingHash: `0x${"e".repeat(64)}` }) }),
    (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.TRANSACTION_NOT_CANONICAL
  );
  await assert.rejects(
    () => inspectTransaction(TRANSACTION_HASH, { deployment, rpcUrl: "https://rpc.invalid", rpcEnvironment: "TEST_RPC", transport: canonicalTransport({ finalizedNumber: "0x1" }) }),
    (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.TRANSACTION_NOT_FINALIZED
  );
  await assert.rejects(
    () => inspectTransaction(TRANSACTION_HASH, { deployment, rpcUrl: "https://rpc.invalid", rpcEnvironment: "TEST_RPC", transport: canonicalTransport({ finalizedNumber: "0xd", latestNumber: "0xc" }) }),
    (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.TRANSACTION_NOT_CANONICAL
  );
  await assert.rejects(
    () => inspectTransaction(TRANSACTION_HASH, { deployment, rpcUrl: "https://rpc.invalid", rpcEnvironment: "TEST_RPC", transport: canonicalTransport({ finalizedNumber: "0x8", latestNumber: "0xc" }) }),
    (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.TRANSACTION_NOT_FINALIZED
  );
  const exactlyTwelve = await inspectTransaction(TRANSACTION_HASH, {
    deployment,
    rpcUrl: "https://rpc.invalid",
    rpcEnvironment: "TEST_RPC",
    transport: canonicalTransport({ finalizedNumber: "0x8", latestNumber: "0xd" })
  });
  assert.equal(exactlyTwelve.confirmations, 12n);
  await assert.rejects(
    () => inspectTransaction(TRANSACTION_HASH, { deployment, rpcUrl: "https://rpc.invalid", rpcEnvironment: "TEST_RPC", transport: canonicalTransport({ transactionBlockHash: `0x${"f".repeat(64)}` }) }),
    (error: unknown) => error instanceof InspectionError && error.code === InspectionErrorCode.TRANSACTION_NOT_CANONICAL
  );
});

test("CLI decodes a receipt and returns stable usage failures", () => {
  const cli = new URL("../src/cli.js", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  const version = spawnSync(process.execPath, [fileURLToPath(cli), "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), manifest.version);
  const decoded = spawnSync(process.execPath, [fileURLToPath(cli), "decode-receipt", PAYLOAD, "--json"], { encoding: "utf8" });
  assert.equal(decoded.status, 0, decoded.stderr);
  assert.equal(JSON.parse(decoded.stdout).worldExecution.executedBytes, 1);
  const failed = spawnSync(process.execPath, [fileURLToPath(cli), "inspect", "bad"], { encoding: "utf8" });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /CLI_USAGE/);
  const duplicate = spawnSync(process.execPath, [fileURLToPath(cli), "inspect", TRANSACTION_HASH, "--rpc-env", "TEST_RPC", "--network", "base-sepolia", "--network", "base-sepolia"], { encoding: "utf8" });
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /CLI_USAGE/);
});
