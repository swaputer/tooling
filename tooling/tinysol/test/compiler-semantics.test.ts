import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, it } from "node:test";
import { canonicalJson } from "../src/abi.js";
import { compileTinySol, TINYSOL_COMPILER_IDENTITY } from "../src/codegen.js";
import { ToolchainErrorCode, isToolchainError } from "../src/errors.js";
import { decodeProgramPackage, encodeProgramPackage } from "../src/package.js";

function errorCode(source: string): string {
  try { compileTinySol(source); return "NO_ERROR"; } catch (error) { return isToolchainError(error) ? error.code : "UNKNOWN"; }
}

describe("TinySol semantic analysis and deterministic compiler", () => {
  it("compiles all committed examples and round-trips ProgramPackageV1", async () => {
    for (const name of ["Counter", "Mapping", "EventDemo", "MiniToken", "MiniNFT", "Context", "NestedCaller", "Factory", "ControlFlow", "Conformance"]) {
      const source = await readFile(resolve("examples", `${name}.tiny.sol`), "utf8");
      const result = compileTinySol(source, { sourceName: `examples/${name}.tiny.sol`, includeSyntax: true });
      assert.deepEqual(encodeProgramPackage(decodeProgramPackage(result.packageBytes)), result.packageBytes);
      assert.ok(result.tokens !== undefined && result.ast !== undefined);
      assert.ok(result.sourceMap.every((entry) => entry.sourceSpan.start.line > 0));
    }
  });

  it("is byte-identical across repeats, newline styles and logical filenames", async () => {
    const source = await readFile(resolve("examples/Counter.tiny.sol"), "utf8");
    const first = compileTinySol(source, { sourceName: "a/Counter.tiny.sol" });
    const second = compileTinySol(source.replace(/\n/g, "\r\n"), { sourceName: "Counter.tiny.sol" });
    assert.deepEqual(first.packageBytes, second.packageBytes);
    assert.equal(canonicalJson(first.manifest), canonicalJson(second.manifest));
  });

  it("builds declaration-order scalar slots and independently reproducible mapping domains", async () => {
    const source = await readFile(resolve("examples/MiniToken.tiny.sol"), "utf8");
    const result = compileTinySol(source);
    assert.equal(result.storageLayout.items[0]?.slot, `0x${"00".repeat(32)}`);
    const expected = `0x${Buffer.from(keccak_256(new TextEncoder().encode("TinySol.storage.mapping.v1:MiniToken:balance:1"))).toString("hex")}`;
    assert.equal(result.storageLayout.items[1]?.namespace, expected);
  });

  it("emits a Stage 6C-compatible descriptor with account mapped to bytes32", async () => {
    const result = compileTinySol(await readFile(resolve("examples/MiniToken.tiny.sol"), "utf8"));
    const event = result.eventDescriptor.events[0];
    assert.equal(event?.signature, "Transfer(bytes32,bytes32,uint256)");
    assert.equal(event?.fields[0]?.position, 1);
    assert.equal(event?.fields[2]?.position, 0);
    assert.equal(result.eventDescriptor.codeHash, result.codeHash);
    assert.equal(result.eventDescriptor.artifactAbiHash, result.abi.abiHash);
  });

  it("compiles v1.2 EVM transaction context as address values", () => {
    const source = "contract C { function f() view returns(address,address,address){ return tx.router, tx.executor, tx.recipient; } }";
    const result = compileTinySol(source);
    assert.match(result.assembly, /TXROUTER/);
    assert.match(result.assembly, /TXEXECUTOR/);
    assert.match(result.assembly, /TXRECIPIENT/);
    assert.equal(result.abi.functions[0]?.signature, "f()");
    assert.deepEqual(result.abi.functions[0]?.outputs, ["address", "address", "address"]);
  });

  it("compiles the current MiniVM contract AccountId through this.id", () => {
    const source = "contract C { function f() view returns(account){ return this.id; } }";
    const result = compileTinySol(source);
    assert.match(result.assembly, /ADDRESS/);
    assert.equal(result.abi.functions[0]?.signature, "f()");
    assert.deepEqual(result.abi.functions[0]?.outputs, ["account"]);
  });

  it("rejects duplicate, undefined, return, condition and implicit conversion errors", () => {
    assert.equal(errorCode("contract C { uint256 x; uint256 x; }"), ToolchainErrorCode.DUPLICATE_DECLARATION);
    assert.equal(errorCode("contract C { function f() { x = 1; } }"), ToolchainErrorCode.UNDEFINED_SYMBOL);
    assert.equal(errorCode("contract C { function f() returns(uint256) { return; } }"), ToolchainErrorCode.RETURN_MISMATCH);
    assert.equal(errorCode("contract C { function f(uint256 x) { if(x){} } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { function f(address a) returns(account) { return a; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { function f(bool ok) returns(uint256) { if(ok){uint256 x=1;} return x; } }"), ToolchainErrorCode.UNDEFINED_SYMBOL);
    assert.equal(errorCode("contract C { function f(){ uint256 x; { uint256 x; } } }"), ToolchainErrorCode.DUPLICATE_DECLARATION);
  });

  it("rejects static writes, events, create and mutable CALL", () => {
    assert.equal(errorCode("contract C { uint256 x; function f() view { x=1; } }"), ToolchainErrorCode.STATIC_VIOLATION);
    assert.equal(errorCode("contract C { event E(); function f() view { emit E(); } }"), ToolchainErrorCode.STATIC_VIOLATION);
    const create = "interface I { constructor(); } contract C { function f(bytes32 h) view returns(account){ return create I(h); } }";
    assert.equal(errorCode(create), ToolchainErrorCode.STATIC_VIOLATION);
    const call = "interface I { function f() returns(uint256); } contract C { function f(account a) view returns(uint256){ return call I.f(a); } }";
    assert.equal(errorCode(call), ToolchainErrorCode.STATIC_VIOLATION);
  });

  it("rejects address call targets and noncanonical event topic counts", () => {
    const target = "interface I { function f() view returns(uint256); } contract C { function f(address a) view returns(uint256){ return staticcall I.f(a); } }";
    assert.equal(errorCode(target), ToolchainErrorCode.TYPE_MISMATCH);
    const event = "contract C { event E(uint256 indexed a,uint256 indexed b,uint256 indexed c,uint256 indexed d); }";
    assert.equal(errorCode(event), ToolchainErrorCode.RESOURCE_LIMIT);
  });

  it("rejects integer overflow before producing a package", () => {
    const value = (1n << 256n).toString();
    assert.equal(errorCode(`contract C { function f() view returns(uint256){ return ${value}; } }`), ToolchainErrorCode.LITERAL_OVERFLOW);
  });

  it("supports internal-only helper functions and does not expose them in ABI/runtime dispatch", () => {
    const source = `contract C {
      function add(uint256 x, uint256 y) internal view returns(uint256) { return x + y; }
      function addTwice(uint256 x) view returns(uint256) { return add(x, add(x, 1)); }
    }`;
    const result = compileTinySol(source);
    assert.equal(result.abi.functions.some((entry) => entry.name === "add"), false);
    assert.match(result.assembly, /__function_addTwice/);
    assert.ok(!result.assembly.includes("__function_add("));
  });

  it("rejects internal-style calls to non-internal functions", () => {
    assert.equal(errorCode(`contract C { function a() returns(uint256){ return 1; } function b() view returns(uint256){ return a(); } }`), ToolchainErrorCode.UNSUPPORTED_FEATURE);
  });

  it("rejects calling internal function with non-1 return arity", () => {
    assert.equal(errorCode(`contract C { function a(uint256 x) internal returns(uint256,uint256){ return x, x; } function b() view returns(uint256){ return a(1); } }`), ToolchainErrorCode.UNSUPPORTED_FEATURE);
  });

  it("stamps an experimental path-free compiler identity", () => {
    assert.equal(TINYSOL_COMPILER_IDENTITY.status, "experimental-unaudited");
    assert.match(TINYSOL_COMPILER_IDENTITY.compilerSourceFingerprint, /^0x[0-9a-f]{64}$/);
    assert.match(TINYSOL_COMPILER_IDENTITY.dependencyLockHash, /^[0-9a-f]{64}$/);
    assert.equal(canonicalJson(TINYSOL_COMPILER_IDENTITY).includes(process.cwd()), false);
  });

  it("fixed-seed generated programs produce stable selectors and packages", () => {
    let state = 0x6d2c0de;
    for (let index = 0; index < 64; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const a = state; state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; const b = state;
      const source = `contract P${index} { function value() view returns(uint256){ return ${a} + ${b}; } }`;
      const left = compileTinySol(source); const right = compileTinySol(source);
      assert.equal(left.abi.functions[0]?.selector, right.abi.functions[0]?.selector);
      assert.deepEqual(left.packageBytes, right.packageBytes);
    }
  });
});
