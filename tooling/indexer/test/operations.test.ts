import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildDecodedEvents } from "../src/derived-events.js";
import { migrate, openIndexerDatabase } from "../src/database.js";
import {
  GracefulShutdown,
  backupIndexerDatabase,
  getIndexerHealth,
  restoreIndexerDatabase,
  validateRpcEndpointConfig
} from "../src/operations.js";

const address = (value: number): `0x${string}` => `0x${value.toString(16).padStart(40, "0")}`;
const word = (value: number): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;

function seed(path: string): void {
  const database = openIndexerDatabase(path);
  try {
    migrate(database);
    const now = "2026-08-29T00:00:00.000Z";
    database.prepare("INSERT INTO chains(chain_id, genesis_block_hash, config_json, created_at) VALUES (?, ?, '{}', ?)").run("31337", word(1), now);
    database.prepare(`INSERT INTO kernels(chain_id, kernel_address, world_id_filter, start_block, enabled, confirmations, chunk_size, max_reorg_depth, created_at, updated_at)
      VALUES (?, ?, NULL, '1', 1, '2', '100', '8', ?, ?)`)
      .run("31337", address(2), now, now);
    database.prepare("INSERT INTO ingestion_cursor(chain_id, kernel_address, next_block, last_canonical_block_hash, updated_at) VALUES (?, ?, '3', ?, ?)")
      .run("31337", address(2), word(12), now);
    const insertBlock = database.prepare(`INSERT INTO blocks(chain_id, block_number, block_hash, parent_hash, timestamp, canonical, finalized, first_seen_at, orphaned_at)
      VALUES ('31337', ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertBlock.run("1", word(11), word(1), "1", 1, 1, now, null);
    insertBlock.run("2", word(12), word(11), "2", 1, 0, now, null);
    insertBlock.run("2", word(13), word(11), "2", 0, 0, now, "2026-08-29T00:01:00.000Z");
    const insertExecution = database.prepare(`INSERT INTO vm_executions(chain_id, kernel_address, block_number, block_hash, transaction_hash, transaction_index,
      ethereum_log_index, world_id, execution_height, raw_log_data, raw_receipt_payload, receipt_version, receipt_flags, canonical, finalized, indexed_at)
      VALUES ('31337', ?, ?, ?, ?, '0', ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)`);
    insertExecution.run(address(2), "1", word(11), word(21), "0", word(31), "1", "0xaaa1", "0x01000001", 1, now);
    insertExecution.run(address(2), "2", word(12), word(22), "1", word(31), "3", "0xaaa2", "0x01000002", 0, now);
    const ids = database.prepare("SELECT id FROM vm_executions ORDER BY id").all() as { id: bigint }[];
    database.prepare(`INSERT INTO vm_records(execution_id, event_index, emitter, topic_count, topic0, topic1, topic2, topic3, raw_data, kernel_record_kind, canonical, finalized)
      VALUES (?, 0, ?, 1, ?, NULL, NULL, NULL, '0x', 'application', 1, 0)`)
      .run(ids[0]!.id, word(99), word(100));
    database.prepare(`INSERT INTO ingestion_errors(chain_id, kernel_address, block_number, block_hash, transaction_hash, ethereum_log_index,
      category, error_code, error_details, raw_log_json, first_seen_at, last_seen_at, occurrences, retryable)
      VALUES ('31337', ?, '2', ?, ?, '2', 'RECEIPT', 'RECEIPT_INVALID', '{}', '{}', ?, ?, 1, 0)`)
      .run(address(2), word(12), word(22), now, now);
  } finally { database.close(); }
}

test("machine-readable health reports chain, kernel, lag, reorg, quarantine and execution gaps", () => {
  const directory = mkdtempSync(join(tmpdir(), "swaputer-indexer-health-"));
  const path = join(directory, "index.sqlite");
  try {
    seed(path);
    const database = openIndexerDatabase(path);
    try {
      const health = getIndexerHealth(database, { databasePath: path, observedHead: 5n, lastSuccessfulScanAt: "2026-08-29T00:02:00.000Z", now: "2026-08-29T00:03:00.000Z" });
      assert.equal(health.status, "lagging");
      assert.equal(health.streams.length, 1);
      assert.deepEqual(health.streams[0], {
        chainId: 31337n, kernelAddress: address(2), cursor: 3n, head: 5n, finalizedHeight: 1n, rpcLag: 3n,
        reorgCount: 1n, maximumObservedReorgDepth: 1n, quarantinedEvents: 1n, malformedReceipts: 1n,
        executionHeightGaps: 1n, unknownDeploymentCodeHashes: 0n, abiDecodeFailures: 0n,
        canonicalExecutions: 2n, finalizedExecutions: 1n, orphanExecutions: 0n
      });
      assert.ok(health.databaseBytes > 0n);
    } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("backup and restore preserve raw receipts and derived views rebuild only from raw records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "swaputer-indexer-backup-"));
  const source = join(directory, "source.sqlite");
  const backup = join(directory, "backup.sqlite");
  const restored = join(directory, "restored.sqlite");
  try {
    seed(source);
    const sourceDatabase = openIndexerDatabase(source);
    let before: unknown;
    try {
      before = sourceDatabase.prepare("SELECT transaction_hash, raw_receipt_payload FROM vm_executions ORDER BY id").all();
      const rebuilt = rebuildDecodedEvents(sourceDatabase, {}, "2026-08-29T00:04:00.000Z");
      assert.equal(rebuilt.recordsProcessed, 1n);
      assert.equal(rebuilt.unknown, 1n);
      assert.deepEqual(sourceDatabase.prepare("SELECT transaction_hash, raw_receipt_payload FROM vm_executions ORDER BY id").all(), before);
    } finally { sourceDatabase.close(); }
    const backupResult = await backupIndexerDatabase(source, backup);
    const restoreResult = await restoreIndexerDatabase(backup, restored);
    assert.equal(backupResult.integrity, "ok");
    assert.equal(restoreResult.integrity, "ok");
    const restoredDatabase = openIndexerDatabase(restored);
    try {
      assert.deepEqual(restoredDatabase.prepare("SELECT transaction_hash, raw_receipt_payload FROM vm_executions ORDER BY id").all(), before);
      assert.equal((restoredDatabase.prepare("SELECT count(*) value FROM decoded_events").get() as { value: bigint }).value, 1n);
    } finally { restoredDatabase.close(); }
    await assert.rejects(() => restoreIndexerDatabase(backup, restored));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("multi-RPC config stores environment names only and has deterministic priority", () => {
  assert.deepEqual(validateRpcEndpointConfig([
    { environmentVariable: "SWAPVM_RPC_SECONDARY", priority: 2 },
    { environmentVariable: "SWAPVM_RPC_PRIMARY", priority: 1 }
  ]), [
    { environmentVariable: "SWAPVM_RPC_PRIMARY", priority: 1 },
    { environmentVariable: "SWAPVM_RPC_SECONDARY", priority: 2 }
  ]);
  assert.throws(() => validateRpcEndpointConfig([{ environmentVariable: "https://secret.invalid", priority: 0 }]));
});

test("graceful shutdown is idempotent and observable without terminating the process", async () => {
  const shutdown = new GracefulShutdown([]);
  try {
    assert.equal(shutdown.requested, false);
    shutdown.request();
    shutdown.request();
    await shutdown.wait();
    assert.equal(shutdown.requested, true);
  } finally { shutdown.dispose(); }
});
