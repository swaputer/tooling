import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { migrate, openIndexerDatabase } from "../src/database.js";
import { IndexerErrorCode } from "../src/errors.js";
import { SwapVMIndexer } from "../src/indexer.js";
import { HttpJsonRpcTransport } from "../src/rpc.js";

const repositoryRoot = resolve(process.cwd(), "../..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "swapvm-stage6b-anvil-"));
const databasePath = join(temporaryDirectory, "index.sqlite");
let anvil: ChildProcess | undefined;
let rpcUrl = "";
let privateKey = "";
let actor = "";
let driver = "";
let kernel = "";
let startBlock = 0n;
let snapshotId = "";
let chainId = 0n;

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("unable to allocate local port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error === undefined ? resolvePort(port) : reject(error)));
    });
  });
}

let rpcId = 0;
async function rpc<T>(method: string, params: readonly unknown[] = []): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const body = (await response.json()) as { readonly result?: T; readonly error?: unknown };
  if (body.error !== undefined || !("result" in body)) throw new Error(`local Anvil RPC failed: ${method}`);
  return body.result as T;
}

async function waitForAnvil(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await rpc<string>("eth_chainId");
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error("local Anvil did not start");
}

async function forgeScript(signature: "setup()" | "branchA()" | "branchB()"): Promise<string> {
  const args = [
    "script",
    "script/Stage6BE2E.s.sol:Stage6BE2EScript",
    "--sig",
    signature,
    "--rpc-url",
    rpcUrl,
    "--broadcast",
    "--slow",
    "--private-key",
    privateKey,
    "-vv"
  ];
  return await new Promise((resolveOutput, reject) => {
    const child = spawn("forge", args, {
      cwd: repositoryRoot,
      env: { ...process.env, STAGE6B_PRIVATE_KEY: privateKey, STAGE6B_DRIVER: driver, STAGE6B_KERNEL: kernel },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", () => reject(new Error(`local Forge ${signature} failed to start`)));
    child.once("exit", (code) => {
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(`local Forge ${signature} exited with code ${String(code)}`));
    });
  });
}

function queryCount(database: ReturnType<typeof openIndexerDatabase>, table: string, where = ""): bigint {
  return (database.prepare(`SELECT count(*) value FROM ${table} ${where}`).get() as { value: bigint }).value;
}

before(async () => {
  const port = await availablePort();
  chainId = 900_000_000n + BigInt(port);
  rpcUrl = `http://127.0.0.1:${port}`;
  privateKey = `0x${randomBytes(32).toString("hex")}`;
  const cast = spawnSync("cast", ["wallet", "address", "--private-key", privateKey], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (cast.status !== 0) throw new Error("unable to derive ephemeral Anvil address");
  actor = cast.stdout.trim().toLowerCase();
  anvil = spawn(
    "anvil",
    ["--silent", "--accounts", "0", "--port", String(port), "--chain-id", chainId.toString()],
    { cwd: repositoryRoot, stdio: "ignore" }
  );
  await waitForAnvil();
  await rpc("anvil_setBalance", [actor, "0x1000000000000000000000000000000"]);
  const setupOutput = await forgeScript("setup()");
  driver = setupOutput.match(/STAGE6B_DRIVER\s+(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase() ?? "";
  kernel = setupOutput.match(/STAGE6B_KERNEL\s+(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase() ?? "";
  assert.match(driver, /^0x[0-9a-f]{40}$/);
  assert.match(kernel, /^0x[0-9a-f]{40}$/);
  const head = BigInt(await rpc<string>("eth_blockNumber"));
  startBlock = head + 1n;
  snapshotId = await rpc<string>("evm_snapshot");
});

after(async () => {
  if (anvil !== undefined && anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      const force = setTimeout(() => {
        if (anvil?.exitCode === null) anvil.kill("SIGKILL");
      }, 2_000);
      anvil?.once("exit", () => {
        clearTimeout(force);
        resolveExit();
      });
    });
  }
  rmSync(temporaryDirectory, { recursive: true });
  rmSync(resolve(repositoryRoot, "broadcast/Stage6BE2E.s.sol", chainId.toString()), { recursive: true, force: true });
});

describe("ephemeral Anvil end-to-end", () => {
  it("indexes real Kernel NOP/CALL/DEPLOY/SRC-20/CPAMM receipts and converges after reorg", async () => {
    await forgeScript("branchA()");
    const database = openIndexerDatabase(databasePath);
    migrate(database);
    try {
      const config = {
        chainId,
        kernelAddress: kernel as `0x${string}`,
        startBlock,
        confirmations: 0n,
        chunkSize: 50n,
        maxReorgDepth: 64n,
        maxRpcRetries: 3,
        retryBaseDelayMs: 5
      } as const;
      const indexer = new SwapVMIndexer(database, new HttpJsonRpcTransport(rpcUrl));
      const first = await indexer.sync(config);
      assert.equal(first.executionsCommitted, 13n);
      assert.equal(queryCount(database, "vm_executions", "WHERE canonical = 1"), 13n);
      assert.equal(queryCount(database, "program_deployments", "WHERE canonical = 1"), 5n);
      assert.equal(
        queryCount(database, "decoded_events d JOIN vm_executions e ON e.id = d.execution_id", "WHERE e.canonical = 1 AND d.decode_status = 'decoded'"),
        13n
      );
      assert.equal(
        queryCount(database, "program_abi_bindings", "WHERE binding_status = 'bound' AND trust_level = 'verified_reference'"),
        4n
      );
      assert.equal(queryCount(database, "program_abi_bindings", "WHERE binding_status = 'unknown'"), 1n);

      const recordCounts = database
        .prepare(
          `SELECT e.execution_height, count(r.event_index) record_count
             FROM vm_executions e JOIN vm_records r ON r.execution_id = e.id
            WHERE e.canonical = 1 GROUP BY e.id ORDER BY length(e.execution_height), e.execution_height`
        )
        .all() as Array<{ execution_height: string; record_count: bigint }>;
      assert.equal(recordCounts[0]?.record_count, 1n); // NOP
      assert.equal(recordCounts[1]?.record_count, 2n); // DEPLOY
      assert.equal(recordCounts[2]?.record_count, 1n); // authenticated CALL
      assert.equal(recordCounts[4]?.record_count, 2n); // SRC-20 Transfer
      assert.equal(recordCounts[12]?.record_count, 4n); // CPAMM nested transfers + Swap + summary

      assert.equal(await rpc<boolean>("evm_revert", [snapshotId]), true);
      await forgeScript("branchB()");
      const second = await indexer.sync(config);
      assert.equal(second.reorgsApplied, 1n);
      assert.equal(queryCount(database, "vm_executions", "WHERE canonical = 1"), 13n);
      assert.equal(queryCount(database, "vm_executions", "WHERE canonical = 0"), 13n);
      assert.equal(queryCount(database, "vm_records", "WHERE canonical = 1"), 13n);
      assert.equal(queryCount(database, "program_deployments", "WHERE canonical = 1"), 0n);
      assert.equal(queryCount(database, "program_deployments", "WHERE canonical = 0"), 5n);
      assert.equal(
        queryCount(database, "decoded_events d JOIN vm_executions e ON e.id = d.execution_id", "WHERE e.canonical = 1"),
        0n
      );
      assert.equal(
        queryCount(database, "decoded_events d JOIN vm_executions e ON e.id = d.execution_id", "WHERE e.canonical = 0"),
        13n
      );
      assert.equal(
        queryCount(database, "ingestion_errors", `WHERE error_code = '${IndexerErrorCode.REORG_DETECTED}'`),
        1n
      );
      const heights = database
        .prepare(
          "SELECT execution_height FROM vm_executions WHERE canonical = 1 ORDER BY length(execution_height), execution_height"
        )
        .all() as Array<{ execution_height: string }>;
      assert.deepEqual(
        heights.map((row) => row.execution_height),
        Array.from({ length: 13 }, (_value, index) => String(index + 1))
      );
    } finally {
      database.close();
    }
  });
});
