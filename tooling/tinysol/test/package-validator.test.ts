import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MAX_CODE_BYTES,
  INSTRUCTIONS,
  ToolchainError,
  ToolchainErrorCode,
  analyzeCode,
  assemble,
  buildProgramPackage,
  bytesToHex,
  decodeProgramPackage,
  disassemble,
  encodeProgramPackage,
  encodeProgramPackageHex,
  exactUtf8AbiHash,
  instructionBoundaries,
  jumpdestBitmap,
  programPackageCodeHash,
  validateCode
} from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(packageRoot, "../..");

function expectCode(code: string, callback: () => unknown): void {
  assert.throws(callback, (error: unknown) => error instanceof ToolchainError && error.code === code);
}

test("validator matches consensus empty/max/over-max and does not require STOP", () => {
  expectCode(ToolchainErrorCode.EMPTY_CODE, () => validateCode("0x"));
  assert.equal(validateCode(Uint8Array.from({ length: MAX_CODE_BYTES }, () => 0x00)).codeLength, MAX_CODE_BYTES);
  expectCode(ToolchainErrorCode.CODE_TOO_LARGE, () => validateCode(Uint8Array.from({ length: MAX_CODE_BYTES + 1 }, () => 0x00)));
  assert.equal(validateCode("0x5b").instructions.length, 1);
  assert.equal(analyzeCode("0x5b").advisory[0]?.code, "NO_HALT");
});

test("every unknown opcode and truncated PUSH width maps to exact offset", () => {
  const known = new Set(INSTRUCTIONS.map((item) => item.opcode));
  for (let opcode = 0; opcode < 256; opcode += 1) {
    if (!known.has(opcode)) expectCode(ToolchainErrorCode.UNKNOWN_OPCODE, () => validateCode(`0x${opcode.toString(16).padStart(2, "0")}`));
  }
  for (let width = 1; width <= 32; width += 1) {
    const code = `0x00${(0x5f + width).toString(16)}${"00".repeat(width - 1)}` as `0x${string}`;
    assert.throws(
      () => validateCode(code),
      (error: unknown) => error instanceof ToolchainError && error.code === ToolchainErrorCode.TRUNCATED_IMMEDIATE && error.offset === 1
    );
  }
});

test("boundaries and JUMPDEST bitmap exclude PUSH immediates", () => {
  const code = "0x615b005b00";
  assert.deepEqual([...instructionBoundaries(code)], [0, 3, 4]);
  assert.deepEqual([...jumpdestBitmap(code)], [0, 0, 0, 1, 0]);
});

test("ProgramPackageV1 rejects every malformed header and entry condition", () => {
  const valid = encodeProgramPackageHex(buildProgramPackage({ constructorEntry: 0, runtimeEntry: 0, abiHash: `0x${"00".repeat(32)}`, code: "0x00" }));
  expectCode(ToolchainErrorCode.PACKAGE_TOO_SHORT, () => decodeProgramPackage("0x53564d31"));
  expectCode(ToolchainErrorCode.INVALID_PACKAGE_MAGIC, () => decodeProgramPackage(`0x00000000${valid.slice(10)}`));
  expectCode(ToolchainErrorCode.INVALID_PACKAGE_VERSION, () => decodeProgramPackage(`${valid.slice(0, 10)}0002${valid.slice(14)}` as `0x${string}`));
  expectCode(ToolchainErrorCode.PACKAGE_LENGTH_MISMATCH, () => decodeProgramPackage(`${valid}00`));
  expectCode(ToolchainErrorCode.PACKAGE_LENGTH_MISMATCH, () => decodeProgramPackage(valid.slice(0, -2) as `0x${string}`));
  expectCode(ToolchainErrorCode.INVALID_ENTRYPOINT, () => buildProgramPackage({ constructorEntry: 1, runtimeEntry: 0, abiHash: `0x${"00".repeat(32)}`, code: "0x00" }));
  expectCode(ToolchainErrorCode.INVALID_ENTRYPOINT, () => buildProgramPackage({ constructorEntry: 0, runtimeEntry: 1, abiHash: `0x${"00".repeat(32)}`, code: "0x61000000" }));
  expectCode(ToolchainErrorCode.INVALID_ABI_HASH, () => buildProgramPackage({ constructorEntry: 0, runtimeEntry: 0, abiHash: "0x12", code: "0x00" }));
});

test("consensus validation errors expose their production Solidity category", () => {
  assert.throws(
    () => validateCode("0x61"),
    (error: unknown) => error instanceof ToolchainError && error.solidityError === "TruncatedImmediate"
  );
  assert.throws(
    () => decodeProgramPackage("0x53564d31"),
    (error: unknown) => error instanceof ToolchainError && error.solidityError === "InvalidPackageLength"
  );
});

test("all four reference packages decode, disassemble and reassemble byte-identically", async () => {
  for (const name of ["SRC20-v1", "SRC721-v1", "SRC1155-v1", "CPAMM-v1"]) {
    const artifact = JSON.parse(await readFile(resolve(repositoryRoot, `reference/${name}.json`), "utf8")) as {
      package: `0x${string}`;
      code: `0x${string}`;
      codeHash: string;
      abiHash: string;
      abiCanonical: string;
      constructorEntry: number;
      runtimeEntry: number;
      codeLength: number;
    };
    const decoded = decodeProgramPackage(artifact.package);
    assert.equal(decoded.constructorEntry, artifact.constructorEntry);
    assert.equal(decoded.runtimeEntry, artifact.runtimeEntry);
    assert.equal(decoded.codeLength, artifact.codeLength);
    assert.equal(decoded.abiHash, artifact.abiHash);
    assert.equal(bytesToHex(decoded.code), artifact.code);
    assert.equal(programPackageCodeHash(artifact.package), artifact.codeHash);
    assert.equal(exactUtf8AbiHash(artifact.abiCanonical), artifact.abiHash);
    assert.equal(encodeProgramPackageHex(decoded), artifact.package);
    const fixture = await readFile(resolve(packageRoot, `fixtures/reference/${name}.svasm`), "utf8");
    const assembled = assemble(fixture);
    assert.equal(encodeProgramPackageHex(assembled.package), artifact.package);
    assert.equal(disassemble(artifact.package).canonicalText, fixture);
  }
});

test("seeded random package encode/decode preserves bytes and legal entries", () => {
  let state = 0x51a6d1n;
  const next = (): number => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number(state >> 32n);
  };
  for (let run = 0; run < 128; run += 1) {
    const instructions = 1 + next() % 100;
    const source = Array.from({ length: instructions }, () => next() % 3 === 0 ? `PUSH2 0x${(next() & 0xffff).toString(16).padStart(4, "0")}` : "STOP").join("\n");
    const assembled = assemble(`${source}\n`);
    const boundaries = [...instructionBoundaries(assembled.code)];
    const constructorEntry = boundaries[next() % boundaries.length] ?? 0;
    const runtimeEntry = boundaries[next() % boundaries.length] ?? 0;
    const packageValue = buildProgramPackage({ constructorEntry, runtimeEntry, abiHash: `0x${(next() >>> 0).toString(16).padStart(8, "0")}${"00".repeat(28)}`, code: assembled.code });
    const encoded = encodeProgramPackage(packageValue);
    assert.deepEqual(encodeProgramPackage(decodeProgramPackage(encoded)), encoded, `seed=0x51a6d1 run=${run}`);
  }
});
