import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTRUCTIONS,
  ISA_FILE_KECCAK,
  ISA_FILE_SHA256,
  ISA_VERSION,
  MNEMONIC_TO_INSTRUCTION,
  OPCODE_TO_INSTRUCTION,
  instructionForMnemonic,
  instructionForOpcode
} from "../src/index.js";

test("frozen ISA hashes, version and complete expanded lookup tables are exact", () => {
  assert.equal(ISA_VERSION, 2);
  assert.equal(ISA_FILE_KECCAK, "0x5958f1a3baf744e5ed92f096a964ee14779db2e32e70a2982c53080eb3cd92c2");
  assert.equal(ISA_FILE_SHA256, "e1c194b49a0275ce052758d18c834b0a6c8fedbb3932b0cf378b725c992ed389");
  assert.equal(INSTRUCTIONS.length, 135);
  assert.equal(OPCODE_TO_INSTRUCTION.size, INSTRUCTIONS.length);
  assert.equal(MNEMONIC_TO_INSTRUCTION.size, INSTRUCTIONS.length);
  for (const instruction of INSTRUCTIONS) {
    assert.equal(instructionForOpcode(instruction.opcode), instruction);
    assert.equal(instructionForMnemonic(instruction.mnemonic.toLowerCase()), instruction);
    assert.equal(instruction.width, instruction.immediateBytes + 1);
    assert.ok(instruction.stackSignature.includes("->"));
  }
});

test("v1.2 transaction-context opcodes are read-only address words", () => {
  assert.equal(instructionForMnemonic("TXROUTER")?.opcode, 0xba);
  assert.equal(instructionForMnemonic("TXEXECUTOR")?.opcode, 0xbb);
  assert.equal(instructionForMnemonic("TXRECIPIENT")?.opcode, 0xbc);
  for (const name of ["TXROUTER", "TXEXECUTOR", "TXRECIPIENT"]) {
    const instruction = instructionForMnemonic(name);
    assert.equal(instruction?.pops, 0);
    assert.equal(instruction?.pushes, 1);
    assert.equal(instruction?.staticAllowed, true);
  }
});

test("PUSH, DUP, SWAP and LOG ranges expand with frozen metadata", () => {
  for (let width = 1; width <= 32; width += 1) {
    const push = instructionForMnemonic(`PUSH${width}`);
    assert.equal(push?.opcode, 0x5f + width);
    assert.equal(push?.immediateBytes, width);
    assert.equal(push?.pops, 0);
    assert.equal(push?.pushes, 1);
  }
  for (let depth = 1; depth <= 16; depth += 1) {
    assert.equal(instructionForMnemonic(`DUP${depth}`)?.opcode, 0x7f + depth);
    assert.equal(instructionForMnemonic(`SWAP${depth}`)?.opcode, 0x8f + depth);
  }
  for (let topics = 0; topics <= 4; topics += 1) {
    const log = instructionForMnemonic(`LOG${topics}`);
    assert.equal(log?.opcode, 0xa0 + topics);
    assert.equal(log?.pops, 2 + topics);
    assert.equal(log?.staticAllowed, false);
  }
});

test("only SSTORE, LOG0..LOG4 and CREATE are statically forbidden", () => {
  assert.deepEqual(
    INSTRUCTIONS.filter((instruction) => !instruction.staticAllowed).map((instruction) => instruction.opcode),
    [0x55, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xf0]
  );
});
