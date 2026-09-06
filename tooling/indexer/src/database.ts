import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { IndexerError, IndexerErrorCode } from "./errors.js";
import { parseDecimal } from "./encoding.js";
import type { Bytes32, IndexerStatus } from "./types.js";

export type SqliteDatabase = Database.Database;

function defaultMigrationsDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
}

export function openIndexerDatabase(path: string): SqliteDatabase {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const database = new Database(path);
  database.defaultSafeIntegers(true);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
  return database;
}

export function migrate(database: SqliteDatabase, migrationsDirectory = defaultMigrationsDirectory()): void {
  database
    .transaction(() =>
      database.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL) STRICT"
      )
    )
    .immediate();
  const files = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const applied = database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
    version: bigint;
    name: string;
  }>;
  const appliedByVersion = new Map(applied.map((row) => [Number(row.version), row.name]));
  const runMigration = database.transaction((version: number, name: string, sql: string) => {
    database.exec(sql);
    database
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(BigInt(version), name, new Date().toISOString());
  });
  for (const name of files) {
    const version = Number.parseInt(name.slice(0, 3), 10);
    const existing = appliedByVersion.get(version);
    if (existing !== undefined) {
      if (existing !== name) {
        throw new IndexerError(IndexerErrorCode.MIGRATION_INVALID, "INTEGRITY", {
          fatal: true,
          details: { version, expected: existing, actual: name }
        });
      }
      continue;
    }
    runMigration.immediate(version, name, readFileSync(resolve(migrationsDirectory, name), "utf8"));
  }
}

interface StatusRow {
  readonly chain_id: string;
  readonly kernel_address: string;
  readonly canonical_tip: string | null;
  readonly canonical_tip_hash: string | null;
  readonly finalized_tip: string | null;
  readonly next_block: string;
  readonly executions: bigint;
  readonly records: bigint;
  readonly deployments: bigint;
  readonly errors: bigint;
  readonly updated_at: string;
}

export function getStatuses(database: SqliteDatabase): readonly IndexerStatus[] {
  const rows = database
    .prepare(
      `SELECT c.chain_id,
              c.kernel_address,
              (SELECT b.block_number FROM blocks b WHERE b.chain_id = c.chain_id AND b.canonical = 1
                 ORDER BY length(b.block_number) DESC, b.block_number DESC LIMIT 1) canonical_tip,
              (SELECT b.block_hash FROM blocks b WHERE b.chain_id = c.chain_id AND b.canonical = 1
                 ORDER BY length(b.block_number) DESC, b.block_number DESC LIMIT 1) canonical_tip_hash,
              (SELECT b.block_number FROM blocks b WHERE b.chain_id = c.chain_id AND b.canonical = 1 AND b.finalized = 1
                 ORDER BY length(b.block_number) DESC, b.block_number DESC LIMIT 1) finalized_tip,
              c.next_block,
              (SELECT count(*) FROM vm_executions e WHERE e.chain_id = c.chain_id AND e.kernel_address = c.kernel_address AND e.canonical = 1) executions,
              (SELECT count(*) FROM vm_records r JOIN vm_executions e ON e.id = r.execution_id
                 WHERE e.chain_id = c.chain_id AND e.kernel_address = c.kernel_address AND r.canonical = 1) records,
              (SELECT count(*) FROM program_deployments d WHERE d.chain_id = c.chain_id AND d.kernel_address = c.kernel_address AND d.canonical = 1) deployments,
              (SELECT count(*) FROM ingestion_errors q WHERE q.chain_id = c.chain_id AND q.kernel_address = c.kernel_address) errors,
              c.updated_at
         FROM ingestion_cursor c
         ORDER BY length(c.chain_id), c.chain_id, c.kernel_address`
    )
    .all() as StatusRow[];
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        chainId: parseDecimal(row.chain_id),
        kernelAddress: row.kernel_address as `0x${string}`,
        canonicalTip: row.canonical_tip === null ? null : parseDecimal(row.canonical_tip),
        canonicalTipHash: row.canonical_tip_hash as Bytes32 | null,
        finalizedTip: row.finalized_tip === null ? null : parseDecimal(row.finalized_tip),
        nextBlock: parseDecimal(row.next_block),
        executions: row.executions,
        records: row.records,
        deployments: row.deployments,
        quarantineErrors: row.errors,
        lastSyncAt: row.updated_at
      })
    )
  );
}

export function listExecutions(database: SqliteDatabase, canonicalOnly = true): readonly Readonly<Record<string, unknown>>[] {
  return database
    .prepare(
      `SELECT chain_id, kernel_address, block_number, block_hash, transaction_hash, transaction_index,
              ethereum_log_index, world_id, execution_height, raw_receipt_payload, receipt_version,
              receipt_flags, canonical, finalized
         FROM vm_executions
        ${canonicalOnly ? "WHERE canonical = 1" : ""}
        ORDER BY length(block_number), block_number, length(transaction_index), transaction_index,
                 length(ethereum_log_index), ethereum_log_index`
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
}

export function listRecords(database: SqliteDatabase, canonicalOnly = true): readonly Readonly<Record<string, unknown>>[] {
  return database
    .prepare(
      `SELECT e.chain_id, e.kernel_address, e.block_hash, e.transaction_hash, e.ethereum_log_index,
              r.event_index, r.emitter, r.topic_count, r.topic0, r.topic1, r.topic2, r.topic3,
              r.raw_data, r.kernel_record_kind, r.canonical, r.finalized
         FROM vm_records r JOIN vm_executions e ON e.id = r.execution_id
        ${canonicalOnly ? "WHERE r.canonical = 1" : ""}
        ORDER BY e.id, r.event_index`
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
}

export function listDeployments(database: SqliteDatabase, canonicalOnly = true): readonly Readonly<Record<string, unknown>>[] {
  return database
    .prepare(
      `SELECT chain_id, kernel_address, world_id, contract_id, creator, code_hash,
              execution_id, event_index, canonical, finalized
         FROM program_deployments
        ${canonicalOnly ? "WHERE canonical = 1" : ""}
        ORDER BY id`
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
}
