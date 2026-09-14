import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../src/abi.js";
import { bytesToHex } from "../src/bytes.js";
import { compileTinySol } from "../src/codegen.js";
import { ISA_VERSION } from "../src/isa.js";

interface BaselineEntry {
  readonly source: string;
  readonly sourceSha256: string;
  readonly package: string;
  readonly codeHash: string;
  readonly abiCanonical: string;
  readonly eventDescriptor: unknown;
  readonly storageLayout: unknown;
}

interface Baseline {
  readonly profile: "legacy-v1";
  readonly identity: { readonly languageVersion: string; readonly svmIsaVersion: number };
  readonly fixtureFiles: readonly { readonly path: string; readonly sha256: string }[];
  readonly corpus: readonly BaselineEntry[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

test("legacy-v1 recompiles the frozen example corpus byte-for-byte", async () => {
  const baseline = JSON.parse(await readFile(resolve("fixtures/legacy-compatibility-v1.json"), "utf8")) as Baseline;
  assert.equal(baseline.profile, "legacy-v1");
  assert.equal(baseline.identity.languageVersion, "1");
  assert.equal(baseline.identity.svmIsaVersion, ISA_VERSION);
  for (const entry of baseline.corpus) {
    const source = await readFile(resolve(entry.source), "utf8");
    assert.equal(sha256(source.replace(/\r\n?/g, "\n")), entry.sourceSha256, `${entry.source}: source drift`);
    const result = compileTinySol(source, { sourceName: entry.source });
    assert.equal(bytesToHex(result.packageBytes), entry.package, `${entry.source}: package drift`);
    assert.equal(result.codeHash, entry.codeHash, `${entry.source}: code hash drift`);
    assert.equal(result.abi.abiCanonical, entry.abiCanonical, `${entry.source}: ABI drift`);
    assert.equal(canonicalJson(result.eventDescriptor), canonicalJson(entry.eventDescriptor), `${entry.source}: event drift`);
    assert.equal(canonicalJson(result.storageLayout), canonicalJson(entry.storageLayout), `${entry.source}: storage drift`);
  }
});

test("all pre-extension fixture files retain their exact bytes", async () => {
  const baseline = JSON.parse(await readFile(resolve("fixtures/legacy-compatibility-v1.json"), "utf8")) as Baseline;
  for (const fixture of baseline.fixtureFiles) {
    assert.equal(sha256(await readFile(resolve(fixture.path))), fixture.sha256, `${fixture.path}: fixture drift`);
  }
});
