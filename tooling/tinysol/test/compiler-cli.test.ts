import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const cli = resolve("dist/src/cli.js");
function run(args: readonly string[]) { return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" }); }

describe("TinySol compiler CLI", () => {
  it("checks and prints AST JSON", () => {
    const input = resolve("examples/Counter.tiny.sol");
    assert.equal(run(["check", "--input", input]).status, 0);
    const ast = run(["ast", "--input", input, "--json"]);
    assert.equal(ast.status, 0);
    assert.equal(JSON.parse(ast.stdout).kind, "Program");
    assert.equal(ast.stdout.includes(process.cwd()), false);
  });

  it("atomically writes all seven artifacts and refuses overwrite", () => {
    const directory = mkdtempSync(join(tmpdir(), "tinysol-compiler-cli-"));
    try {
      const input = join(directory, "Counter.tiny.sol"); writeFileSync(input, readFileSync(resolve("examples/Counter.tiny.sol")));
      const paths = ["Counter.svm", "Counter.abi.json", "Counter.events.json", "Counter.storage.json", "Counter.manifest.json", "Counter.svasm", "Counter.map.json"].map((name) => join(directory, name));
      const args = ["compile", "--input", input, "--output", paths[0]!, "--abi", paths[1]!, "--events", paths[2]!, "--storage-layout", paths[3]!, "--manifest", paths[4]!, "--assembly", paths[5]!, "--source-map", paths[6]!];
      assert.equal(run(args).status, 0);
      assert.ok(paths.every(existsSync));
      const again = run(args); assert.equal(again.status, 1); assert.equal(JSON.parse(again.stderr).error, "OUTPUT_EXISTS");
    } finally { rmSync(directory, { recursive: true }); }
  });

  it("leaves no artifacts after compilation failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "tinysol-compiler-fail-"));
    try {
      const input = join(directory, "Bad.tiny.sol"); writeFileSync(input, "contract C { function f( }");
      const paths = Array.from({ length: 7 }, (_, index) => join(directory, `out-${index}`));
      const result = run(["compile", "--input", input, "--output", paths[0]!, "--abi", paths[1]!, "--events", paths[2]!, "--storage-layout", paths[3]!, "--manifest", paths[4]!, "--assembly", paths[5]!, "--source-map", paths[6]!]);
      assert.equal(result.status, 1);
      assert.ok(paths.every((path) => !existsSync(path)));
    } finally { rmSync(directory, { recursive: true }); }
  });

  it("simulates and estimates with byte-identical stable JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "tinysol-simulator-cli-"));
    try {
      const corpus = JSON.parse(readFileSync(resolve("fixtures/simulator-corpus.json"), "utf8"));
      const input = join(directory, "simulation.json"); writeFileSync(input, JSON.stringify(corpus.cases[13].input));
      const first = run(["simulate", "--input", input]); const second = run(["simulate", "--input", input]);
      assert.equal(first.status, 0); assert.equal(first.stdout, second.stdout); assert.equal(JSON.parse(first.stdout).executedBytes, 60);
      writeFileSync(input, JSON.stringify({ ...corpus.cases[13].input, action: { ...corpus.cases[13].input.action, byteLimit: 1000 }, minNetTokenOut: "900000" }));
      const estimate = run(["estimate", "--input", input]); assert.equal(estimate.status, 0);
      const parsed = JSON.parse(estimate.stdout); assert.equal(parsed.mode, "exact"); assert.equal(parsed.signable, true); assert.equal(parsed.estimatedActualBurn, "660");
      writeFileSync(input, JSON.stringify({ ...corpus.cases[21].input, minNetTokenOut: "0" }));
      const failed = run(["estimate", "--input", input]); assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).signable, false);
    } finally { rmSync(directory, { recursive: true }); }
  });
});
