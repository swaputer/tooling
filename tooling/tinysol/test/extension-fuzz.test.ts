import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTinySol } from "../src/codegen.js";
import { isToolchainError, ToolchainErrorCode } from "../src/errors.js";

test("fixed-seed malformed extension syntax fails only with structured diagnostics", () => {
  let seed = 0x51a7c0de;
  const atoms = ["struct", "enum", "const", "uint256[", "mapping(", "{", "}", "(", ")", "revert E(", "A({x:"];
  for (let index = 0; index < 128; index += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; const count = 1 + seed % 8; let body = "";
    for (let item = 0; item < count; item += 1) { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; body += `${atoms[seed % atoms.length]} `; }
    try { compileTinySol(`contract F${index} { ${body} }`); }
    catch (error) { assert.equal(isToolchainError(error), true, `case ${index}: ${String(error)}`); }
  }
});

test("extension resource and cycle limits have stable codes", () => {
  const code = (source: string) => { try { compileTinySol(source); return "NO_ERROR"; } catch (error) { return isToolchainError(error) ? error.code : "UNKNOWN"; } };
  assert.equal(code("contract C { uint256[257] values; }"), ToolchainErrorCode.ARRAY_LENGTH_INVALID);
  assert.equal(code("contract C { uint256[256][256][2] values; }"), ToolchainErrorCode.RESOURCE_LIMIT);
  assert.equal(code("contract C { struct Leaf { uint256[256] values; } struct Branch { Leaf[256] leaves; } struct Root { Branch[2] branches; } Root root; }"), ToolchainErrorCode.RESOURCE_LIMIT);
  assert.equal(code("contract C { struct Leaf { uint256[256] values; } mapping(uint256=>Leaf[256][2]) mapped; }"), ToolchainErrorCode.RESOURCE_LIMIT);
  assert.equal(code("contract C { struct A { B b; } struct B { A a; } A root; }"), ToolchainErrorCode.STRUCT_CYCLE);
  const nested = `${"{".repeat(70)}${"}".repeat(70)}`; assert.equal(code(`contract C { function f() ${nested} }`), ToolchainErrorCode.NESTING_LIMIT);
});
