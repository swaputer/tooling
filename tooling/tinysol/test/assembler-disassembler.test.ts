import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTRUCTIONS,
  ToolchainError,
  ToolchainErrorCode,
  assemble,
  bytesToHex,
  disassemble,
  disassembleCode,
  encodeProgramPackageHex
} from "../src/index.js";

function expectCode(code: string, callback: () => unknown): void {
  assert.throws(callback, (error: unknown) => error instanceof ToolchainError && error.code === code);
}

test("assembler handles comments, labels, fixed-width relocation and directives deterministically", () => {
  const source = `
    # package metadata
    .constructor init
    .runtime runtime
    .abi-canonical "{\\"name\\":\\"demo\\"}"
    .code
  init: PUSH1 0x00 ; leading zero width is retained
    .pushlabel runtime
    JUMP
  runtime:
    JUMPDEST
    PUSH0
    STOP // done
  `;
  const first = assemble(source);
  const second = assemble(source);
  assert.deepEqual(first.packageBytes, second.packageBytes);
  assert.deepEqual(first.sourceMap, second.sourceMap);
  assert.equal(first.constructorEntry, 0);
  assert.equal(first.runtimeEntry, 6);
  assert.equal(bytesToHex(first.code), "0x6000610006565b5f00");
  assert.equal(first.manifest.sourceSha256, second.manifest.sourceSha256);
  assert.equal(first.manifest.consensusEncoding, false);
});

test("forward and backward labels resolve without changing instruction width", () => {
  const forward = assemble(".pushlabel target\nJUMP\ntarget:\nJUMPDEST\nSTOP\n");
  assert.equal(bytesToHex(forward.code), "0x610004565b00");
  const backward = assemble("start:\nJUMPDEST\n.pushlabel start\nJUMP\n");
  assert.equal(bytesToHex(backward.code), "0x5b61000056");
});

test("duplicate and undefined labels are stable structured failures", () => {
  expectCode(ToolchainErrorCode.DUPLICATE_LABEL, () => assemble("x:\nSTOP\nx:\nSTOP\n"));
  expectCode(ToolchainErrorCode.UNDEFINED_LABEL, () => assemble(".pushlabel nowhere\nSTOP\n"));
  expectCode(ToolchainErrorCode.UNDEFINED_LABEL, () => assemble(".constructor nowhere\nSTOP\n"));
  expectCode(ToolchainErrorCode.INVALID_ENTRYPOINT, () => assemble("STOP\nend:\n"));
});

test("PUSH0 and every explicit PUSH width preserve width and leading zero bytes", () => {
  const lines = ["PUSH0"];
  for (let width = 1; width <= 32; width += 1) lines.push(`PUSH${width} 0x${"00".repeat(width)}`);
  lines.push("STOP");
  const assembled = assemble(`${lines.join("\n")}\n`);
  const decoded = disassembleCode(assembled.code);
  assert.equal(decoded[0]?.mnemonic, "PUSH0");
  for (let width = 1; width <= 32; width += 1) {
    const instruction = decoded[width];
    assert.equal(instruction?.mnemonic, `PUSH${width}`);
    assert.equal(instruction?.immediate.length, width);
    assert.equal(instruction?.immediateHex, `0x${"00".repeat(width)}`);
  }
  const roundtrip = assemble(disassemble(assembled.code, { kind: "code" }).canonicalText);
  assert.deepEqual(roundtrip.code, assembled.code);
});

test("literal overflow and width-changing shorthand are rejected", () => {
  expectCode(ToolchainErrorCode.LITERAL_OVERFLOW, () => assemble("PUSH1 256\n"));
  expectCode(ToolchainErrorCode.LITERAL_OVERFLOW, () => assemble("PUSH1 0x0100\n"));
  expectCode(ToolchainErrorCode.ASSEMBLY_SYNTAX, () => assemble("PUSH1\n"));
  expectCode(ToolchainErrorCode.ASSEMBLY_SYNTAX, () => assemble("STOP 0\n"));
});

test("assembler enforces exact 16,384-byte code boundary", () => {
  assert.equal(assemble("STOP\n".repeat(16_384)).code.length, 16_384);
  expectCode(ToolchainErrorCode.CODE_TOO_LARGE, () => assemble("STOP\n".repeat(16_385)));
});

test("strict disassembler covers every opcode and reports unknown/truncated offsets", () => {
  for (const definition of INSTRUCTIONS) {
    const code = Uint8Array.of(definition.opcode, ...new Uint8Array(definition.immediateBytes));
    const result = disassembleCode(code);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.mnemonic, definition.mnemonic);
  }
  expectCode(ToolchainErrorCode.UNKNOWN_OPCODE, () => disassembleCode("0x5a"));
  assert.throws(
    () => disassembleCode("0x0061ff"),
    (error: unknown) => error instanceof ToolchainError && error.code === ToolchainErrorCode.TRUNCATED_IMMEDIATE && error.offset === 1
  );
});

test("package canonical disassembly reassembles byte-identically", () => {
  const assembled = assemble(".constructor c\n.runtime r\n.abi-hash 0x" + "12".repeat(32) + "\nc:\nSTOP\nr:\nJUMPDEST\nSTOP\n");
  const decoded = disassemble(assembled.packageBytes, { kind: "package" });
  const roundtrip = assemble(decoded.canonicalText);
  assert.equal(encodeProgramPackageHex(roundtrip.package), encodeProgramPackageHex(assembled.package));
  assert.equal(disassemble(roundtrip.packageBytes).canonicalText, decoded.canonicalText);
});

test("seeded structurally valid instruction streams roundtrip losslessly", () => {
  let state = 0x6d31c0den;
  const next = (): number => {
    state ^= state << 13n;
    state ^= state >> 17n;
    state ^= state << 5n;
    return Number(state & 0xffffffffn);
  };
  for (let run = 0; run < 128; run += 1) {
    const bytes: number[] = [];
    const count = 1 + next() % 80;
    for (let index = 0; index < count; index += 1) {
      const definition = INSTRUCTIONS[next() % INSTRUCTIONS.length];
      assert.ok(definition);
      bytes.push(definition.opcode);
      for (let immediate = 0; immediate < definition.immediateBytes; immediate += 1) bytes.push(next() & 0xff);
    }
    const code = Uint8Array.from(bytes);
    const text = disassemble(code, { kind: "code" }).canonicalText;
    assert.deepEqual(assemble(text).code, code, `seed=0x6d31c0de run=${run}`);
  }
});
