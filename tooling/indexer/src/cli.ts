#!/usr/bin/env node

import { getStatuses, listDeployments, listExecutions, listRecords, migrate, openIndexerDatabase } from "./database.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { listDecodedEvents, rebuildDecodedEvents } from "./derived-events.js";
import { IndexerError, IndexerErrorCode, isIndexerError } from "./errors.js";
import { isEventAbiError } from "./event-abi.js";
import { normalizeAddress, normalizeBytes32, stringifyJson } from "./encoding.js";
import { SwapVMIndexer } from "./indexer.js";
import { HttpJsonRpcTransport } from "./rpc.js";
import {
  disableAbiRegistry,
  installVerifiedReferenceRegistry,
  listAbiRegistry,
  registerDeclaredEventAbi,
  verifyInstalledReferenceRegistry
} from "./registry.js";

function usage(): never {
  throw new IndexerError(IndexerErrorCode.CLI_USAGE, "INTEGRITY", { fatal: true });
}

function parseOptions(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length;) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || !key.startsWith("--") || result.has(key)) {
      usage();
    }
    if (key === "--canonical-only" || key === "--finalized-only") {
      result.set(key, "true");
      index += 1;
      continue;
    }
    if (value === undefined || value.startsWith("--")) usage();
    result.set(key, value);
    index += 2;
  }
  return result;
}

function required(options: ReadonlyMap<string, string>, key: string): string {
  return options.get(key) ?? usage();
}

function unsigned(value: string, key: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new IndexerError(IndexerErrorCode.CLI_USAGE, "INTEGRITY", { fatal: true, details: { key } });
  }
  return BigInt(value);
}

function output(value: unknown): void {
  process.stdout.write(`${stringifyJson(value)}\n`);
}

async function main(): Promise<void> {
  const [command, ...commandRest] = process.argv.slice(2);
  if (command === undefined) usage();
  const hierarchical = command === "registry" || command === "decode";
  const subcommand = hierarchical ? commandRest[0] : undefined;
  const rest = hierarchical ? commandRest.slice(1) : commandRest;
  const options = parseOptions(rest);
  const databasePath = required(options, "--db");
  const database = openIndexerDatabase(databasePath);
  try {
    migrate(database);
    installVerifiedReferenceRegistry(database);
    if (command === "registry") {
      if (subcommand === "list") {
        if (options.size !== 1) usage();
        output(listAbiRegistry(database));
        return;
      }
      if (subcommand === "verify") {
        if (options.size !== 1) usage();
        output(verifyInstalledReferenceRegistry(database));
        return;
      }
      if (subcommand === "add") {
        if (options.size !== 2) usage();
        const path = required(options, "--descriptor");
        const descriptor = JSON.parse(readFileSync(path, "utf8")) as unknown;
        output(registerDeclaredEventAbi(database, descriptor, { source: `declared:${basename(path)}` }));
        return;
      }
      if (subcommand === "disable") {
        if (options.size !== 2) usage();
        output({ disabled: disableAbiRegistry(database, unsigned(required(options, "--registry-id"), "--registry-id")) });
        return;
      }
      usage();
    }
    if (command === "decode") {
      if (subcommand !== "rebuild") usage();
      const allowed = new Set([
        "--db",
        "--chain-id",
        "--kernel",
        "--world-id",
        "--from-block",
        "--to-block",
        "--registry-id",
        "--code-hash"
      ]);
      for (const key of options.keys()) if (!allowed.has(key)) usage();
      output(
        rebuildDecodedEvents(database, {
          ...(options.has("--chain-id") ? { chainId: unsigned(required(options, "--chain-id"), "--chain-id") } : {}),
          ...(options.has("--kernel") ? { kernelAddress: normalizeAddress(required(options, "--kernel")) } : {}),
          ...(options.has("--world-id") ? { worldId: normalizeBytes32(required(options, "--world-id")) } : {}),
          ...(options.has("--from-block") ? { fromBlock: unsigned(required(options, "--from-block"), "--from-block") } : {}),
          ...(options.has("--to-block") ? { toBlock: unsigned(required(options, "--to-block"), "--to-block") } : {}),
          ...(options.has("--registry-id") ? { registryId: unsigned(required(options, "--registry-id"), "--registry-id") } : {}),
          ...(options.has("--code-hash") ? { codeHash: normalizeBytes32(required(options, "--code-hash")) } : {})
        })
      );
      return;
    }
    if (command === "init") {
      if (options.size !== 1) usage();
      output({ initialized: true, database: databasePath });
      return;
    }
    if (command === "status") {
      if (options.size !== 1) usage();
      output(getStatuses(database));
      return;
    }
    if (command === "executions" || command === "records" || command === "deployments") {
      if (options.size !== 1) usage();
      output(
        command === "executions"
          ? listExecutions(database)
          : command === "records"
            ? listRecords(database)
            : listDeployments(database)
      );
      return;
    }
    if (command === "events") {
      const allowed = new Set([
        "--db",
        "--chain-id",
        "--kernel",
        "--world-id",
        "--emitter",
        "--code-hash",
        "--signature",
        "--account",
        "--token-id",
        "--from-block",
        "--to-block",
        "--canonical-only",
        "--finalized-only"
      ]);
      for (const key of options.keys()) if (!allowed.has(key)) usage();
      const account = options.get("--account");
      if (account !== undefined && !/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(account)) usage();
      output(
        listDecodedEvents(database, {
          ...(options.has("--chain-id") ? { chainId: unsigned(required(options, "--chain-id"), "--chain-id") } : {}),
          ...(options.has("--kernel") ? { kernelAddress: normalizeAddress(required(options, "--kernel")) } : {}),
          ...(options.has("--world-id") ? { worldId: normalizeBytes32(required(options, "--world-id")) } : {}),
          ...(options.has("--emitter") ? { emitter: normalizeBytes32(required(options, "--emitter")) } : {}),
          ...(options.has("--code-hash") ? { codeHash: normalizeBytes32(required(options, "--code-hash")) } : {}),
          ...(options.has("--signature") ? { signature: required(options, "--signature") } : {}),
          ...(account === undefined ? {} : { account: account.toLowerCase() as `0x${string}` }),
          ...(options.has("--token-id") ? { tokenId: unsigned(required(options, "--token-id"), "--token-id") } : {}),
          ...(options.has("--from-block") ? { fromBlock: unsigned(required(options, "--from-block"), "--from-block") } : {}),
          ...(options.has("--to-block") ? { toBlock: unsigned(required(options, "--to-block"), "--to-block") } : {}),
          ...(options.has("--canonical-only") ? { canonicalOnly: true } : {}),
          ...(options.has("--finalized-only") ? { finalizedOnly: true } : {})
        })
      );
      return;
    }
    if (command !== "sync") usage();
    const allowed = new Set([
      "--db",
      "--rpc",
      "--chain-id",
      "--kernel",
      "--world-id",
      "--start-block",
      "--confirmations",
      "--chunk-size",
      "--max-reorg-depth",
      "--target-block"
    ]);
    for (const key of options.keys()) if (!allowed.has(key)) usage();
    const rpcUrl = options.get("--rpc") ?? process.env.SWAPVM_RPC_URL;
    if (rpcUrl === undefined || rpcUrl.length === 0) usage();
    const world = options.get("--world-id");
    const indexer = new SwapVMIndexer(database, new HttpJsonRpcTransport(rpcUrl));
    const result = await indexer.sync({
      chainId: unsigned(required(options, "--chain-id"), "--chain-id"),
      kernelAddress: normalizeAddress(required(options, "--kernel")),
      startBlock: unsigned(options.get("--start-block") ?? "0", "--start-block"),
      confirmations: unsigned(options.get("--confirmations") ?? "1", "--confirmations"),
      chunkSize: unsigned(options.get("--chunk-size") ?? "1000", "--chunk-size"),
      maxReorgDepth: unsigned(options.get("--max-reorg-depth") ?? "64", "--max-reorg-depth"),
      ...(options.has("--target-block")
        ? { targetBlock: unsigned(required(options, "--target-block"), "--target-block") }
        : {}),
      ...(world === undefined ? {} : { worldId: normalizeBytes32(world) })
    });
    output(result);
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  if (isIndexerError(error)) {
    process.stderr.write(`${stringifyJson({ code: error.code, category: error.category, details: error.details })}\n`);
  } else if (isEventAbiError(error)) {
    process.stderr.write(`${stringifyJson({ code: error.code, category: "ABI_REGISTRY", details: error.details })}\n`);
  } else {
    process.stderr.write(`${stringifyJson({ code: "UNEXPECTED_INDEXER_FAILURE" })}\n`);
  }
  process.exitCode = 1;
});
