import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import { getStatuses, migrate, openIndexerDatabase, type SqliteDatabase } from "./database.js";
import { IndexerError, IndexerErrorCode } from "./errors.js";

export interface RpcEndpointConfig {
  readonly environmentVariable: string;
  readonly priority: number;
}

export interface IndexerHealthOptions {
  readonly databasePath: string;
  readonly observedHead: bigint;
  readonly lastSuccessfulScanAt: string | null;
  readonly now?: string;
}

export interface IndexerHealth {
  readonly status: "healthy" | "lagging" | "uninitialized";
  readonly generatedAt: string;
  readonly databaseBytes: bigint;
  readonly lastSuccessfulScanAt: string | null;
  readonly streams: readonly Readonly<{
    chainId: bigint;
    kernelAddress: string;
    cursor: bigint;
    head: bigint;
    finalizedHeight: bigint | null;
    rpcLag: bigint;
    reorgCount: bigint;
    maximumObservedReorgDepth: bigint;
    quarantinedEvents: bigint;
    malformedReceipts: bigint;
    executionHeightGaps: bigint;
    unknownDeploymentCodeHashes: bigint;
    abiDecodeFailures: bigint;
    canonicalExecutions: bigint;
    finalizedExecutions: bigint;
    orphanExecutions: bigint;
  }>[];
}

function scalar(database: SqliteDatabase, sql: string, ...parameters: readonly unknown[]): bigint {
  const row = database.prepare(sql).get(...parameters) as { value: bigint } | undefined;
  return row?.value ?? 0n;
}

export function validateRpcEndpointConfig(value: readonly RpcEndpointConfig[]): readonly RpcEndpointConfig[] {
  if (value.length < 2) throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { details: { reason: "MULTI_RPC_REQUIRED" } });
  const names = new Set<string>();
  const priorities = new Set<number>();
  for (const endpoint of value) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(endpoint.environmentVariable) || !Number.isSafeInteger(endpoint.priority) || endpoint.priority < 0 || names.has(endpoint.environmentVariable) || priorities.has(endpoint.priority)) {
      throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { details: { reason: "INVALID_RPC_CONFIG" } });
    }
    names.add(endpoint.environmentVariable);
    priorities.add(endpoint.priority);
  }
  return Object.freeze([...value].sort((left, right) => left.priority - right.priority).map((item) => Object.freeze({ ...item })));
}

export function getIndexerHealth(database: SqliteDatabase, options: IndexerHealthOptions): IndexerHealth {
  const statuses = getStatuses(database);
  const streams = statuses.map((stream) => {
    const identity = [stream.chainId.toString(), stream.kernelAddress] as const;
    const lag = options.observedHead >= stream.nextBlock ? options.observedHead - stream.nextBlock + 1n : 0n;
    const reorgCount = scalar(database, "SELECT count(DISTINCT orphaned_at) value FROM blocks WHERE chain_id = ? AND canonical = 0 AND orphaned_at IS NOT NULL", identity[0]);
    const maximumObservedReorgDepth = scalar(database, "SELECT coalesce(max(depth), 0) value FROM (SELECT count(*) depth FROM blocks WHERE chain_id = ? AND canonical = 0 AND orphaned_at IS NOT NULL GROUP BY orphaned_at)", identity[0]);
    const quarantinedEvents = scalar(database, "SELECT count(*) value FROM ingestion_errors WHERE chain_id = ? AND kernel_address = ?", ...identity);
    const malformedReceipts = scalar(database, "SELECT count(*) value FROM ingestion_errors WHERE chain_id = ? AND kernel_address = ? AND category = 'RECEIPT'", ...identity);
    const executionHeightGaps = scalar(database, `SELECT count(*) value FROM (
      SELECT CAST(execution_height AS INTEGER) current_height,
             lag(CAST(execution_height AS INTEGER)) OVER (PARTITION BY world_id ORDER BY CAST(execution_height AS INTEGER)) previous_height
        FROM vm_executions WHERE chain_id = ? AND kernel_address = ? AND canonical = 1
    ) WHERE previous_height IS NOT NULL AND current_height != previous_height + 1`, ...identity);
    const unknownDeploymentCodeHashes = scalar(database, `SELECT count(*) value FROM program_abi_bindings
      WHERE chain_id = ? AND kernel_address = ? AND (binding_status != 'bound' OR trust_level = 'unknown')`, ...identity);
    const abiDecodeFailures = scalar(database, `SELECT count(*) value FROM event_decode_errors d
      JOIN vm_executions e ON e.id = d.execution_id WHERE e.chain_id = ? AND e.kernel_address = ? AND e.canonical = 1`, ...identity);
    const canonicalExecutions = scalar(database, "SELECT count(*) value FROM vm_executions WHERE chain_id = ? AND kernel_address = ? AND canonical = 1", ...identity);
    const finalizedExecutions = scalar(database, "SELECT count(*) value FROM vm_executions WHERE chain_id = ? AND kernel_address = ? AND canonical = 1 AND finalized = 1", ...identity);
    const orphanExecutions = scalar(database, "SELECT count(*) value FROM vm_executions WHERE chain_id = ? AND kernel_address = ? AND canonical = 0", ...identity);
    return Object.freeze({
      chainId: stream.chainId,
      kernelAddress: stream.kernelAddress,
      cursor: stream.nextBlock,
      head: options.observedHead,
      finalizedHeight: stream.finalizedTip,
      rpcLag: lag,
      reorgCount,
      maximumObservedReorgDepth,
      quarantinedEvents,
      malformedReceipts,
      executionHeightGaps,
      unknownDeploymentCodeHashes,
      abiDecodeFailures,
      canonicalExecutions,
      finalizedExecutions,
      orphanExecutions
    });
  });
  const status = streams.length === 0 ? "uninitialized" : streams.some((stream) => stream.rpcLag > 0n) ? "lagging" : "healthy";
  return Object.freeze({
    status,
    generatedAt: options.now ?? new Date().toISOString(),
    databaseBytes: options.databasePath === ":memory:" || !existsSync(options.databasePath) ? 0n : BigInt(statSync(options.databasePath).size),
    lastSuccessfulScanAt: options.lastSuccessfulScanAt,
    streams: Object.freeze(streams)
  });
}

export interface DatabaseCopyResult {
  readonly source: string;
  readonly destination: string;
  readonly bytes: bigint;
  readonly sha256: string;
  readonly integrity: "ok";
}

function digest(path: string): string {
  const database = openIndexerDatabase(path);
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { fatal: true });
  } finally {
    database.close();
  }
  const bytes = statSync(path).size;
  const hash = createHash("sha256");
  const reader = openIndexerDatabase(path);
  try {
    const serialized = reader.serialize();
    hash.update(serialized);
  } finally {
    reader.close();
  }
  return `${bytes}:${hash.digest("hex")}`;
}

function copyResult(source: string, destination: string): DatabaseCopyResult {
  const [bytes, sha256] = digest(destination).split(":");
  if (bytes === undefined || sha256 === undefined) throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { fatal: true });
  return Object.freeze({ source, destination, bytes: BigInt(bytes), sha256, integrity: "ok" });
}

export async function backupIndexerDatabase(source: string, destination: string): Promise<DatabaseCopyResult> {
  if (source === ":memory:" || source === destination || !existsSync(source) || existsSync(destination)) {
    throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { details: { reason: "UNSAFE_BACKUP_PATH" } });
  }
  const database = openIndexerDatabase(source);
  try {
    database.pragma("wal_checkpoint(FULL)");
    await database.backup(destination);
  } finally {
    database.close();
  }
  return copyResult(source, destination);
}

export async function restoreIndexerDatabase(backup: string, destination: string): Promise<DatabaseCopyResult> {
  if (backup === destination || !existsSync(backup) || existsSync(destination)) {
    throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { details: { reason: "UNSAFE_RESTORE_PATH" } });
  }
  const database = openIndexerDatabase(backup);
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { fatal: true });
    await database.backup(destination);
  } finally {
    database.close();
  }
  return copyResult(backup, destination);
}

export class GracefulShutdown {
  #requested = false;
  #resolve!: () => void;
  readonly #promise: Promise<void>;
  readonly #handlers = new Map<NodeJS.Signals, () => void>();

  constructor(signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"]) {
    this.#promise = new Promise((resolve) => { this.#resolve = resolve; });
    for (const signal of signals) {
      const handler = () => this.request();
      this.#handlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  get requested(): boolean { return this.#requested; }
  wait(): Promise<void> { return this.#promise; }
  request(): void {
    if (this.#requested) return;
    this.#requested = true;
    this.#resolve();
  }
  dispose(): void {
    for (const [signal, handler] of this.#handlers) process.off(signal, handler);
    this.#handlers.clear();
  }
}

export function initializeOperationsDatabase(path: string): SqliteDatabase {
  const database = openIndexerDatabase(path);
  migrate(database);
  return database;
}
