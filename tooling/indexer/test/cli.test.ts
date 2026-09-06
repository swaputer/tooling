import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { referenceEventAbis } from "../src/registry.js";
import { hash } from "./helpers.js";

function run(args: readonly string[]) {
  return spawnSync(process.execPath, ["dist/src/cli.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, SWAPVM_RPC_URL: "" }
  });
}

describe("minimal CLI", () => {
  it("initializes a database and reports an empty status", () => {
    const directory = mkdtempSync(join(tmpdir(), "swaputer-indexer-cli-"));
    const database = join(directory, "index.sqlite");
    try {
      const initialized = run(["init", "--db", database]);
      assert.equal(initialized.status, 0);
      assert.equal(JSON.parse(initialized.stdout).initialized, true);
      const status = run(["status", "--db", database]);
      assert.equal(status.status, 0);
      assert.deepEqual(JSON.parse(status.stdout), []);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("never echoes an RPC URL containing credentials in failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "swaputer-indexer-secret-"));
    const database = join(directory, "index.sqlite");
    const secretUrl = "http://user:stage6b-secret@127.0.0.1:1";
    try {
      const result = run([
        "sync",
        "--db",
        database,
        "--rpc",
        secretUrl,
        "--chain-id",
        "31337",
        "--kernel",
        "0x1000000000000000000000000000000000000001",
        "--start-block",
        "0",
        "--confirmations",
        "0"
      ]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.includes("stage6b-secret"), false);
      assert.equal(result.stderr.includes("stage6b-secret"), false);
      assert.equal(JSON.parse(result.stderr).code, "RPC_RETRIES_EXHAUSTED");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("supports registry, rebuild and decoded-event query commands", () => {
    const directory = mkdtempSync(join(tmpdir(), "swaputer-indexer-stage6c-cli-"));
    const database = join(directory, "index.sqlite");
    const descriptorPath = join(directory, "custom.json");
    try {
      assert.equal(run(["init", "--db", database]).status, 0);
      const verified = run(["registry", "verify", "--db", database]);
      assert.equal(verified.status, 0);
      assert.deepEqual(JSON.parse(verified.stdout), { verified: 4 });

      const source = referenceEventAbis()[0];
      assert.notEqual(source, undefined);
      writeFileSync(descriptorPath, JSON.stringify({ ...source!, codeHash: hash("cli-custom") }));
      const added = run(["registry", "add", "--db", database, "--descriptor", descriptorPath]);
      assert.equal(added.status, 0);
      const addedJson = JSON.parse(added.stdout) as { registryId: string; trustLevel: string };
      assert.equal(addedJson.trustLevel, "declared_unverified");
      const listed = run(["registry", "list", "--db", database]);
      assert.equal(JSON.parse(listed.stdout).length, 5);
      assert.equal(
        run(["registry", "disable", "--db", database, "--registry-id", addedJson.registryId]).status,
        0
      );
      assert.equal(run(["decode", "rebuild", "--db", database]).status, 0);
      const events = run(["events", "--db", database, "--canonical-only"]);
      assert.equal(events.status, 0);
      assert.deepEqual(JSON.parse(events.stdout), []);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
