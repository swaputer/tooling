#!/usr/bin/env node

import { stringifyJson } from "./encoding.js";
import { backupIndexerDatabase, getIndexerHealth, initializeOperationsDatabase, restoreIndexerDatabase } from "./operations.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "health") {
    const path = option("--db");
    const head = option("--head");
    if (path === undefined || head === undefined || !/^(0|[1-9][0-9]*)$/.test(head)) throw new Error("CLI_USAGE");
    const database = initializeOperationsDatabase(path);
    try {
      process.stdout.write(`${stringifyJson(getIndexerHealth(database, { databasePath: path, observedHead: BigInt(head), lastSuccessfulScanAt: option("--last-scan") ?? null }))}\n`);
    } finally { database.close(); }
    return;
  }
  const source = option("--source");
  const destination = option("--destination");
  if (source === undefined || destination === undefined) throw new Error("CLI_USAGE");
  const result = command === "backup"
    ? await backupIndexerDatabase(source, destination)
    : command === "restore"
      ? await restoreIndexerDatabase(source, destination)
      : undefined;
  if (result === undefined) throw new Error("CLI_USAGE");
  process.stdout.write(`${stringifyJson(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${stringifyJson({ code: error instanceof Error ? error.message : "UNKNOWN" })}\n`);
  process.exitCode = 1;
});
