import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { migrate, openIndexerDatabase } from "../src/database.js";
import { EventAbiError } from "../src/event-abi.js";
import {
  disableAbiRegistry,
  installVerifiedReferenceRegistry,
  listAbiRegistry,
  referenceEventAbis,
  registerDeclaredEventAbi,
  verifyInstalledReferenceRegistry
} from "../src/registry.js";
import { hash } from "./helpers.js";

describe("codeHash-bound ABI registry", () => {
  it("installs and verifies exactly four generated reference identities idempotently", () => {
    const database = openIndexerDatabase(":memory:");
    try {
      migrate(database);
      installVerifiedReferenceRegistry(database, "2026-01-01T00:00:00.000Z");
      installVerifiedReferenceRegistry(database, "2026-01-02T00:00:00.000Z");
      assert.deepEqual(verifyInstalledReferenceRegistry(database), { verified: 4 });
      const rows = listAbiRegistry(database);
      assert.equal(rows.length, 4);
      assert.ok(rows.every((row) => row.trustLevel === "verified_reference" && row.enabled));
      assert.deepEqual(rows.map((row) => row.codeHash), referenceEventAbis().map((entry) => entry.codeHash));
    } finally {
      database.close();
    }
  });

  it("registers user descriptors only as declared_unverified and supports disable", () => {
    const database = openIndexerDatabase(":memory:");
    try {
      migrate(database);
      const source = referenceEventAbis()[0];
      assert.notEqual(source, undefined);
      const declared = registerDeclaredEventAbi(database, { ...source!, codeHash: hash("custom-code") });
      assert.equal(declared.trustLevel, "declared_unverified");
      assert.equal(disableAbiRegistry(database, declared.registryId), true);
      assert.equal(listAbiRegistry(database)[0]?.enabled, false);
      assert.equal(disableAbiRegistry(database, declared.registryId), false);
    } finally {
      database.close();
    }
  });

  it("rejects malformed custom ABI before writing a registry row", () => {
    const database = openIndexerDatabase(":memory:");
    try {
      migrate(database);
      assert.throws(() => registerDeclaredEventAbi(database, { format: "wrong" }), EventAbiError);
      assert.equal(listAbiRegistry(database).length, 0);
    } finally {
      database.close();
    }
  });
});
