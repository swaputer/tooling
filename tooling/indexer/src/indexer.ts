import type Database from "better-sqlite3";

import { decimal, normalizeAddress, normalizeBytes32, parseDecimal, parseQuantity, sleep, stringifyJson, toQuantity } from "./encoding.js";
import { IndexerError, IndexerErrorCode, RpcRangeTooLargeError, isIndexerError } from "./errors.js";
import { parseEvents, EVENTS_TOPIC } from "./events.js";
import { rebuildDecodedEvents } from "./derived-events.js";
import { installVerifiedReferenceRegistry } from "./registry.js";
import type {
  BlockHeader,
  Bytes32,
  IndexerConfig,
  IndexerHooks,
  RpcBlock,
  RpcLog,
  RpcTransport,
  SyncResult
} from "./types.js";

interface CursorRow {
  readonly next_block: string;
  readonly last_canonical_block_hash: string | null;
}

interface BlockRow {
  readonly block_number: string;
  readonly block_hash: string;
  readonly finalized: bigint;
}

interface HeightRow {
  readonly execution_height: string;
  readonly id: bigint;
  readonly block_hash: string;
  readonly transaction_hash: string;
  readonly ethereum_log_index: string;
}

interface ExistingExecutionRow {
  readonly id: bigint;
  readonly canonical: bigint;
  readonly execution_height: string;
}

interface DeploymentRow {
  readonly code_hash: string;
}

interface CountRow {
  readonly value: bigint;
}

const DEFAULT_MAX_RPC_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 25;

function bigintMin(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function compareLogs(left: RpcLog, right: RpcLog): number {
  const leftBlock = parseQuantity(left.blockNumber);
  const rightBlock = parseQuantity(right.blockNumber);
  if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
  const leftTransaction = parseQuantity(left.transactionIndex);
  const rightTransaction = parseQuantity(right.transactionIndex);
  if (leftTransaction !== rightTransaction) return leftTransaction < rightTransaction ? -1 : 1;
  const leftLog = parseQuantity(left.logIndex);
  const rightLog = parseQuantity(right.logIndex);
  return leftLog === rightLog ? 0 : leftLog < rightLog ? -1 : 1;
}

function validateConfig(config: IndexerConfig): void {
  normalizeAddress(config.kernelAddress);
  if (
    config.chainId < 0n ||
    config.startBlock < 0n ||
    config.confirmations < 0n ||
    config.chunkSize <= 0n ||
    config.maxReorgDepth <= 0n ||
    (config.targetBlock !== undefined && config.targetBlock < config.startBlock)
  ) {
    throw new IndexerError(IndexerErrorCode.KERNEL_CONFIG_MISMATCH, "INTEGRITY", { fatal: true });
  }
  if (config.worldId !== undefined) normalizeBytes32(config.worldId);
}

export class SwapVMIndexer {
  readonly #database: Database.Database;
  readonly #transport: RpcTransport;
  readonly #hooks: Required<IndexerHooks>;

  constructor(database: Database.Database, transport: RpcTransport, hooks: IndexerHooks = {}) {
    this.#database = database;
    this.#transport = transport;
    this.#hooks = {
      beforeBlockCommit: hooks.beforeBlockCommit ?? (() => undefined),
      sleep: hooks.sleep ?? sleep,
      now: hooks.now ?? (() => new Date().toISOString())
    };
  }

  async sync(config: IndexerConfig): Promise<SyncResult> {
    validateConfig(config);
    const kernel = normalizeAddress(config.kernelAddress);
    const remoteChainId = parseQuantity(await this.#rpc<string>(config, "eth_chainId", []));
    if (remoteChainId !== config.chainId) {
      throw new IndexerError(IndexerErrorCode.CHAIN_ID_MISMATCH, "INTEGRITY", {
        fatal: true,
        details: { expected: config.chainId, actual: remoteChainId }
      });
    }
    const genesis = await this.#block(config, 0n);
    if (genesis === null) throw new IndexerError(IndexerErrorCode.INVALID_RPC_BLOCK, "RPC", { retryable: true });
    this.#ensureConfiguration(config, kernel, genesis.hash);

    const initialCursor = this.#cursor(config.chainId, kernel);
    const fromBlock = parseDecimal(initialCursor.next_block);
    let latest = parseQuantity(await this.#rpc<string>(config, "eth_blockNumber", []));
    let scanEnd = config.targetBlock === undefined ? latest : bigintMin(latest, config.targetBlock);
    let reorgsApplied = await this.#reconcile(config, kernel, latest);
    let blocksCommitted = 0n;
    let executionsCommitted = 0n;
    let quarantinedEvents = 0n;

    while (true) {
      const cursor = parseDecimal(this.#cursor(config.chainId, kernel).next_block);
      latest = parseQuantity(await this.#rpc<string>(config, "eth_blockNumber", []));
      scanEnd = config.targetBlock === undefined ? latest : bigintMin(latest, config.targetBlock);
      reorgsApplied += await this.#reconcile(config, kernel, latest);
      const reconciledCursor = parseDecimal(this.#cursor(config.chainId, kernel).next_block);
      if (reconciledCursor !== cursor) continue;
      if (cursor > scanEnd) break;

      let chunkEnd = bigintMin(scanEnd, cursor + config.chunkSize - 1n);
      let logs: RpcLog[];
      while (true) {
        try {
          logs = await this.#rpc<RpcLog[]>(config, "eth_getLogs", [
            { address: kernel, topics: [EVENTS_TOPIC], fromBlock: toQuantity(cursor), toBlock: toQuantity(chunkEnd) }
          ]);
          break;
        } catch (error) {
          if (!(error instanceof RpcRangeTooLargeError) || chunkEnd === cursor) throw error;
          chunkEnd = cursor + (chunkEnd - cursor) / 2n;
        }
      }
      logs.sort(compareLogs);

      let restartAfterReorg = false;
      for (let blockNumber = cursor; blockNumber <= chunkEnd; blockNumber += 1n) {
        const header = await this.#block(config, blockNumber);
        if (header === null) {
          throw new IndexerError(IndexerErrorCode.INVALID_RPC_BLOCK, "RPC", {
            retryable: true,
            details: { blockNumber }
          });
        }
        const localAtHeight = this.#canonicalBlock(config.chainId, blockNumber);
        if (localAtHeight !== undefined && localAtHeight.block_hash !== header.hash) {
          reorgsApplied += await this.#applyReorg(config, kernel, latest);
          restartAfterReorg = true;
          break;
        }
        const localParent = blockNumber === 0n ? undefined : this.#canonicalBlock(config.chainId, blockNumber - 1n);
        if (localParent !== undefined && localParent.block_hash !== header.parentHash) {
          reorgsApplied += await this.#applyReorg(config, kernel, latest);
          restartAfterReorg = true;
          break;
        }
        const blockLogs = logs.filter((log) => parseQuantity(log.blockNumber) === blockNumber);
        const committed = this.#commitBlock(config, kernel, header, blockLogs);
        blocksCommitted += 1n;
        executionsCommitted += committed.executions;
        quarantinedEvents += committed.quarantined;
      }
      if (restartAfterReorg) continue;
    }

    const finalizedBlock = latest >= config.confirmations ? latest - config.confirmations : null;
    this.#updateFinality(config.chainId, finalizedBlock);
    installVerifiedReferenceRegistry(this.#database, this.#hooks.now());
    rebuildDecodedEvents(this.#database, { chainId: config.chainId, kernelAddress: kernel }, this.#hooks.now());
    const nextBlock = parseDecimal(this.#cursor(config.chainId, kernel).next_block);
    return Object.freeze({
      chainId: config.chainId,
      kernelAddress: kernel,
      fromBlock,
      nextBlock,
      latestBlock: latest,
      targetBlock: config.targetBlock ?? null,
      finalizedBlock,
      blocksCommitted,
      executionsCommitted,
      quarantinedEvents,
      reorgsApplied
    });
  }

  async #rpc<T>(config: IndexerConfig, method: string, params: readonly unknown[]): Promise<T> {
    const retries = config.maxRpcRetries ?? DEFAULT_MAX_RPC_RETRIES;
    const delay = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    let attempt = 0;
    while (true) {
      try {
        return await this.#transport.request<T>(method, params);
      } catch (error) {
        if (error instanceof RpcRangeTooLargeError) throw error;
        const retryable = isIndexerError(error) ? error.retryable : true;
        if (!retryable) throw error;
        if (attempt >= retries) {
          const exhausted = new IndexerError(IndexerErrorCode.RPC_RETRIES_EXHAUSTED, "RPC", {
            retryable: true,
            details: { method, attempts: attempt + 1 }
          });
          const kernel = normalizeAddress(config.kernelAddress);
          const configured = this.#database
            .prepare("SELECT 1 value FROM ingestion_cursor WHERE chain_id = ? AND kernel_address = ?")
            .get(decimal(config.chainId), kernel) as CountRow | undefined;
          if (configured !== undefined) {
            this.#database
              .transaction(() => this.#recordError(config.chainId, kernel, null, null, null, null, exhausted, null))
              .immediate();
          }
          throw exhausted;
        }
        await this.#hooks.sleep(delay * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  async #block(config: IndexerConfig, number: bigint): Promise<BlockHeader | null> {
    const raw = await this.#rpc<RpcBlock | null>(config, "eth_getBlockByNumber", [toQuantity(number), false]);
    if (raw === null) return null;
    const parsedNumber = parseQuantity(raw.number);
    if (parsedNumber !== number) throw new IndexerError(IndexerErrorCode.INVALID_RPC_BLOCK, "RPC", { retryable: true });
    return Object.freeze({
      number,
      hash: normalizeBytes32(raw.hash),
      parentHash: normalizeBytes32(raw.parentHash),
      timestamp: parseQuantity(raw.timestamp)
    });
  }

  #ensureConfiguration(config: IndexerConfig, kernel: string, genesisHash: string): void {
    const now = this.#hooks.now();
    const transaction = this.#database.transaction(() => {
      const chain = this.#database.prepare("SELECT genesis_block_hash FROM chains WHERE chain_id = ?").get(decimal(config.chainId)) as
        | { genesis_block_hash: string }
        | undefined;
      if (chain !== undefined && chain.genesis_block_hash !== genesisHash) {
        throw new IndexerError(IndexerErrorCode.CHAIN_IDENTITY_MISMATCH, "INTEGRITY", { fatal: true });
      }
      this.#database
        .prepare("INSERT OR IGNORE INTO chains(chain_id, genesis_block_hash, config_json, created_at) VALUES (?, ?, ?, ?)")
        .run(decimal(config.chainId), genesisHash, "{}", now);

      const existing = this.#database
        .prepare(
          "SELECT world_id_filter, start_block, confirmations, chunk_size, max_reorg_depth FROM kernels WHERE chain_id = ? AND kernel_address = ?"
        )
        .get(decimal(config.chainId), kernel) as
        | {
            world_id_filter: string | null;
            start_block: string;
            confirmations: string;
            chunk_size: string;
            max_reorg_depth: string;
          }
        | undefined;
      const world = config.worldId?.toLowerCase() ?? null;
      if (
        existing !== undefined &&
        (existing.world_id_filter !== world ||
          existing.start_block !== decimal(config.startBlock) ||
          existing.confirmations !== decimal(config.confirmations) ||
          existing.chunk_size !== decimal(config.chunkSize) ||
          existing.max_reorg_depth !== decimal(config.maxReorgDepth))
      ) {
        throw new IndexerError(IndexerErrorCode.KERNEL_CONFIG_MISMATCH, "INTEGRITY", { fatal: true });
      }
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO kernels(
             chain_id, kernel_address, world_id_filter, start_block, enabled, confirmations,
             chunk_size, max_reorg_depth, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
        )
        .run(
          decimal(config.chainId),
          kernel,
          world,
          decimal(config.startBlock),
          decimal(config.confirmations),
          decimal(config.chunkSize),
          decimal(config.maxReorgDepth),
          now,
          now
        );
      this.#database
        .prepare(
          "INSERT OR IGNORE INTO ingestion_cursor(chain_id, kernel_address, next_block, last_canonical_block_hash, updated_at) VALUES (?, ?, ?, NULL, ?)"
        )
        .run(decimal(config.chainId), kernel, decimal(config.startBlock), now);
    });
    transaction.immediate();
  }

  #cursor(chainId: bigint, kernel: string): CursorRow {
    const row = this.#database
      .prepare("SELECT next_block, last_canonical_block_hash FROM ingestion_cursor WHERE chain_id = ? AND kernel_address = ?")
      .get(decimal(chainId), kernel) as CursorRow | undefined;
    if (row === undefined) throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { fatal: true });
    return row;
  }

  #canonicalBlock(chainId: bigint, blockNumber: bigint): BlockRow | undefined {
    return this.#database
      .prepare("SELECT block_number, block_hash, finalized FROM blocks WHERE chain_id = ? AND block_number = ? AND canonical = 1")
      .get(decimal(chainId), decimal(blockNumber)) as BlockRow | undefined;
  }

  #canonicalTip(chainId: bigint): BlockRow | undefined {
    return this.#database
      .prepare(
        "SELECT block_number, block_hash, finalized FROM blocks WHERE chain_id = ? AND canonical = 1 ORDER BY length(block_number) DESC, block_number DESC LIMIT 1"
      )
      .get(decimal(chainId)) as BlockRow | undefined;
  }

  async #reconcile(config: IndexerConfig, kernel: string, latest: bigint): Promise<bigint> {
    const tip = this.#canonicalTip(config.chainId);
    if (tip === undefined) return 0n;
    const tipNumber = parseDecimal(tip.block_number);
    const remote = tipNumber <= latest ? await this.#block(config, tipNumber) : null;
    if (remote !== null && remote.hash === tip.block_hash) return 0n;
    return this.#applyReorg(config, kernel, latest);
  }

  async #applyReorg(config: IndexerConfig, kernel: string, latest: bigint): Promise<bigint> {
    const tip = this.#canonicalTip(config.chainId);
    if (tip === undefined) return 0n;
    const tipNumber = parseDecimal(tip.block_number);
    let candidate = bigintMin(tipNumber, latest);
    let ancestor: bigint | null = null;
    while (candidate >= 0n && tipNumber - candidate <= config.maxReorgDepth) {
      const local = this.#canonicalBlock(config.chainId, candidate);
      const remote = await this.#block(config, candidate);
      if (local !== undefined && remote !== null && local.block_hash === remote.hash) {
        ancestor = candidate;
        break;
      }
      if (candidate === 0n) break;
      candidate -= 1n;
    }
    if (ancestor === null && config.startBlock > 0n && tipNumber - (config.startBlock - 1n) <= config.maxReorgDepth) {
      ancestor = config.startBlock - 1n;
    }
    if (ancestor === null || tipNumber - ancestor > config.maxReorgDepth) {
      const error = new IndexerError(IndexerErrorCode.REORG_DEPTH_EXCEEDED, "REORG", {
        fatal: true,
        details: { tip: tipNumber, maximum: config.maxReorgDepth }
      });
      const transaction = this.#database.transaction(() => {
        this.#recordError(config.chainId, kernel, null, null, null, null, error, null);
      });
      transaction.immediate();
      throw error;
    }

    const now = this.#hooks.now();
    const orphaned = this.#database
      .prepare("SELECT block_hash, block_number FROM blocks WHERE chain_id = ? AND canonical = 1")
      .all(decimal(config.chainId)) as Array<{ block_hash: string; block_number: string }>;
    const orphanHashes = orphaned
      .filter((row) => parseDecimal(row.block_number) > ancestor)
      .map((row) => row.block_hash);
    const transaction = this.#database.transaction(() => {
      for (const hash of orphanHashes) {
        this.#database
          .prepare("UPDATE blocks SET canonical = 0, finalized = 0, orphaned_at = ? WHERE chain_id = ? AND block_hash = ?")
          .run(now, decimal(config.chainId), hash);
        const executionIds = this.#database
          .prepare("SELECT id FROM vm_executions WHERE chain_id = ? AND block_hash = ? AND canonical = 1")
          .all(decimal(config.chainId), hash) as Array<{ id: bigint }>;
        for (const row of executionIds) {
          this.#database.prepare("UPDATE vm_records SET canonical = 0, finalized = 0 WHERE execution_id = ?").run(row.id);
          this.#database
            .prepare("UPDATE program_deployments SET canonical = 0, finalized = 0 WHERE execution_id = ?")
            .run(row.id);
        }
        this.#database
          .prepare("UPDATE vm_executions SET canonical = 0, finalized = 0 WHERE chain_id = ? AND block_hash = ?")
          .run(decimal(config.chainId), hash);
      }
      const next = ancestor + 1n;
      const cursors = this.#database.prepare("SELECT kernel_address, next_block FROM ingestion_cursor WHERE chain_id = ?").all(
        decimal(config.chainId)
      ) as Array<{ kernel_address: string; next_block: string }>;
      for (const cursor of cursors) {
        if (parseDecimal(cursor.next_block) > next) {
          this.#database
            .prepare(
              "UPDATE ingestion_cursor SET next_block = ?, last_canonical_block_hash = ?, updated_at = ? WHERE chain_id = ? AND kernel_address = ?"
            )
            .run(decimal(next), this.#canonicalBlock(config.chainId, ancestor)?.block_hash ?? null, now, decimal(config.chainId), cursor.kernel_address);
        }
      }
      this.#recordError(
        config.chainId,
        kernel,
        tipNumber,
        tip.block_hash,
        null,
        null,
        new IndexerError(IndexerErrorCode.REORG_DETECTED, "REORG", {
          details: { ancestor, orphanedBlocks: BigInt(orphanHashes.length) }
        }),
        null
      );
    });
    transaction.immediate();
    return 1n;
  }

  #commitBlock(
    config: IndexerConfig,
    kernel: string,
    block: BlockHeader,
    logs: readonly RpcLog[]
  ): { readonly executions: bigint; readonly quarantined: bigint } {
    let executions = 0n;
    let quarantined = 0n;
    const now = this.#hooks.now();
    const transaction = this.#database.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO blocks(
             chain_id, block_number, block_hash, parent_hash, timestamp, canonical, finalized, first_seen_at, orphaned_at
           ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, NULL)
           ON CONFLICT(chain_id, block_hash) DO UPDATE SET canonical = 1, orphaned_at = NULL`
        )
        .run(decimal(config.chainId), decimal(block.number), block.hash, block.parentHash, decimal(block.timestamp), now);

      for (const log of logs) {
        if (log.topics[0]?.toLowerCase() !== EVENTS_TOPIC) continue;
        let normalizedAddress: string;
        try {
          normalizedAddress = normalizeAddress(log.address);
        } catch (error) {
          if (!isIndexerError(error)) throw error;
          const identity = this.#safeLogIdentity(log);
          this.#recordError(
            config.chainId,
            kernel,
            block.number,
            block.hash,
            identity.transactionHash,
            identity.logIndex,
            error,
            stringifyJson(log)
          );
          quarantined += 1n;
          continue;
        }
        if (normalizedAddress !== kernel) continue;
        try {
          const committed = this.#commitLog(config, kernel, block, log, now);
          if (committed) executions += 1n;
        } catch (error) {
          if (!isIndexerError(error) || error.category === "RPC" || error.fatal) throw error;
          const identity = this.#safeLogIdentity(log);
          this.#recordError(
            config.chainId,
            kernel,
            block.number,
            block.hash,
            identity.transactionHash,
            identity.logIndex,
            error,
            stringifyJson(log)
          );
          quarantined += 1n;
        }
      }
      this.#hooks.beforeBlockCommit(block);
      this.#database
        .prepare(
          "UPDATE ingestion_cursor SET next_block = ?, last_canonical_block_hash = ?, updated_at = ? WHERE chain_id = ? AND kernel_address = ?"
        )
        .run(decimal(block.number + 1n), block.hash, now, decimal(config.chainId), kernel);
      this.#database
        .prepare("UPDATE kernels SET updated_at = ? WHERE chain_id = ? AND kernel_address = ?")
        .run(now, decimal(config.chainId), kernel);
    });
    transaction.immediate();
    return { executions, quarantined };
  }

  #commitLog(config: IndexerConfig, kernel: string, block: BlockHeader, log: RpcLog, now: string): boolean {
    const blockNumber = parseQuantity(log.blockNumber);
    const blockHash = normalizeBytes32(log.blockHash);
    const transactionHash = normalizeBytes32(log.transactionHash);
    const transactionIndex = parseQuantity(log.transactionIndex);
    const logIndex = parseQuantity(log.logIndex);
    if (blockNumber !== block.number || blockHash !== block.hash) {
      throw new IndexerError(IndexerErrorCode.LOG_BLOCK_MISMATCH, "INTEGRITY");
    }
    const parsed = parseEvents(log, kernel);
    if (config.worldId !== undefined && parsed.worldId !== config.worldId.toLowerCase()) return false;
    if (parsed.executionHeight === 0n) {
      throw new IndexerError(IndexerErrorCode.EXECUTION_HEIGHT_ZERO, "INTEGRITY");
    }

    const existing = this.#database
      .prepare(
        `SELECT id, canonical, execution_height FROM vm_executions
          WHERE chain_id = ? AND kernel_address = ? AND block_hash = ? AND transaction_hash = ? AND ethereum_log_index = ?`
      )
      .get(decimal(config.chainId), kernel, block.hash, transactionHash, decimal(logIndex)) as ExistingExecutionRow | undefined;
    if (existing !== undefined && existing.canonical === 1n) return false;

    const duplicateHeight = this.#database
      .prepare(
        `SELECT id, execution_height, block_hash, transaction_hash, ethereum_log_index FROM vm_executions
          WHERE chain_id = ? AND kernel_address = ? AND world_id = ? AND execution_height = ? AND canonical = 1`
      )
      .get(decimal(config.chainId), kernel, parsed.worldId, decimal(parsed.executionHeight)) as HeightRow | undefined;
    if (duplicateHeight !== undefined) {
      throw new IndexerError(IndexerErrorCode.EXECUTION_HEIGHT_DUPLICATE, "INTEGRITY", {
        details: { actual: parsed.executionHeight }
      });
    }
    const previous = this.#database
      .prepare(
        `SELECT id, execution_height, block_hash, transaction_hash, ethereum_log_index FROM vm_executions
          WHERE chain_id = ? AND kernel_address = ? AND world_id = ? AND canonical = 1
          ORDER BY length(block_number) DESC, block_number DESC,
                   length(transaction_index) DESC, transaction_index DESC,
                   length(ethereum_log_index) DESC, ethereum_log_index DESC LIMIT 1`
      )
      .get(decimal(config.chainId), kernel, parsed.worldId) as HeightRow | undefined;
    if (previous !== undefined) {
      const expected = parseDecimal(previous.execution_height) + 1n;
      if (parsed.executionHeight !== expected) {
        throw new IndexerError(IndexerErrorCode.EXECUTION_HEIGHT_GAP, "INTEGRITY", {
          details: { expected, actual: parsed.executionHeight }
        });
      }
    }

    const receiptDeployments = new Map<string, string>();
    for (const record of parsed.receipt.records) {
      if (record.kind !== "miniContractDeployed") continue;
      const inReceipt = receiptDeployments.get(record.decoded.contractId);
      if (inReceipt !== undefined) {
        throw new IndexerError(
          inReceipt === record.decoded.codeHash
            ? IndexerErrorCode.DEPLOYMENT_DUPLICATE
            : IndexerErrorCode.DEPLOYMENT_CONFLICT,
          "INTEGRITY",
          { details: { contractId: record.decoded.contractId } }
        );
      }
      receiptDeployments.set(record.decoded.contractId, record.decoded.codeHash);
      const deployment = this.#database
        .prepare(
          `SELECT code_hash FROM program_deployments
            WHERE chain_id = ? AND kernel_address = ? AND world_id = ? AND contract_id = ? AND canonical = 1`
        )
        .get(decimal(config.chainId), kernel, parsed.worldId, record.decoded.contractId) as DeploymentRow | undefined;
      if (deployment !== undefined) {
        throw new IndexerError(
          deployment.code_hash === record.decoded.codeHash
            ? IndexerErrorCode.DEPLOYMENT_DUPLICATE
            : IndexerErrorCode.DEPLOYMENT_CONFLICT,
          "INTEGRITY",
          {
            details: {
              contractId: record.decoded.contractId,
              existing: deployment.code_hash,
              actual: record.decoded.codeHash
            }
          }
        );
      }
    }

    let executionId: bigint;
    if (existing !== undefined) {
      executionId = existing.id;
      this.#database.prepare("UPDATE vm_executions SET canonical = 1, finalized = 0 WHERE id = ?").run(executionId);
      this.#database.prepare("UPDATE vm_records SET canonical = 1, finalized = 0 WHERE execution_id = ?").run(executionId);
      this.#database
        .prepare("UPDATE program_deployments SET canonical = 1, finalized = 0 WHERE execution_id = ?")
        .run(executionId);
      return true;
    }

    const result = this.#database
      .prepare(
        `INSERT INTO vm_executions(
           chain_id, kernel_address, block_number, block_hash, transaction_hash, transaction_index,
           ethereum_log_index, world_id, execution_height, raw_log_data, raw_receipt_payload,
           receipt_version, receipt_flags, canonical, finalized, indexed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
      )
      .run(
        decimal(config.chainId),
        kernel,
        decimal(block.number),
        block.hash,
        transactionHash,
        decimal(transactionIndex),
        decimal(logIndex),
        parsed.worldId,
        decimal(parsed.executionHeight),
        log.data.toLowerCase(),
        parsed.payload,
        BigInt(parsed.receipt.version),
        BigInt(parsed.receipt.flags),
        now
      );
    executionId = BigInt(result.lastInsertRowid);
    parsed.receipt.records.forEach((record, index) => {
      const topics = [...record.topics, null, null, null, null].slice(0, 4);
      const kind =
        record.kind === "worldExecution"
          ? "world_execution"
          : record.kind === "miniContractDeployed"
            ? "mini_contract_deployed"
            : "application";
      this.#database
        .prepare(
          `INSERT INTO vm_records(
             execution_id, event_index, emitter, topic_count, topic0, topic1, topic2, topic3,
             raw_data, kernel_record_kind, canonical, finalized
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
        )
        .run(
          executionId,
          BigInt(index),
          record.emitter,
          BigInt(record.topicCount),
          topics[0] ?? null,
          topics[1] ?? null,
          topics[2] ?? null,
          topics[3] ?? null,
          record.data,
          kind
        );
      if (record.kind === "miniContractDeployed") {
        this.#database
          .prepare(
            `INSERT INTO program_deployments(
               execution_id, event_index, chain_id, kernel_address, world_id,
               contract_id, creator, code_hash, canonical, finalized
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
          )
          .run(
            executionId,
            BigInt(index),
            decimal(config.chainId),
            kernel,
            parsed.worldId,
            record.decoded.contractId,
            record.decoded.creator,
            record.decoded.codeHash
          );
      }
    });
    return true;
  }

  #safeLogIdentity(log: RpcLog): { readonly transactionHash: string | null; readonly logIndex: bigint | null } {
    let transactionHash: string | null = null;
    let logIndex: bigint | null = null;
    try {
      transactionHash = normalizeBytes32(log.transactionHash);
    } catch {}
    try {
      logIndex = parseQuantity(log.logIndex);
    } catch {}
    return { transactionHash, logIndex };
  }

  #recordError(
    chainId: bigint,
    kernel: string,
    blockNumber: bigint | null,
    blockHash: string | null,
    transactionHash: string | null,
    logIndex: bigint | null,
    error: IndexerError,
    rawLog: string | null
  ): void {
    const now = this.#hooks.now();
    const identity = [
      decimal(chainId),
      kernel,
      blockHash ?? "",
      transactionHash ?? "",
      logIndex === null ? "" : decimal(logIndex),
      error.code
    ];
    const existing = this.#database
      .prepare(
        `SELECT id FROM ingestion_errors
          WHERE chain_id = ? AND kernel_address = ? AND ifnull(block_hash, '') = ?
            AND ifnull(transaction_hash, '') = ? AND ifnull(ethereum_log_index, '') = ? AND error_code = ?`
      )
      .get(...identity) as { id: bigint } | undefined;
    if (existing !== undefined) {
      this.#database
        .prepare("UPDATE ingestion_errors SET last_seen_at = ?, occurrences = occurrences + 1 WHERE id = ?")
        .run(now, existing.id);
      return;
    }
    this.#database
      .prepare(
        `INSERT INTO ingestion_errors(
           chain_id, kernel_address, block_number, block_hash, transaction_hash, ethereum_log_index,
           category, error_code, error_details, raw_log_json, first_seen_at, last_seen_at, occurrences, retryable
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        decimal(chainId),
        kernel,
        blockNumber === null ? null : decimal(blockNumber),
        blockHash,
        transactionHash,
        logIndex === null ? null : decimal(logIndex),
        error.category,
        error.code,
        stringifyJson(error.details),
        rawLog,
        now,
        now,
        error.retryable ? 1n : 0n
      );
  }

  #updateFinality(chainId: bigint, finalizedBlock: bigint | null): void {
    const rows = this.#database
      .prepare("SELECT block_hash, block_number, finalized FROM blocks WHERE chain_id = ? AND canonical = 1")
      .all(decimal(chainId)) as BlockRow[];
    const transaction = this.#database.transaction(() => {
      for (const row of rows) {
        const finalized = finalizedBlock !== null && parseDecimal(row.block_number) <= finalizedBlock ? 1n : 0n;
        if (row.finalized === finalized) continue;
        this.#database
          .prepare("UPDATE blocks SET finalized = ? WHERE chain_id = ? AND block_hash = ?")
          .run(finalized, decimal(chainId), row.block_hash);
        const ids = this.#database
          .prepare("SELECT id FROM vm_executions WHERE chain_id = ? AND block_hash = ? AND canonical = 1")
          .all(decimal(chainId), row.block_hash) as Array<{ id: bigint }>;
        for (const item of ids) {
          this.#database.prepare("UPDATE vm_executions SET finalized = ? WHERE id = ?").run(finalized, item.id);
          this.#database.prepare("UPDATE vm_records SET finalized = ? WHERE execution_id = ?").run(finalized, item.id);
          this.#database
            .prepare("UPDATE program_deployments SET finalized = ? WHERE execution_id = ?")
            .run(finalized, item.id);
        }
      }
    });
    transaction.immediate();
  }
}
