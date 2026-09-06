import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getStatuses, migrate, openIndexerDatabase } from "../src/database.js";

describe("versioned SQLite migrations", () => {
  it("applies the clean Events schema and is repeatable", () => {
    const database = openIndexerDatabase(":memory:");
    try {
      migrate(database);
      migrate(database);
      const migrations = database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
      assert.deepEqual(migrations, [
        { version: 1n, name: "001_initial.sql" },
        { version: 2n, name: "002_abi_registry.sql" }
      ]);
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const name of [
        "blocks",
        "abi_registry",
        "chains",
        "decoded_event_fields",
        "decoded_events",
        "event_decode_errors",
        "ingestion_cursor",
        "ingestion_errors",
        "kernels",
        "program_deployments",
        "program_abi_bindings",
        "vm_executions",
        "vm_records"
      ]) {
        assert.ok(tables.includes(name), name);
      }
      assert.deepEqual(getStatuses(database), []);
    } finally {
      database.close();
    }
  });
});
