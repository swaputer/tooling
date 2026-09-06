import type { Bytes32, Hex } from "@swaputer/receipt-codec";

import type { SqliteDatabase } from "./database.js";
import {
  EVENT_DECODER_VERSION,
  EventAbiError,
  EventAbiErrorCode,
  canonicalJson,
  decodeApplicationEvent,
  normalizeEventAbiDescriptor,
  type SwapVMEventABIV1
} from "./event-abi.js";
import { decimal, normalizeAddress, normalizeBytes32, parseDecimal, stringifyJson } from "./encoding.js";
import type { Address } from "./types.js";

export interface RebuildEventFilters {
  readonly chainId?: bigint;
  readonly kernelAddress?: Address;
  readonly worldId?: Bytes32;
  readonly fromBlock?: bigint;
  readonly toBlock?: bigint;
  readonly registryId?: bigint;
  readonly codeHash?: Bytes32;
}

export interface EventQueryFilters extends RebuildEventFilters {
  readonly emitter?: Bytes32;
  readonly signature?: string;
  readonly account?: Bytes32 | Address;
  readonly tokenId?: bigint;
  readonly canonicalOnly?: boolean;
  readonly finalizedOnly?: boolean;
}

export interface RebuildEventResult {
  readonly recordsProcessed: bigint;
  readonly decoded: bigint;
  readonly unknown: bigint;
  readonly failed: bigint;
  readonly ambiguous: bigint;
  readonly bindings: bigint;
}

interface RegistryRow {
  readonly registry_id: bigint;
  readonly code_hash: string;
  readonly trust_level: "verified_reference" | "declared_unverified";
  readonly descriptor_json: string;
}

interface DeploymentRow {
  readonly deployment_id: bigint;
  readonly execution_id: bigint;
  readonly chain_id: string;
  readonly kernel_address: string;
  readonly world_id: string;
  readonly contract_id: string;
  readonly code_hash: string;
  readonly block_number: string;
  readonly block_hash: string;
  readonly transaction_index: string;
  readonly ethereum_log_index: string;
}

interface BindingRow {
  readonly deployment_id: bigint;
  readonly registry_id: bigint | null;
  readonly trust_level: "verified_reference" | "declared_unverified" | "unknown";
  readonly binding_status: "bound" | "unknown" | "ambiguous";
  readonly code_hash: string;
}

interface ApplicationRow {
  readonly execution_id: bigint;
  readonly event_index: bigint;
  readonly emitter: string;
  readonly topic_count: bigint;
  readonly topic0: string | null;
  readonly topic1: string | null;
  readonly topic2: string | null;
  readonly topic3: string | null;
  readonly raw_data: string;
  readonly chain_id: string;
  readonly kernel_address: string;
  readonly world_id: string;
  readonly block_number: string;
  readonly block_hash: string;
  readonly transaction_index: string;
  readonly ethereum_log_index: string;
}

interface BlockRow {
  readonly chain_id: string;
  readonly block_hash: string;
  readonly parent_hash: string;
  readonly block_number: string;
}

function compareDecimal(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function orderedBeforeOrEqual(deployment: DeploymentRow, event: ApplicationRow): boolean {
  const tx = compareDecimal(deployment.transaction_index, event.transaction_index);
  if (tx !== 0) return tx < 0;
  return compareDecimal(deployment.ethereum_log_index, event.ethereum_log_index) <= 0;
}

function isDeploymentAncestor(
  deployment: DeploymentRow,
  event: ApplicationRow,
  blocks: ReadonlyMap<string, BlockRow>
): boolean {
  if (deployment.execution_id === event.execution_id) return true;
  const deploymentNumber = parseDecimal(deployment.block_number);
  const eventNumber = parseDecimal(event.block_number);
  if (deploymentNumber > eventNumber) return false;
  if (deploymentNumber === eventNumber) {
    return deployment.block_hash === event.block_hash && orderedBeforeOrEqual(deployment, event);
  }
  let cursor = blocks.get(`${event.chain_id}:${event.block_hash}`);
  while (cursor !== undefined && parseDecimal(cursor.block_number) > deploymentNumber) {
    cursor = blocks.get(`${event.chain_id}:${cursor.parent_hash}`);
  }
  return cursor?.block_hash === deployment.block_hash;
}

function selectDeployment(
  event: ApplicationRow,
  deployments: readonly DeploymentRow[],
  blocks: ReadonlyMap<string, BlockRow>
): DeploymentRow | null | "ambiguous" {
  const candidates = deployments.filter(
    (deployment) =>
      deployment.chain_id === event.chain_id &&
      deployment.kernel_address === event.kernel_address &&
      deployment.world_id === event.world_id &&
      deployment.contract_id === event.emitter &&
      isDeploymentAncestor(deployment, event, blocks)
  );
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const block = compareDecimal(right.block_number, left.block_number);
    if (block !== 0) return block;
    const transaction = compareDecimal(right.transaction_index, left.transaction_index);
    if (transaction !== 0) return transaction;
    return compareDecimal(right.ethereum_log_index, left.ethereum_log_index);
  });
  const first = candidates[0];
  const second = candidates[1];
  if (first === undefined) return null;
  if (
    second !== undefined &&
    first.block_number === second.block_number &&
    first.transaction_index === second.transaction_index &&
    first.ethereum_log_index === second.ethereum_log_index &&
    first.execution_id !== second.execution_id
  ) {
    return "ambiguous";
  }
  return first;
}

function insertDecodeStatus(
  database: SqliteDatabase,
  row: ApplicationRow,
  status: "decoded" | "unknown_program" | "unknown_event" | "failed" | "ambiguous",
  now: string,
  deploymentId: bigint | null,
  registryId: bigint | null,
  signature: string | null,
  decodedJson: string | null
): void {
  database
    .prepare(
      `INSERT INTO decoded_events(
         execution_id, event_index, deployment_id, registry_id, event_signature, topic0,
         decoder_version, decoded_json, decode_status, decoded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.execution_id,
      row.event_index,
      deploymentId,
      registryId,
      signature,
      row.topic0,
      BigInt(EVENT_DECODER_VERSION),
      decodedJson,
      status,
      now
    );
}

function recordDecodeError(
  database: SqliteDatabase,
  row: ApplicationRow,
  registryId: bigint | null,
  error: EventAbiError,
  now: string
): void {
  database
    .prepare(
      `INSERT INTO event_decode_errors(
         execution_id, event_index, registry_id, error_code, error_details,
         first_seen_at, last_seen_at, occurrences
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT DO UPDATE SET
         error_details = excluded.error_details,
         last_seen_at = excluded.last_seen_at,
         occurrences = event_decode_errors.occurrences + 1`
    )
    .run(
      row.execution_id,
      row.event_index,
      registryId,
      error.code,
      stringifyJson(error.details),
      now,
      now
    );
  database
    .prepare(
      `DELETE FROM event_decode_errors
        WHERE execution_id = ? AND event_index = ?
          AND NOT (ifnull(registry_id, -1) = ifnull(?, -1) AND error_code = ?)`
    )
    .run(row.execution_id, row.event_index, registryId, error.code);
}

function rebuildBindings(database: SqliteDatabase, now: string): Map<bigint, BindingRow> {
  database.prepare("DELETE FROM program_abi_bindings").run();
  const registries = database
    .prepare("SELECT registry_id, code_hash, trust_level, descriptor_json FROM abi_registry WHERE enabled = 1")
    .all() as RegistryRow[];
  const deployments = database
    .prepare(
      `SELECT d.id deployment_id, d.chain_id, d.kernel_address, d.world_id, d.contract_id, d.code_hash
         FROM program_deployments d ORDER BY d.id`
    )
    .all() as Array<{
      deployment_id: bigint;
      chain_id: string;
      kernel_address: string;
      world_id: string;
      contract_id: string;
      code_hash: string;
    }>;
  const result = new Map<bigint, BindingRow>();
  const insert = database.prepare(
    `INSERT INTO program_abi_bindings(
       deployment_id, chain_id, kernel_address, world_id, emitter, code_hash,
       registry_id, trust_level, binding_status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const deployment of deployments) {
    const candidates = registries.filter((registry) => registry.code_hash === deployment.code_hash);
    const verified = candidates.filter((registry) => registry.trust_level === "verified_reference");
    const selectedLevel = verified.length > 0 ? verified : candidates.filter((registry) => registry.trust_level === "declared_unverified");
    const binding: BindingRow =
      selectedLevel.length === 0
        ? {
            deployment_id: deployment.deployment_id,
            registry_id: null,
            trust_level: "unknown",
            binding_status: "unknown",
            code_hash: deployment.code_hash
          }
        : selectedLevel.length === 1
          ? {
              deployment_id: deployment.deployment_id,
              registry_id: selectedLevel[0]?.registry_id ?? null,
              trust_level: selectedLevel[0]?.trust_level ?? "unknown",
              binding_status: "bound",
              code_hash: deployment.code_hash
            }
          : {
              deployment_id: deployment.deployment_id,
              registry_id: null,
              trust_level: selectedLevel[0]?.trust_level ?? "unknown",
              binding_status: "ambiguous",
              code_hash: deployment.code_hash
            };
    insert.run(
      deployment.deployment_id,
      deployment.chain_id,
      deployment.kernel_address,
      deployment.world_id,
      deployment.contract_id,
      deployment.code_hash,
      binding.registry_id,
      binding.trust_level,
      binding.binding_status,
      now
    );
    result.set(deployment.deployment_id, binding);
  }
  return result;
}

function applicationRows(database: SqliteDatabase, filters: RebuildEventFilters): ApplicationRow[] {
  const clauses = ["r.kernel_record_kind = 'application'"];
  const values: Array<string | bigint> = [];
  if (filters.chainId !== undefined) {
    clauses.push("e.chain_id = ?");
    values.push(decimal(filters.chainId));
  }
  if (filters.kernelAddress !== undefined) {
    clauses.push("e.kernel_address = ?");
    values.push(normalizeAddress(filters.kernelAddress));
  }
  if (filters.worldId !== undefined) {
    clauses.push("e.world_id = ?");
    values.push(normalizeBytes32(filters.worldId));
  }
  const rows = database
    .prepare(
      `SELECT r.execution_id, r.event_index, r.emitter, r.topic_count,
              r.topic0, r.topic1, r.topic2, r.topic3, r.raw_data,
              e.chain_id, e.kernel_address, e.world_id, e.block_number, e.block_hash,
              e.transaction_index, e.ethereum_log_index
         FROM vm_records r JOIN vm_executions e ON e.id = r.execution_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY e.id, r.event_index`
    )
    .all(...values) as ApplicationRow[];
  return rows.filter((row) => {
    const block = parseDecimal(row.block_number);
    return (filters.fromBlock === undefined || block >= filters.fromBlock) &&
      (filters.toBlock === undefined || block <= filters.toBlock);
  });
}

export function rebuildDecodedEvents(
  database: SqliteDatabase,
  filters: RebuildEventFilters = {},
  now = new Date().toISOString()
): RebuildEventResult {
  let recordsProcessed = 0n;
  let decodedCount = 0n;
  let unknown = 0n;
  let failed = 0n;
  let ambiguous = 0n;
  let bindingCount = 0n;
  database.transaction(() => {
    const bindings = rebuildBindings(database, now);
    bindingCount = BigInt(bindings.size);
    const registries = database
      .prepare("SELECT registry_id, code_hash, trust_level, descriptor_json FROM abi_registry WHERE enabled = 1")
      .all() as RegistryRow[];
    const registryById = new Map(registries.map((row) => [row.registry_id, row]));
    const descriptorById = new Map<bigint, SwapVMEventABIV1>();
    const deployments = database
      .prepare(
        `SELECT d.id deployment_id, d.execution_id, d.chain_id, d.kernel_address, d.world_id,
                d.contract_id, d.code_hash, e.block_number, e.block_hash,
                e.transaction_index, e.ethereum_log_index
           FROM program_deployments d JOIN vm_executions e ON e.id = d.execution_id`
      )
      .all() as DeploymentRow[];
    const blocks = new Map(
      (database.prepare("SELECT chain_id, block_hash, parent_hash, block_number FROM blocks").all() as BlockRow[]).map((row) => [
        `${row.chain_id}:${row.block_hash}`,
        row
      ])
    );
    for (const row of applicationRows(database, filters)) {
      const deployment = selectDeployment(row, deployments, blocks);
      const previous = database
        .prepare("SELECT registry_id FROM decoded_events WHERE execution_id = ? AND event_index = ?")
        .get(row.execution_id, row.event_index) as { registry_id: bigint | null } | undefined;
      if (deployment !== "ambiguous" && deployment !== null) {
        const binding = bindings.get(deployment.deployment_id);
        if (filters.codeHash !== undefined && deployment.code_hash !== normalizeBytes32(filters.codeHash)) continue;
        if (
          filters.registryId !== undefined &&
          binding?.registry_id !== filters.registryId &&
          previous?.registry_id !== filters.registryId
        ) continue;
      } else if (filters.codeHash !== undefined || filters.registryId !== undefined) {
        continue;
      }
      recordsProcessed += 1n;
      database.prepare("DELETE FROM decoded_events WHERE execution_id = ? AND event_index = ?").run(row.execution_id, row.event_index);
      if (deployment === null) {
        insertDecodeStatus(database, row, "unknown_program", now, null, null, null, null);
        database.prepare("DELETE FROM event_decode_errors WHERE execution_id = ? AND event_index = ?").run(row.execution_id, row.event_index);
        unknown += 1n;
        continue;
      }
      if (deployment === "ambiguous") {
        const error = new EventAbiError(EventAbiErrorCode.DEPLOYMENT_AMBIGUOUS);
        insertDecodeStatus(database, row, "ambiguous", now, null, null, null, null);
        recordDecodeError(database, row, null, error, now);
        ambiguous += 1n;
        continue;
      }
      const binding = bindings.get(deployment.deployment_id);
      if (binding === undefined || binding.binding_status === "unknown") {
        insertDecodeStatus(database, row, "unknown_program", now, deployment.deployment_id, null, null, null);
        database.prepare("DELETE FROM event_decode_errors WHERE execution_id = ? AND event_index = ?").run(row.execution_id, row.event_index);
        unknown += 1n;
        continue;
      }
      if (binding.binding_status === "ambiguous" || binding.registry_id === null) {
        const error = new EventAbiError(EventAbiErrorCode.REGISTRY_AMBIGUOUS);
        insertDecodeStatus(database, row, "ambiguous", now, deployment.deployment_id, null, null, null);
        recordDecodeError(database, row, null, error, now);
        ambiguous += 1n;
        continue;
      }
      const registry = registryById.get(binding.registry_id);
      if (registry === undefined) throw new EventAbiError(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
      let descriptor = descriptorById.get(registry.registry_id);
      if (descriptor === undefined) {
        descriptor = normalizeEventAbiDescriptor(JSON.parse(registry.descriptor_json));
        descriptorById.set(registry.registry_id, descriptor);
      }
      const topics = [row.topic0, row.topic1, row.topic2, row.topic3]
        .slice(0, Number(row.topic_count))
        .map((topic) => normalizeBytes32(topic ?? ""));
      try {
        const event = decodeApplicationEvent(descriptor, { topics, data: row.raw_data as Hex });
        if (event === null) {
          insertDecodeStatus(database, row, "unknown_event", now, deployment.deployment_id, registry.registry_id, null, null);
          database.prepare("DELETE FROM event_decode_errors WHERE execution_id = ? AND event_index = ?").run(row.execution_id, row.event_index);
          unknown += 1n;
          continue;
        }
        const decodedJson = canonicalJson({
          name: event.name,
          signature: event.signature,
          fields: event.fields.map((field) => ({
            name: field.name,
            type: field.type,
            indexed: field.indexed,
            value: field.normalized,
            ...(field.accountKind === undefined ? {} : { accountKind: field.accountKind })
          }))
        });
        insertDecodeStatus(database, row, "decoded", now, deployment.deployment_id, registry.registry_id, event.signature, decodedJson);
        const insertField = database.prepare(
          `INSERT INTO decoded_event_fields(
             execution_id, event_index, field_index, field_name, field_type, indexed,
             field_position, normalized_value, raw_value, account_kind
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const field of event.fields) {
          insertField.run(
            row.execution_id,
            row.event_index,
            BigInt(field.index),
            field.name,
            field.type,
            field.indexed ? 1n : 0n,
            BigInt(field.position),
            field.normalized,
            field.raw,
            field.accountKind ?? null
          );
        }
        database.prepare("DELETE FROM event_decode_errors WHERE execution_id = ? AND event_index = ?").run(row.execution_id, row.event_index);
        decodedCount += 1n;
      } catch (error) {
        if (!(error instanceof EventAbiError)) throw error;
        insertDecodeStatus(database, row, "failed", now, deployment.deployment_id, registry.registry_id, null, null);
        recordDecodeError(database, row, registry.registry_id, error, now);
        failed += 1n;
      }
    }
  }).immediate();
  return Object.freeze({ recordsProcessed, decoded: decodedCount, unknown, failed, ambiguous, bindings: bindingCount });
}

export function listDecodedEvents(
  database: SqliteDatabase,
  filters: EventQueryFilters = {}
): readonly Readonly<Record<string, unknown>>[] {
  const clauses: string[] = [];
  const values: Array<string | bigint> = [];
  const add = (clause: string, value: string): void => {
    clauses.push(clause);
    values.push(value);
  };
  if (filters.chainId !== undefined) add("e.chain_id = ?", decimal(filters.chainId));
  if (filters.kernelAddress !== undefined) add("e.kernel_address = ?", normalizeAddress(filters.kernelAddress));
  if (filters.worldId !== undefined) add("e.world_id = ?", normalizeBytes32(filters.worldId));
  if (filters.emitter !== undefined) add("r.emitter = ?", normalizeBytes32(filters.emitter));
  if (filters.codeHash !== undefined) add("p.code_hash = ?", normalizeBytes32(filters.codeHash));
  if (filters.signature !== undefined) add("d.event_signature = ?", filters.signature);
  if (filters.fromBlock !== undefined) {
    const value = decimal(filters.fromBlock);
    clauses.push("(length(e.block_number) > length(?) OR (length(e.block_number) = length(?) AND e.block_number >= ?))");
    values.push(value, value, value);
  }
  if (filters.toBlock !== undefined) {
    const value = decimal(filters.toBlock);
    clauses.push("(length(e.block_number) < length(?) OR (length(e.block_number) = length(?) AND e.block_number <= ?))");
    values.push(value, value, value);
  }
  if (filters.registryId !== undefined) {
    clauses.push("d.registry_id = ?");
    values.push(filters.registryId);
  }
  if (filters.canonicalOnly === true) clauses.push("e.canonical = 1");
  if (filters.finalizedOnly === true) clauses.push("e.finalized = 1");
  if (filters.account !== undefined) {
    if (filters.account.length === 42) {
      const address = normalizeAddress(filters.account);
      const account = `0x${"0".repeat(24)}${address.slice(2)}`;
      clauses.push(
        "EXISTS (SELECT 1 FROM decoded_event_fields f WHERE f.execution_id = d.execution_id AND f.event_index = d.event_index AND f.field_type IN ('account', 'address') AND f.normalized_value IN (?, ?))"
      );
      values.push(address, account);
    } else {
      clauses.push(
        "EXISTS (SELECT 1 FROM decoded_event_fields f WHERE f.execution_id = d.execution_id AND f.event_index = d.event_index AND f.field_type = 'account' AND f.normalized_value = ?)"
      );
      values.push(normalizeBytes32(filters.account));
    }
  }
  if (filters.tokenId !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM decoded_event_fields f WHERE f.execution_id = d.execution_id AND f.event_index = d.event_index AND f.field_name IN ('id', 'tokenId') AND f.normalized_value = ?)"
    );
    values.push(decimal(filters.tokenId));
  }
  return database
    .prepare(
      `SELECT e.chain_id, e.kernel_address, e.block_number, e.block_hash, e.transaction_hash,
              e.transaction_index, e.ethereum_log_index, e.world_id, e.execution_height,
              e.canonical, e.finalized, r.event_index, r.emitter, r.topic0, r.raw_data,
              d.decode_status, d.event_signature, d.decoded_json, d.decoder_version,
              d.registry_id, d.deployment_id, p.code_hash, a.standard, a.version, a.trust_level,
              a.descriptor_hash, a.artifact_abi_hash
         FROM decoded_events d
         JOIN vm_records r ON r.execution_id = d.execution_id AND r.event_index = d.event_index
         JOIN vm_executions e ON e.id = d.execution_id
         LEFT JOIN program_deployments p ON p.id = d.deployment_id
         LEFT JOIN abi_registry a ON a.registry_id = d.registry_id
        ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
        ORDER BY length(e.block_number), e.block_number,
                 length(e.transaction_index), e.transaction_index,
                 length(e.ethereum_log_index), e.ethereum_log_index, r.event_index`
    )
    .all(...values) as readonly Readonly<Record<string, unknown>>[];
}
