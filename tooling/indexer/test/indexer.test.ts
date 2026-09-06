import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { decodeVMReceipt, encodeVMReceiptHex, type Hex, type VMRecordInput } from "@swaputer/receipt-codec";
import { getStatuses, listDeployments, listExecutions, listRecords, migrate, openIndexerDatabase } from "../src/database.js";
import { IndexerError, IndexerErrorCode } from "../src/errors.js";
import { SwapVMIndexer } from "../src/indexer.js";
import {
  FakeRpcTransport,
  KERNEL,
  OTHER_KERNEL,
  TEST_CONFIG,
  WORLD,
  fixturePayload,
  hash,
  makeLog,
  outerData
} from "./helpers.js";

function memoryDatabase() {
  const database = openIndexerDatabase(":memory:");
  migrate(database);
  return database;
}

function count(database: ReturnType<typeof memoryDatabase>, table: string, where = ""): bigint {
  return (database.prepare(`SELECT count(*) value FROM ${table} ${where}`).get() as { value: bigint }).value;
}

function expectCode(error: unknown, code: string): void {
  assert.ok(error instanceof IndexerError);
  assert.equal(error.code, code);
}

function changedDeploymentPayload(): Hex {
  const decoded = decodeVMReceipt(fixturePayload("deploy"));
  const records: VMRecordInput[] = decoded.records.map((record) => ({
    emitter: record.emitter,
    topics: record.topics,
    data:
      record.kind === "miniContractDeployed"
        ? (`0x${record.data.slice(2, -64)}${"99".repeat(32)}` as Hex)
        : record.data
  }));
  return encodeVMReceiptHex({ records });
}

describe("reorg-safe SwapVM indexer", () => {
  it("syncs empty and multi-log blocks in canonical RPC order", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock();
    rpc.addBlock((number, blockHash) => [
      makeLog(number, blockHash, 2n, { transactionIndex: 1n, logIndex: 3n }),
      makeLog(number, blockHash, 1n, { transactionIndex: 0n, logIndex: 2n })
    ]);
    rpc.reverseLogs = true;
    const database = memoryDatabase();
    try {
      const result = await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      assert.equal(result.blocksCommitted, 2n);
      assert.equal(result.executionsCommitted, 2n);
      assert.deepEqual(
        listExecutions(database).map((row) => row.execution_height),
        ["1", "2"]
      );
      const status = getStatuses(database)[0];
      assert.equal(status?.canonicalTip, 2n);
      assert.equal(status?.nextBlock, 3n);
      assert.equal(status?.records, 2n);
    } finally {
      database.close();
    }
  });

  it("stops at an explicit target block and later resumes to the chain head", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n)]);
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 2n)]);
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 3n)]);
    const database = memoryDatabase();
    try {
      const indexer = new SwapVMIndexer(database, rpc);
      const bounded = await indexer.sync({ ...TEST_CONFIG, targetBlock: 2n });
      assert.equal(bounded.latestBlock, 3n);
      assert.equal(bounded.targetBlock, 2n);
      assert.equal(bounded.nextBlock, 3n);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 1"), 2n);

      const resumed = await indexer.sync(TEST_CONFIG);
      assert.equal(resumed.targetBlock, null);
      assert.equal(resumed.nextBlock, 4n);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 1"), 3n);
    } finally {
      database.close();
    }
  });

  it("rejects a target below startBlock before issuing RPC requests", async () => {
    const rpc = new FakeRpcTransport();
    const database = memoryDatabase();
    try {
      await assert.rejects(
        new SwapVMIndexer(database, rpc).sync({ ...TEST_CONFIG, startBlock: 2n, targetBlock: 1n }),
        (error: unknown) => {
          expectCode(error, IndexerErrorCode.KERNEL_CONFIG_MISMATCH);
          return true;
        }
      );
      assert.equal(rpc.calls.size, 0);
    } finally {
      database.close();
    }
  });

  it("is idempotent for duplicate RPC logs and repeated syncs", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n)]);
    rpc.duplicateLogs = true;
    const database = memoryDatabase();
    try {
      const indexer = new SwapVMIndexer(database, rpc);
      await indexer.sync(TEST_CONFIG);
      await indexer.sync(TEST_CONFIG);
      assert.equal(count(database, "vm_executions"), 1n);
      assert.equal(count(database, "vm_records"), 1n);
      assert.equal(count(database, "blocks", "WHERE canonical = 1"), 1n);
    } finally {
      database.close();
    }
  });

  it("recovers its cursor after database close and process-style restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "swaputer-indexer-restart-"));
    const path = join(directory, "index.sqlite");
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n)]);
    let database = openIndexerDatabase(path);
    try {
      migrate(database);
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      database.close();
      rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 2n)]);
      database = openIndexerDatabase(path);
      migrate(database);
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      assert.equal(getStatuses(database)[0]?.nextBlock, 3n);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 1"), 2n);
    } finally {
      if (database.open) database.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("rolls back the complete block and cursor when transaction commit fails", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n)]);
    const database = memoryDatabase();
    let failed = false;
    try {
      await assert.rejects(
        new SwapVMIndexer(database, rpc, {
          beforeBlockCommit: () => {
            if (!failed) {
              failed = true;
              throw new Error("injected transaction failure");
            }
          }
        }).sync(TEST_CONFIG)
      );
      assert.equal(count(database, "blocks"), 0n);
      assert.equal(count(database, "vm_executions"), 0n);
      assert.equal(getStatuses(database)[0]?.nextBlock, 1n);
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      assert.equal(count(database, "vm_executions"), 1n);
    } finally {
      database.close();
    }
  });

  it("retries transient RPC failures with bounded backoff", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock();
    rpc.fail("eth_getLogs", 2);
    const database = memoryDatabase();
    const delays: number[] = [];
    try {
      await new SwapVMIndexer(database, rpc, { sleep: async (milliseconds) => void delays.push(milliseconds) }).sync({
        ...TEST_CONFIG,
        retryBaseDelayMs: 3
      });
      assert.deepEqual(delays, [3, 6]);
      assert.equal(rpc.calls.get("eth_getLogs"), 3);
    } finally {
      database.close();
    }
  });

  it("separates exhausted temporary RPC failures from protocol quarantine", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock();
    rpc.fail("eth_getLogs", 10);
    const database = memoryDatabase();
    try {
      const error = await new SwapVMIndexer(database, rpc, { sleep: async () => undefined })
        .sync({ ...TEST_CONFIG, maxRpcRetries: 1 })
        .then(
          () => undefined,
          (reason: unknown) => reason
        );
      expectCode(error, IndexerErrorCode.RPC_RETRIES_EXHAUSTED);
      const stored = database.prepare("SELECT category, retryable FROM ingestion_errors").get() as {
        category: string;
        retryable: bigint;
      };
      assert.deepEqual(stored, { category: "RPC", retryable: 1n });
      assert.equal(getStatuses(database)[0]?.nextBlock, 1n);
    } finally {
      database.close();
    }
  });

  it("shrinks provider log ranges without skipping blocks", async () => {
    const rpc = new FakeRpcTransport();
    for (let index = 1n; index <= 4n; index += 1n) {
      rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, index)]);
    }
    rpc.maxLogRange = 1n;
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync({ ...TEST_CONFIG, chunkSize: 4n });
      assert.equal(count(database, "blocks", "WHERE canonical = 1"), 4n);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 1"), 4n);
      assert.ok((rpc.calls.get("eth_getLogs") ?? 0) > 4);
    } finally {
      database.close();
    }
  });

  it("quarantines malformed outer ABI and malformed receipts atomically", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => {
      const payload = fixturePayload();
      const malformedReceipt = `0x02${payload.slice(4)}` as Hex;
      return [
        makeLog(number, blockHash, 1n, { logIndex: 0n, data: outerData("0x01", { paddingByte: "ff" }) }),
        makeLog(number, blockHash, 2n, { logIndex: 1n, payload: malformedReceipt })
      ];
    });
    const database = memoryDatabase();
    try {
      const result = await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      assert.equal(result.quarantinedEvents, 2n);
      assert.equal(count(database, "vm_executions"), 0n);
      assert.equal(count(database, "vm_records"), 0n);
      assert.equal(count(database, "ingestion_errors"), 2n);
      const categories = database.prepare("SELECT category FROM ingestion_errors ORDER BY id").all() as Array<{
        category: string;
      }>;
      assert.deepEqual(categories.map((row) => row.category), ["EVENTS", "RECEIPT"]);
    } finally {
      database.close();
    }
  });

  it("allows a non-one first height, then quarantines gaps and duplicates", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 50n)]);
    rpc.addBlock((number, blockHash) => [
      makeLog(number, blockHash, 52n, { logIndex: 0n }),
      makeLog(number, blockHash, 50n, { logIndex: 1n })
    ]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      assert.equal(count(database, "vm_executions"), 1n);
      const codes = database.prepare("SELECT error_code FROM ingestion_errors ORDER BY ethereum_log_index").all() as Array<{
        error_code: string;
      }>;
      assert.deepEqual(codes.map((row) => row.error_code), [
        IndexerErrorCode.EXECUTION_HEIGHT_GAP,
        IndexerErrorCode.EXECUTION_HEIGHT_DUPLICATE
      ]);
    } finally {
      database.close();
    }
  });

  it("quarantines conflicting deployment code hashes without partial records", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n, { payload: fixturePayload("deploy") })]);
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 2n, { payload: changedDeploymentPayload() })]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      assert.equal(count(database, "vm_executions"), 1n);
      assert.equal(count(database, "vm_records"), 2n);
      assert.equal(count(database, "program_deployments"), 1n);
      assert.equal(
        (database.prepare("SELECT error_code FROM ingestion_errors").get() as { error_code: string }).error_code,
        IndexerErrorCode.DEPLOYMENT_CONFLICT
      );
    } finally {
      database.close();
    }
  });

  it("ignores logs from unconfigured kernels and optional nonmatching worlds", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [
      makeLog(number, blockHash, 1n, { address: OTHER_KERNEL }),
      makeLog(number, blockHash, 1n, { logIndex: 1n, worldId: hash("other-world") })
    ]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync({ ...TEST_CONFIG, worldId: WORLD });
      assert.equal(count(database, "vm_executions"), 0n);
      assert.equal(count(database, "ingestion_errors"), 0n);
    } finally {
      database.close();
    }
  });

  it("keeps Transfer-shaped application records raw and unverified", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n, { payload: fixturePayload("src20-transfer") })]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      const records = listRecords(database);
      assert.equal(records[0]?.kernel_record_kind, "application");
      assert.equal(records[1]?.kernel_record_kind, "world_execution");
      assert.ok(typeof records[0]?.topic0 === "string");
      assert.equal("decoded_event" in (records[0] ?? {}), false);
    } finally {
      database.close();
    }
  });

  it("handles a one-block reorg and accepts the replacement at the same height", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n)]);
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 2n)]);
    const database = memoryDatabase();
    try {
      const indexer = new SwapVMIndexer(database, rpc);
      await indexer.sync(TEST_CONFIG);
      rpc.replaceAfter(1n, [(number, blockHash) => [makeLog(number, blockHash, 2n, { transactionHash: hash("replacement") })]]);
      const result = await indexer.sync(TEST_CONFIG);
      assert.equal(result.reorgsApplied, 1n);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 1"), 2n);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 0"), 1n);
      assert.equal(count(database, "blocks", "WHERE canonical = 0"), 1n);
    } finally {
      database.close();
    }
  });

  it("rolls back a multi-block branch and removes orphan deployments from canonical mapping", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 10n, { payload: fixturePayload("deploy") })]);
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 11n)]);
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 12n)]);
    const database = memoryDatabase();
    try {
      const indexer = new SwapVMIndexer(database, rpc);
      await indexer.sync(TEST_CONFIG);
      assert.equal(listDeployments(database).length, 1);
      rpc.replaceAfter(0n, [
        (number, blockHash) => [makeLog(number, blockHash, 10n)],
        (number, blockHash) => [makeLog(number, blockHash, 11n)],
        (number, blockHash) => [makeLog(number, blockHash, 12n)]
      ]);
      await indexer.sync(TEST_CONFIG);
      assert.equal(listDeployments(database).length, 0);
      assert.equal(listDeployments(database, false).length, 1);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 1"), 3n);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 0"), 3n);
    } finally {
      database.close();
    }
  });

  it("halts with a fatal integrity error beyond maximum reorg depth", async () => {
    const rpc = new FakeRpcTransport();
    for (let height = 1n; height <= 3n; height += 1n) {
      rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, height)]);
    }
    const database = memoryDatabase();
    try {
      const config = { ...TEST_CONFIG, maxReorgDepth: 2n };
      const indexer = new SwapVMIndexer(database, rpc);
      await indexer.sync(config);
      rpc.replaceAfter(0n, [
        (number, blockHash) => [makeLog(number, blockHash, 1n)],
        (number, blockHash) => [makeLog(number, blockHash, 2n)],
        (number, blockHash) => [makeLog(number, blockHash, 3n)]
      ]);
      const error = await indexer.sync(config).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expectCode(error, IndexerErrorCode.REORG_DEPTH_EXCEEDED);
      assert.equal(count(database, "vm_executions", "WHERE canonical = 1"), 3n);
      assert.equal(
        (database.prepare("SELECT category FROM ingestion_errors WHERE error_code = ?").get(IndexerErrorCode.REORG_DEPTH_EXCEEDED) as { category: string }).category,
        "REORG"
      );
    } finally {
      database.close();
    }
  });

  it("rejects chainId and persisted kernel configuration mismatches", async () => {
    const rpc = new FakeRpcTransport();
    rpc.addBlock();
    const database = memoryDatabase();
    try {
      const wrongChain = await new SwapVMIndexer(database, rpc).sync({ ...TEST_CONFIG, chainId: 1n }).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expectCode(wrongChain, IndexerErrorCode.CHAIN_ID_MISMATCH);
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      const mismatch = await new SwapVMIndexer(database, rpc).sync({ ...TEST_CONFIG, chunkSize: 9n }).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expectCode(mismatch, IndexerErrorCode.KERNEL_CONFIG_MISMATCH);
    } finally {
      database.close();
    }
  });

  it("marks only confirmation-depth blocks and derived rows finalized", async () => {
    const rpc = new FakeRpcTransport();
    for (let height = 1n; height <= 3n; height += 1n) {
      rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, height)]);
    }
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync({ ...TEST_CONFIG, confirmations: 1n });
      const status = getStatuses(database)[0];
      assert.equal(status?.canonicalTip, 3n);
      assert.equal(status?.finalizedTip, 2n);
      assert.equal(count(database, "vm_executions", "WHERE finalized = 1"), 2n);
      assert.equal(count(database, "vm_records", "WHERE finalized = 1"), 2n);
    } finally {
      database.close();
    }
  });

  it("preserves chainId, executionHeight, transactionIndex and logIndex above 2^53", async () => {
    const chainId = 9_007_199_254_740_999n;
    const large = 9_007_199_254_741_111n;
    const rpc = new FakeRpcTransport(chainId);
    rpc.addBlock((number, blockHash) => [
      makeLog(number, blockHash, large, { transactionIndex: large + 1n, logIndex: large + 2n })
    ]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync({ ...TEST_CONFIG, chainId });
      const row = listExecutions(database)[0];
      assert.equal(row?.chain_id, chainId.toString());
      assert.equal(row?.execution_height, large.toString());
      assert.equal(row?.transaction_index, (large + 1n).toString());
      assert.equal(row?.ethereum_log_index, (large + 2n).toString());
    } finally {
      database.close();
    }
  });
});
