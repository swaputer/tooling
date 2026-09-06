import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { migrate, openIndexerDatabase } from "../src/database.js";
import { SwapVMIndexer } from "../src/indexer.js";
import { registerDeclaredEventAbi } from "../src/registry.js";
import { HttpJsonRpcTransport } from "../src/rpc.js";

const repositoryRoot = resolve(process.cwd(), "../..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "swapvm-stage6d2-anvil-"));
const databasePath = join(temporaryDirectory, "index.sqlite");
let anvil: ChildProcess | undefined; let rpcUrl = ""; let privateKey = ""; let actor = ""; let driver = ""; let kernel = ""; let snapshotId = ""; let chainId = 0n; let startBlock = 0n;

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (address === null || typeof address === "string") return reject(new Error("PORT")); const port = address.port; server.close((error) => error === undefined ? resolvePort(port) : reject(error)); }); });
}
let rpcId = 0;
async function rpc<T>(method: string, params: readonly unknown[] = []): Promise<T> { const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) }); const body = await response.json() as { result?: T; error?: unknown }; if (body.error !== undefined || !("result" in body)) throw new Error(`RPC:${method}`); return body.result as T; }
async function waitForAnvil(): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { try { await rpc("eth_chainId"); return; } catch { await new Promise((done) => setTimeout(done, 50)); } } throw new Error("ANVIL_TIMEOUT"); }
async function forgeScript(signature: "setup()" | "branchA()" | "branchB()"): Promise<string> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn("forge", ["script", "script/Stage6D2E2E.s.sol:Stage6D2E2EScript", "--sig", signature, "--rpc-url", rpcUrl, "--broadcast", "--slow", "--private-key", privateKey, "-vv"], { cwd: repositoryRoot, env: { ...process.env, STAGE6D2_PRIVATE_KEY: privateKey, STAGE6D2_DRIVER: driver, STAGE6D2_KERNEL: kernel }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; }); child.once("error", () => reject(new Error(`FORGE_START:${signature}`))); child.once("exit", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(`FORGE_EXIT:${signature}:${String(code)}:${stderr.slice(-500)}`)));
  });
}
function count(database: ReturnType<typeof openIndexerDatabase>, table: string, where = ""): bigint { return (database.prepare(`SELECT count(*) value FROM ${table} ${where}`).get() as { value: bigint }).value; }
function fixtureDescriptor(name: string): unknown { return JSON.parse(readFileSync(resolve(repositoryRoot, `tooling/tinysol/fixtures/compiler/${name}.json`), "utf8")).events; }

before(async () => {
  const port = await availablePort(); chainId = 910_000_000n + BigInt(port); rpcUrl = `http://127.0.0.1:${port}`; privateKey = `0x${randomBytes(32).toString("hex")}`;
  const cast = spawnSync("cast", ["wallet", "address", "--private-key", privateKey], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); if (cast.status !== 0) throw new Error("ADDRESS"); actor = cast.stdout.trim().toLowerCase();
  anvil = spawn("anvil", ["--silent", "--accounts", "0", "--port", String(port), "--chain-id", chainId.toString()], { cwd: repositoryRoot, stdio: "ignore" }); await waitForAnvil(); await rpc("anvil_setBalance", [actor, "0x1000000000000000000000000000000"]);
  const setup = await forgeScript("setup()"); driver = setup.match(/STAGE6D2_DRIVER\s+(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase() ?? ""; kernel = setup.match(/STAGE6D2_KERNEL\s+(0x[0-9a-fA-F]{40})/)?.[1]?.toLowerCase() ?? ""; assert.match(driver, /^0x[0-9a-f]{40}$/); assert.match(kernel, /^0x[0-9a-f]{40}$/);
  startBlock = BigInt(await rpc<string>("eth_blockNumber")) + 1n; snapshotId = await rpc<string>("evm_snapshot");
});
after(async () => {
  if (anvil !== undefined && anvil.exitCode === null) { anvil.kill("SIGTERM"); await new Promise<void>((done) => { const force = setTimeout(() => { if (anvil?.exitCode === null) anvil.kill("SIGKILL"); }, 2_000); anvil?.once("exit", () => { clearTimeout(force); done(); }); }); }
  rmSync(temporaryDirectory, { recursive: true }); rmSync(resolve(repositoryRoot, "broadcast/Stage6D2E2E.s.sol", chainId.toString()), { recursive: true, force: true });
});

describe("TinySol compiler events through real Kernel, Stage 6B and Stage 6C", () => {
  it("decodes declared-unverified events and follows the canonical branch after reorg", async () => {
    await forgeScript("branchA()"); const database = openIndexerDatabase(databasePath); migrate(database);
    try {
      for (const name of ["EventDemo", "MiniToken", "MiniNFT"]) registerDeclaredEventAbi(database, fixtureDescriptor(name), { source: `tinysol:${name}`, now: "2026-08-29T00:00:00.000Z" });
      const config = { chainId, kernelAddress: kernel as `0x${string}`, startBlock, confirmations: 0n, chunkSize: 50n, maxReorgDepth: 64n, maxRpcRetries: 3, retryBaseDelayMs: 5 } as const;
      const indexer = new SwapVMIndexer(database, new HttpJsonRpcTransport(rpcUrl)); const first = await indexer.sync(config);
      assert.equal(first.executionsCommitted, 6n); assert.equal(count(database, "program_deployments", "WHERE canonical=1"), 3n);
      assert.equal(count(database, "decoded_events d JOIN vm_executions e ON e.id=d.execution_id", "WHERE e.canonical=1 AND d.decode_status='decoded'"), 3n);
      assert.equal(count(database, "program_abi_bindings", "WHERE binding_status='bound' AND trust_level='declared_unverified'"), 3n);
      assert.equal(count(database, "program_abi_bindings", "WHERE trust_level='verified_reference'"), 0n);
      const signatures = database.prepare("SELECT event_signature FROM decoded_events WHERE decode_status='decoded' ORDER BY event_signature").all() as Array<{ event_signature: string }>;
      assert.deepEqual(signatures.map((row) => row.event_signature), ["Changed(bytes32,uint256,bool)", "Transfer(bytes32,bytes32,uint256)", "Transfer(bytes32,bytes32,uint256)"]);

      assert.equal(await rpc<boolean>("evm_revert", [snapshotId]), true); await forgeScript("branchB()"); const second = await indexer.sync(config); assert.equal(second.reorgsApplied, 1n);
      assert.equal(count(database, "vm_executions", "WHERE canonical=1"), 6n); assert.equal(count(database, "vm_executions", "WHERE canonical=0"), 6n);
      assert.equal(count(database, "decoded_events d JOIN vm_executions e ON e.id=d.execution_id", "WHERE e.canonical=1"), 0n);
      assert.equal(count(database, "decoded_events d JOIN vm_executions e ON e.id=d.execution_id", "WHERE e.canonical=0 AND d.decode_status='decoded'"), 3n);
    } finally { database.close(); }
  });
});
