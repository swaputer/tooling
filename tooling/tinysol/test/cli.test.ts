import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = resolve(packageRoot, "dist/src/cli.js");

async function invoke(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [cli, ...args], { cwd: packageRoot });
}

test("CLI reports the frozen ISA in stable JSON", async () => {
  const result = await invoke(["isa", "check"]);
  const parsed = JSON.parse(result.stdout) as { opcodeCount: number; status: string; version: number };
  assert.deepEqual(parsed, {
    keccak256: "0x5958f1a3baf744e5ed92f096a964ee14779db2e32e70a2982c53080eb3cd92c2",
    opcodeCount: 135,
    sha256: "e1c194b49a0275ce052758d18c834b0a6c8fedbb3932b0cf378b725c992ed389",
    status: "verified",
    version: 2
  });
  assert.equal(result.stderr, "");
});

test("CLI assembles, validates, inspects, hashes and disassembles without nondeterminism", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "swapvm-6d1-"));
  try {
    const sourcePath = resolve(directory, "program.svasm");
    const packagePath = resolve(directory, "program.svm");
    const manifestPath = resolve(directory, "program.manifest.json");
    const disassemblyPath = resolve(directory, "roundtrip.svasm");
    await writeFile(sourcePath, ".constructor entry\n.runtime entry\nentry:\nSTOP\n");
    await invoke(["asm", "--input", sourcePath, "--output", packagePath, "--manifest", manifestPath]);
    const validation = JSON.parse((await invoke(["validate", "--input", packagePath])).stdout) as { valid: boolean };
    assert.equal(validation.valid, true);
    const inspection = JSON.parse((await invoke(["inspect", "--input", packagePath, "--json"])).stdout) as { codeLength: number; packageLength: number };
    assert.equal(inspection.codeLength, 1);
    assert.equal(inspection.packageLength, 45);
    const hash = JSON.parse((await invoke(["hash", "--input", packagePath])).stdout) as { hash: string };
    assert.match(hash.hash, /^0x[0-9a-f]{64}$/);
    await invoke(["disasm", "--input", packagePath, "--output", disassemblyPath]);
    assert.match(await readFile(disassemblyPath, "utf8"), /^\.constructor __constructor/m);
    const manifest = await readFile(manifestPath, "utf8");
    assert.ok(!manifest.includes(directory));
    assert.ok(!manifest.includes("timestamp"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI refuses input/output collision and accidental overwrite with stable codes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "swapvm-6d1-cli-"));
  try {
    const sourcePath = resolve(directory, "program.svasm");
    const outputPath = resolve(directory, "program.svm");
    await writeFile(sourcePath, "STOP\n");
    await assert.rejects(
      invoke(["asm", "--input", sourcePath, "--output", sourcePath]),
      (error: unknown) => typeof error === "object" && error !== null && String((error as { stderr?: string }).stderr).includes("INPUT_OUTPUT_COLLISION")
    );
    await writeFile(outputPath, "occupied");
    await assert.rejects(
      invoke(["asm", "--input", sourcePath, "--output", outputPath]),
      (error: unknown) => typeof error === "object" && error !== null && String((error as { stderr?: string }).stderr).includes("OUTPUT_EXISTS")
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI invalid code returns nonzero with structured stderr and no stdout", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "swapvm-6d1-invalid-"));
  try {
    const path = resolve(directory, "invalid.svm");
    await writeFile(path, Uint8Array.of(0x5a));
    await assert.rejects(invoke(["validate", "--input", path]), (error: unknown) => {
      const result = error as { stdout?: string; stderr?: string; code?: number };
      assert.equal(result.stdout, "");
      assert.equal(result.code, 1);
      assert.equal((JSON.parse(result.stderr ?? "{}") as { error: string }).error, "UNKNOWN_OPCODE");
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
