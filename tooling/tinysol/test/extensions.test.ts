import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileTinySol } from "../src/codegen.js";
import { ToolchainErrorCode, isToolchainError } from "../src/errors.js";
import { parseTinySol } from "../src/parser.js";
import { functionSelector } from "../src/abi.js";
import { simulateMiniVM } from "../src/simulator.js";
import { emptyMiniVMWorldState } from "../src/simulator-types.js";
import { encodeProgramPackageHex } from "../src/package.js";
import type { Bytes32, Hex } from "../src/bytes.js";

function errorCode(source: string): string {
  try { compileTinySol(source); return "NO_ERROR"; } catch (error) { return isToolchainError(error) ? error.code : "UNKNOWN"; }
}

describe("TinySol compile-time extensions", () => {
  it("parses typed constants and numeric separators", () => {
    const ast = parseTinySol("contract C { const uint256 MAX = 1_000_000; function max() view returns(uint256){ return MAX; } }");
    assert.equal(ast.contract.constants[0]?.name, "MAX");
    assert.equal(ast.contract.constants[0]?.value.kind, "LiteralExpression");
    assert.equal(ast.contract.constants[0]?.value.kind === "LiteralExpression" ? ast.contract.constants[0].value.value : "", "1000000");
  });

  it("evaluates constants without allocating storage", () => {
    const source = "contract C { const uint256 A = 40; const uint256 B = true ? A + 2 : 0; function value() view returns(uint256){ return B; } }";
    const result = compileTinySol(source);
    assert.equal(result.storageLayout.items.length, 0);
    assert.match(result.assembly, /PUSH1 0x2a/);
  });

  it("reports stable constant evaluation failures", () => {
    assert.equal(errorCode("contract C { const uint256 X = 1 / 0; }"), ToolchainErrorCode.CONST_EVAL_DIV_ZERO);
    assert.equal(errorCode("contract C { const uint256 X = 1 << 256; }"), ToolchainErrorCode.CONST_EVAL_INVALID_SHIFT);
    assert.equal(errorCode("contract C { const uint256 X = X; }"), ToolchainErrorCode.CONSTANT_CYCLE);
    assert.equal(errorCode(`contract C { const uint256 X = ${(1n << 256n).toString()}; }`), ToolchainErrorCode.LITERAL_OVERFLOW);
    assert.equal(errorCode("contract C { const uint256 X = 1__0; }"), ToolchainErrorCode.INVALID_LITERAL);
    assert.equal(errorCode("contract C { const bool X = 1; }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("supports all 8-bit-step integer widths without storage packing", () => {
    const source = `contract C {
      const uint8 MAX = 255;
      uint8 small;
      int24 signedValue;
      function widen(uint8 value) view returns(uint256) { return value; }
      function cast(uint256 value) view returns(uint16) { return uint16(value); }
    }`;
    const build = compileTinySol(source, { includeSyntax: true });
    assert.deepEqual(build.abi.functions.map((fn) => fn.signature), ["widen(uint8)", "cast(uint256)"]);
    assert.deepEqual(build.storageLayout.items.map((item) => [item.type, item.slot]), [
      ["uint8", `0x${"00".repeat(32)}`],
      ["int24", `0x${"00".repeat(31)}01`]
    ]);
    assert.equal(build.ast?.contract.functions[1]?.body.statements[0]?.kind === "ReturnStatement" ? build.ast.contract.functions[1].body.statements[0].values[0]?.kind : undefined, "CastExpression");
    assert.equal(errorCode("contract C { const uint8 X = 256; }"), ToolchainErrorCode.LITERAL_OVERFLOW);
    assert.equal(errorCode("contract C { const int8 X = -129; }"), ToolchainErrorCode.LITERAL_OVERFLOW);
    assert.equal(errorCode("contract C { function f(uint256 value) view returns(uint8){ return value; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { function f(bool value) view returns(uint8){ return uint8(value); } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("checks narrow ABI inputs, arithmetic and explicit casts at runtime", () => {
    const build = compileTinySol(`contract C {
      function add(uint8 left, uint8 right) view returns(uint8) { return left + right; }
      function cast(uint256 value) view returns(uint8) { return uint8(value); }
      function signed(int8 value) view returns(int8) { return -value; }
      function mul(uint248 left, uint248 right) view returns(uint248) { return left * right; }
    }`);
    const target = `0x01${"ab".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"cd".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const execute = (signature: string, ...values: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${values.map((value) => (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, "0")).join("")}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(execute("add(uint8,uint8)", 254n, 1n).output, `0x${255n.toString(16).padStart(64, "0")}`);
    assert.equal(execute("add(uint8,uint8)", 255n, 1n).success, false);
    assert.equal(execute("add(uint8,uint8)", 256n, 0n).success, false);
    assert.equal(execute("cast(uint256)", 255n).success, true);
    assert.equal(execute("cast(uint256)", 256n).success, false);
    assert.equal(execute("signed(int8)", -127n).output, `0x${127n.toString(16).padStart(64, "0")}`);
    assert.equal(execute("signed(int8)", -128n).success, false);
    assert.equal(execute("signed(int8)", -129n).success, false);
    assert.equal(execute("mul(uint248,uint248)", 2n, 3n).output, `0x${6n.toString(16).padStart(64, "0")}`);
    assert.equal(execute("mul(uint248,uint248)", 1n << 247n, 512n).success, false);
  });

  it("lowers enums in declaration order and guards ABI inputs", () => {
    const source = `contract C {
      enum Status { Pending, Active, Closed }
      Status status;
      function set(Status next) { status = next; }
      function active() view returns(Status) { return Status.Active; }
    }`;
    const build = compileTinySol(source, { includeSyntax: true });
    assert.equal(build.ast?.contract.enums[0]?.members[1]?.name, "Active");
    assert.equal(build.abi.functions[0]?.signature, "set(uint256)");
    assert.deepEqual(build.abi.functions[1]?.outputs, ["uint256"]);
    assert.equal(build.storageLayout.items[0]?.type, "uint256");
    const target = `0x01${"11".repeat(31)}` as Bytes32;
    const actor = `0x${"00".repeat(12)}0000000000000000000000000000000000002222` as Bytes32;
    const call = (value: bigint): Hex => `${functionSelector("set(uint256)")}${value.toString(16).padStart(64, "0")}` as Hex;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const accepted = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: call(2n), byteLimit: 100_000 }, context: { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } } });
    const rejected = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: call(3n), byteLimit: 100_000 }, context: { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } } });
    assert.equal(accepted.success, true);
    assert.equal(rejected.success, false);
    assert.deepEqual(rejected.storageDiff, []);
  });

  it("rejects invalid enum members and cross-type assignment", () => {
    assert.equal(errorCode("contract C { enum S { A } function f() view returns(S){ return S.B; } }"), ToolchainErrorCode.UNDEFINED_SYMBOL);
    assert.equal(errorCode("contract C { enum S { A } enum T { A } function f(){ S s = T.A; } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("preserves enum guards in for initializers and updates", () => {
    const build = compileTinySol(`contract C { enum Status { Pending, Active, Closed }
      function next(Status value) internal view returns(Status) { return value == Status.Pending ? Status.Active : Status.Closed; }
      function count() view returns(uint256) {
        uint256 total = 0;
        for (Status value = Status.Pending; value != Status.Closed; value = next(value)) { total++; }
        return total;
      }
    }`);
    const target = `0x01${"22".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"23".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("count()"), byteLimit: 100_000 }, context: { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } } });
    assert.equal(result.success, true); assert.equal(result.output, `0x${2n.toString(16).padStart(64, "0")}`);
  });

  it("flattens structs through ABI, storage, locals and mappings", () => {
    const source = `contract Registry {
      enum Status { Pending, Active, Closed }
      struct Position { account owner; uint256 amount; Status status; }
      Position current;
      mapping(uint256 => Position) records;
      function set(Position next) { current = next; }
      function store(uint256 id, Position next) { records[id] = next; }
      function read() view returns(Position) { return current; }
      function amount(uint256 id) view returns(uint256) { return records[id].amount; }
      function local(account owner) view returns(uint256) {
        Position p = Position({ owner: owner, amount: 7, status: Status.Active });
        return p.amount;
      }
    }`;
    const build = compileTinySol(source, { includeSyntax: true });
    assert.equal(build.ast?.contract.structs[0]?.fields.length, 3);
    assert.deepEqual(build.abi.functions[0]?.inputs, ["account", "uint256", "uint256"]);
    assert.deepEqual(build.abi.functions[2]?.outputs, ["account", "uint256", "uint256"]);
    assert.deepEqual(build.storageLayout.items.map((item) => item.name), ["current.owner", "current.amount", "current.status", "records.owner", "records.amount", "records.status"]);
    assert.deepEqual(build.storageLayout.items.slice(0, 3).map((item) => item.slot), [`0x${"00".repeat(32)}`, `0x${"00".repeat(31)}01`, `0x${"00".repeat(31)}02`]);
    assert.match(build.assembly, /SSTORE/);
  });

  it("keeps struct event descriptors aligned with lowered LOG data", () => {
    const build = compileTinySol("contract C { struct P { uint256 value; bool ok; } event Changed(P value); function emitOne(P value){ emit Changed(value); } }");
    assert.equal(build.eventDescriptor.events[0]?.signature, "Changed(uint256,bool)");
    assert.deepEqual(build.eventDescriptor.events[0]?.fields.map((field) => field.name), ["value.value", "value.ok"]);
  });

  it("keeps struct-array event and error descriptors field-first", () => {
    const build = compileTinySol(`contract C { struct P { uint256 x; bool ok; }
      event Changed(P[2] values); error Invalid(P[2] values);
      function fail(P[2] values) { revert Invalid(values); }
    }`);
    assert.equal(build.eventDescriptor.events[0]?.signature, "Changed(uint256,uint256,bool,bool)");
    assert.deepEqual(build.eventDescriptor.events[0]?.fields.map((field) => field.name), ["values.x.0", "values.x.1", "values.ok.0", "values.ok.1"]);
    const error = build.abi.errors?.[0]; assert.equal(error?.signature, "Invalid(uint256,uint256,bool,bool)");
    const target = `0x01${"23".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"24".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const arguments_ = `${5n.toString(16).padStart(64, "0")}${6n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${0n.toString(16).padStart(64, "0")}`;
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("fail(uint256,uint256,bool,bool)")}${arguments_}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(result.success, false); assert.equal(result.revertData, `${error?.selector}${arguments_}`);
  });

  it("executes atomic local, nested and returned struct values", () => {
    const build = compileTinySol(`contract C {
      struct Inner { uint256 x; uint256 y; }
      struct Outer { Inner inner; uint256 tag; }
      function make(uint256 value) internal view returns(Inner) { return Inner({x:value,y:value+1}); }
      function pair(uint256 value) internal view returns(Inner,uint256) { return Inner({x:value,y:value+1}), 3; }
      function relay(uint256 value) view returns(Inner) { return make(value); }
      function work() view returns(uint256,uint256,uint256) {
        Inner item = Inner({x:3,y:4});
        item = Inner({x:item.y,y:item.x});
        Outer wrapped = Outer({inner:item,tag:5});
        wrapped.inner = Inner({x:wrapped.inner.y,y:wrapped.inner.x});
        (Inner quoted, uint256 bonus) = pair(wrapped.inner.x);
        return wrapped.inner.x, quoted.y, bonus;
      }
    }`);
    assert.deepEqual(build.abi.functions.map((fn) => [fn.signature, fn.outputs]), [
      ["relay(uint256)", ["uint256", "uint256"]],
      ["work()", ["uint256", "uint256", "uint256"]]
    ]);
    const target = `0x01${"24".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"25".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const execute = (signature: string, args = "") => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${args}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(execute("relay(uint256)", 8n.toString(16).padStart(64, "0")).output, `0x${8n.toString(16).padStart(64, "0")}${9n.toString(16).padStart(64, "0")}`);
    assert.equal(execute("work()").output, `0x${3n.toString(16).padStart(64, "0")}${4n.toString(16).padStart(64, "0")}${3n.toString(16).padStart(64, "0")}`);
  });

  it("statically flattens struct values across external calls", () => {
    const provider = compileTinySol("contract P { struct Pair { uint256 x; uint256 y; } function turn(Pair value) view returns(Pair) { return Pair({x:value.y,y:value.x}); } }");
    const relay = compileTinySol(`interface P { function turn(Pair) view returns(Pair); }
      contract R { struct Pair { uint256 x; uint256 y; } function relay(account target, Pair value) view returns(Pair) { return staticcall P.turn(target,value); } }`);
    assert.equal(provider.abi.functions[0]?.signature, "turn(uint256,uint256)");
    assert.equal(relay.abi.functions[0]?.signature, "relay(bytes32,uint256,uint256)");
    const remote = `0x01${"26".repeat(31)}` as Bytes32; const target = `0x01${"27".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"28".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [provider.codeHash]: encodeProgramPackageHex(provider.package), [relay.codeHash]: encodeProgramPackageHex(relay.package) }, programs: { [remote]: { codeHash: provider.codeHash }, [target]: { codeHash: relay.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const payload = `${functionSelector("relay(bytes32,uint256,uint256)")}${remote.slice(2)}${7n.toString(16).padStart(64, "0")}${9n.toString(16).padStart(64, "0")}` as Hex;
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 100_000 }, context });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${9n.toString(16).padStart(64, "0")}${7n.toString(16).padStart(64, "0")}`);
  });

  it("evaluates a whole-struct storage index once", () => {
    const build = compileTinySol(`contract C {
      struct Pair { uint256 x; uint256 y; }
      uint256 cursor;
      Pair[3] values;
      function next() internal returns(uint256) { uint256 index = cursor; cursor += 1; return index; }
      function write() { values[next()] = Pair({x:7,y:8}); }
      function read() view returns(uint256,uint256,uint256) { return cursor, values[0].x, values[0].y; }
    }`);
    const target = `0x01${"29".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"2a".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const written = simulateMiniVM({ state: initial, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("write()"), byteLimit: 100_000 }, context });
    const result = simulateMiniVM({ state: written.state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("read()"), byteLimit: 100_000 }, context });
    assert.equal(written.success, true); assert.equal(result.success, true);
    assert.equal(result.output, `0x${1n.toString(16).padStart(64, "0")}${7n.toString(16).padStart(64, "0")}${8n.toString(16).padStart(64, "0")}`);
  });

  it("flattens struct fields in named errors", () => {
    const build = compileTinySol("contract C { struct Pair { uint256 x; bool ok; } error Invalid(Pair value); function fail() { revert Invalid(Pair({x:7,ok:true})); } }");
    const descriptor = build.abi.errors?.[0];
    assert.equal(descriptor?.signature, "Invalid(uint256,bool)");
    const target = `0x01${"2b".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"2c".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("fail()"), byteLimit: 100_000 }, context: { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } } });
    assert.equal(result.success, false);
    assert.equal(result.revertData, `${descriptor?.selector}${7n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}`);
  });

  it("rejects struct cycles, duplicate fields and malformed literals", () => {
    assert.equal(errorCode("contract C { struct A { A next; } A value; }"), ToolchainErrorCode.STRUCT_CYCLE);
    assert.equal(errorCode("contract C { struct A { uint256 x; bool x; } A value; }"), ToolchainErrorCode.DUPLICATE_FIELD);
    assert.equal(errorCode("contract C { struct A { uint256 x; } function f(){ A a = A({}); } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { Missing value; }"), ToolchainErrorCode.UNKNOWN_TYPE);
    assert.equal(errorCode("contract C { enum S { A } struct P { S status; } P value; function f(){ value.status = 2; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { struct P { uint256 x; } struct Q { uint256 x; } function make() internal view returns(P,uint256){ return P({x:1}),2; } function f(){ (Q value, uint256 extra) = make(); } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("bounds-checks fixed storage arrays before reads and writes", () => {
    const source = `contract C {
      uint256[3] values;
      function set(uint256 index, uint256 value) { values[index] = value; }
      function get(uint256 index) view returns(uint256) { return values[index]; }
    }`;
    const build = compileTinySol(source);
    assert.equal(build.storageLayout.items[0]?.type, "uint256[3]");
    assert.equal(build.storageLayout.items[0]?.length, 3);
    const target = `0x01${"33".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"44".repeat(20)}` as Bytes32;
    const payload = (index: bigint, value: bigint): Hex => `${functionSelector("set(uint256,uint256)")}${index.toString(16).padStart(64, "0")}${value.toString(16).padStart(64, "0")}` as Hex;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const accepted = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: payload(2n, 9n), byteLimit: 100_000 }, context });
    const rejected = simulateMiniVM({ state: accepted.state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: payload(3n, 7n), byteLimit: 100_000 }, context });
    assert.equal(accepted.success, true); assert.equal(rejected.success, false); assert.deepEqual(rejected.storageDiff, []);
    assert.equal(errorCode("contract C { uint256[2] a; function f() view returns(uint256){ return a[2]; } }"), ToolchainErrorCode.ARRAY_BOUNDS);
  });

  it("lays out arrays of structs as bounded field arrays", () => {
    const source = `contract C { struct Item { uint256 id; bool done; } Item[4] items; function put(uint256 index, Item item) { items[index] = item; } function done(uint256 index) view returns(bool) { return items[index].done; } }`;
    const build = compileTinySol(source);
    assert.deepEqual(build.storageLayout.items.map((item) => [item.name, item.type, item.slot]), [
      ["items.id", "uint256[4]", `0x${"00".repeat(32)}`],
      ["items.done", "bool[4]", `0x${"00".repeat(31)}04`]
    ]);
  });

  it("executes fixed-array fields inside structs", () => {
    const build = compileTinySol(`contract C {
      enum Status { Empty, Live }
      struct Tick { int24 index; }
      struct Pool { uint256[2] reserves; Status[2] states; Tick[2] ticks; }
      Pool pool;
      function replace() { pool = Pool({reserves:[7,8],states:[Status.Live,Status.Empty],ticks:[Tick({index:-2}),Tick({index:3})]}); }
      function put(uint256 i, uint256 reserve, Status state, int24 tick) { pool.reserves[i] = reserve; pool.states[i] = state; pool.ticks[i].index = tick; }
      function get(uint256 i) view returns(uint256,Status,int24) { return pool.reserves[i], pool.states[i], pool.ticks[i].index; }
      function snapshot() view returns(Pool) { return pool; }
      function echo(Pool value) view returns(Pool) { return value; }
    }`);
    assert.deepEqual(build.storageLayout.items.map((item) => [item.name, item.type, item.slot]), [
      ["pool.reserves", "uint256[2]", `0x${"00".repeat(32)}`],
      ["pool.states", "uint256[2]", `0x${"00".repeat(31)}02`],
      ["pool.ticks.index", "int24[2]", `0x${"00".repeat(31)}04`]
    ]);
    assert.deepEqual(build.abi.functions.map((fn) => [fn.signature, fn.outputs]), [
      ["replace()", []],
      ["put(uint256,uint256,uint256,int24)", []],
      ["get(uint256)", ["uint256", "uint256", "int24"]],
      ["snapshot()", ["uint256", "uint256", "uint256", "uint256", "int24", "int24"]],
      ["echo(uint256,uint256,uint256,uint256,int24,int24)", ["uint256", "uint256", "uint256", "uint256", "int24", "int24"]]
    ]);
    const target = `0x01${"51".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"52".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const replaced = simulateMiniVM({ state: initial, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("replace()"), byteLimit: 100_000 }, context });
    const read = (state: typeof initial, index: bigint) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("get(uint256)")}${index.toString(16).padStart(64, "0")}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(replaced.success, true);
    assert.equal(read(replaced.state, 0n).output, `0x${7n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${((1n << 256n) - 2n).toString(16).padStart(64, "0")}`);
    assert.equal(read(replaced.state, 1n).output, `0x${8n.toString(16).padStart(64, "0")}${0n.toString(16).padStart(64, "0")}${3n.toString(16).padStart(64, "0")}`);
    assert.equal(read(replaced.state, 2n).success, false);
    const snapshot = simulateMiniVM({ state: replaced.state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("snapshot()"), byteLimit: 100_000 }, context });
    assert.equal(snapshot.output, `0x${7n.toString(16).padStart(64, "0")}${8n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${0n.toString(16).padStart(64, "0")}${((1n << 256n) - 2n).toString(16).padStart(64, "0")}${3n.toString(16).padStart(64, "0")}`);
    const echoPayload = `${functionSelector("echo(uint256,uint256,uint256,uint256,int24,int24)")}${[1n,2n,0n,1n,4n,5n].map((value) => value.toString(16).padStart(64, "0")).join("")}` as Hex;
    assert.equal(simulateMiniVM({ state: initial, action: { op: "CALL", actor, targetOrCodeHash: target, payload: echoPayload, byteLimit: 100_000 }, context }).output, echoPayload.replace(functionSelector("echo(uint256,uint256,uint256,uint256,int24,int24)"), "0x"));
    const invalidPayload = `${functionSelector("echo(uint256,uint256,uint256,uint256,int24,int24)")}${[1n,2n,0n,2n,4n,5n].map((value) => value.toString(16).padStart(64, "0")).join("")}` as Hex;
    assert.equal(simulateMiniVM({ state: initial, action: { op: "CALL", actor, targetOrCodeHash: target, payload: invalidPayload, byteLimit: 100_000 }, context }).success, false);
  });

  it("preserves nominal enum types in struct array fields", () => {
    assert.equal(errorCode("contract C { enum A { X } enum B { X } struct P { A[2] states; } function f(){ P p = P({states:[B.X,B.X]}); } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { enum A { X } struct P { A[2] states; } function f(){ P p = P({states:[A.X,0]}); } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { enum A { X } enum B { X } struct P { A[2] states; } P p; function f(){ p.states[0] = B.X; } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("stores array-bearing structs inside mappings with nested bounds", () => {
    const build = compileTinySol(`contract C {
      enum Status { Empty, Live }
      struct Tick { int24 index; uint256 liquidity; }
      struct Pool { uint256[2] reserves; Status[2] states; Tick[2] ticks; }
      mapping(uint256=>Pool) pools;
      function replace(uint256 key) { pools[key] = Pool({reserves:[7,8],states:[Status.Live,Status.Empty],ticks:[Tick({index:-2,liquidity:9}),Tick({index:3,liquidity:10})]}); }
      function put(uint256 key, uint256 i, uint256 reserve, Status state, int24 tick, uint256 liquidity) { pools[key].reserves[i] = reserve; pools[key].states[i] = state; pools[key].ticks[i] = Tick({index:tick,liquidity:liquidity}); }
      function bump(uint256 key, uint256 i) { pools[key].reserves[i] += 1; }
      function clear(uint256 key) { delete pools[key]; }
      function get(uint256 key, uint256 i) view returns(uint256,Status,int24,uint256) { return pools[key].reserves[i], pools[key].states[i], pools[key].ticks[i].index, pools[key].ticks[i].liquidity; }
      function snapshot(uint256 key) view returns(Pool) { return pools[key]; }
    }`);
    assert.deepEqual(build.storageLayout.items.map((item) => [item.name, item.type, item.length]), [
      ["pools.reserves", "mapping(uint256=>uint256[2])", 2],
      ["pools.states", "mapping(uint256=>uint256[2])", 2],
      ["pools.ticks.index", "mapping(uint256=>int24[2])", 2],
      ["pools.ticks.liquidity", "mapping(uint256=>uint256[2])", 2]
    ]);
    assert.ok(build.storageLayout.items.every((item) => item.nestedMappingScheme === "keccak256(keccak256(domain,key),index)"));
    const target = `0x01${"56".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"57".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const word = (value: bigint) => (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, "0");
    const replaced = simulateMiniVM({ state: initial, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("replace(uint256)")}${word(5n)}` as Hex, byteLimit: 100_000 }, context });
    const read = (state: typeof initial, key: bigint, index: bigint) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("get(uint256,uint256)")}${word(key)}${word(index)}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(replaced.success, true);
    assert.equal(read(replaced.state, 5n, 0n).output, `0x${word(7n)}${word(1n)}${word(-2n)}${word(9n)}`);
    assert.equal(read(replaced.state, 5n, 1n).output, `0x${word(8n)}${word(0n)}${word(3n)}${word(10n)}`);
    assert.equal(read(replaced.state, 6n, 0n).output, `0x${word(0n)}${word(0n)}${word(0n)}${word(0n)}`);
    assert.equal(read(replaced.state, 5n, 2n).success, false);
    const bumped = simulateMiniVM({ state: replaced.state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("bump(uint256,uint256)")}${word(5n)}${word(0n)}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(read(bumped.state, 5n, 0n).output, `0x${word(8n)}${word(1n)}${word(-2n)}${word(9n)}`);
    const cleared = simulateMiniVM({ state: bumped.state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("clear(uint256)")}${word(5n)}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(read(cleared.state, 5n, 0n).output, `0x${word(0n)}${word(0n)}${word(0n)}${word(0n)}`);
    const invalid = `${functionSelector("put(uint256,uint256,uint256,uint256,int24,uint256)")}${[5n,0n,1n,2n,0n,0n].map(word).join("")}` as Hex;
    assert.equal(simulateMiniVM({ state: replaced.state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: invalid, byteLimit: 100_000 }, context }).success, false);
  });

  it("linearizes array-bearing structs inside outer fixed arrays", () => {
    const build = compileTinySol(`contract C {
      enum Status { Empty, Live }
      struct Tick { int24 index; }
      struct Pool { uint256[2] reserves; Status[2] states; Tick[2] ticks; }
      Pool[2] pools;
      function replace() { pools = [
        Pool({reserves:[1,2],states:[Status.Live,Status.Empty],ticks:[Tick({index:-1}),Tick({index:-2})]}),
        Pool({reserves:[3,4],states:[Status.Empty,Status.Live],ticks:[Tick({index:5}),Tick({index:6})]})
      ]; }
      function put(uint256 outer, uint256 inner, uint256 reserve, Status state, int24 tick) { pools[outer].reserves[inner] = reserve; pools[outer].states[inner] = state; pools[outer].ticks[inner] = Tick({index:tick}); }
      function bump(uint256 outer, uint256 inner) { pools[outer].reserves[inner] += 1; }
      function clear(uint256 outer) { delete pools[outer]; }
      function clearAll() { delete pools; }
      function get(uint256 outer, uint256 inner) view returns(uint256,Status,int24) { return pools[outer].reserves[inner], pools[outer].states[inner], pools[outer].ticks[inner].index; }
      function snapshot() view returns(Pool[2]) { return pools; }
      function echo(Pool[2] values, uint256 outer, uint256 inner) view returns(uint256,Status,int24) { return values[outer].reserves[inner], values[outer].states[inner], values[outer].ticks[inner].index; }
    }`);
    assert.deepEqual(build.storageLayout.items.map((item) => [item.name, item.type, item.length, item.dimensions, item.slot]), [
      ["pools.reserves", "uint256[2][2]", 4, [2, 2], `0x${"00".repeat(32)}`],
      ["pools.states", "uint256[2][2]", 4, [2, 2], `0x${"00".repeat(31)}04`],
      ["pools.ticks.index", "int24[2][2]", 4, [2, 2], `0x${"00".repeat(31)}08`]
    ]);
    assert.deepEqual(build.abi.functions.find((fn) => fn.name === "snapshot")?.outputs, ["uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "int24", "int24", "int24", "int24"]);
    const target = `0x01${"58".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"59".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const word = (value: bigint) => (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, "0");
    const call = (state: typeof initial, signature: string, ...values: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${values.map(word).join("")}` as Hex, byteLimit: 100_000 }, context });
    const replaced = call(initial, "replace()");
    assert.equal(replaced.success, true);
    assert.equal(call(replaced.state, "get(uint256,uint256)", 0n, 1n).output, `0x${word(2n)}${word(0n)}${word(-2n)}`);
    assert.equal(call(replaced.state, "get(uint256,uint256)", 1n, 0n).output, `0x${word(3n)}${word(0n)}${word(5n)}`);
    assert.equal(call(replaced.state, "get(uint256,uint256)", 2n, 0n).success, false);
    assert.equal(call(replaced.state, "get(uint256,uint256)", 0n, 2n).success, false);
    const bumped = call(replaced.state, "bump(uint256,uint256)", 1n, 1n);
    assert.equal(call(bumped.state, "get(uint256,uint256)", 1n, 1n).output, `0x${word(5n)}${word(1n)}${word(6n)}`);
    const cleared = call(bumped.state, "clear(uint256)", 0n);
    assert.equal(call(cleared.state, "get(uint256,uint256)", 0n, 1n).output, `0x${word(0n)}${word(0n)}${word(0n)}`);
    const snapshot = call(replaced.state, "snapshot()");
    assert.equal(snapshot.output, `0x${[1n,2n,3n,4n,1n,0n,0n,1n,-1n,-2n,5n,6n].map(word).join("")}`);
    const echoValues = [1n,2n,3n,4n,1n,0n,0n,1n,-1n,-2n,5n,6n,1n,0n];
    assert.equal(call(initial, "echo(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int24,int24,int24,int24,uint256,uint256)", ...echoValues).output, `0x${word(3n)}${word(0n)}${word(5n)}`);
    const invalidEnum = [1n,2n,3n,4n,1n,0n,0n,2n,-1n,-2n,5n,6n,1n,0n];
    assert.equal(call(initial, "echo(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int24,int24,int24,int24,uint256,uint256)", ...invalidEnum).success, false);
    const clearedAll = call(replaced.state, "clearAll()");
    assert.equal(call(clearedAll.state, "get(uint256,uint256)", 1n, 1n).output, `0x${word(0n)}${word(0n)}${word(0n)}`);
  });

  it("evaluates each nested fixed-array index exactly once", () => {
    const build = compileTinySol(`contract C {
      struct Pool { uint256[2] reserves; }
      Pool[2] pools; uint256 cursor;
      function next() internal returns(uint256) { uint256 value = cursor; cursor += 1; return value; }
      function write() { pools[next()].reserves[next()] = 9; }
      function read() view returns(uint256,uint256) { return cursor, pools[0].reserves[1]; }
    }`);
    const target = `0x01${"5a".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"5b".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const written = simulateMiniVM({ state: initial, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("write()"), byteLimit: 100_000 }, context });
    const result = simulateMiniVM({ state: written.state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("read()"), byteLimit: 100_000 }, context });
    assert.equal(written.success, true);
    assert.equal(result.output, `0x${2n.toString(16).padStart(64, "0")}${9n.toString(16).padStart(64, "0")}`);
  });

  it("supports arrays of array-bearing structs across storage, mappings, outer arrays and ABI", () => {
    const asymmetric = compileTinySol("contract Shape { struct Leaf { uint256[3] values; } struct Book { Leaf[2] leaves; } Book[4] books; }");
    assert.deepEqual(asymmetric.storageLayout.items.map((item) => [item.type, item.length, item.dimensions]), [["uint256[3][2][4]", 24, [4, 2, 3]]]);
    const build = compileTinySol(`contract C {
      enum Status { Empty, Live }
      struct Leaf { uint256[2] values; Status[2] states; }
      struct Book { Leaf[2] leaves; uint256 tag; }
      Book book; mapping(uint256=>Book) books; Book[2] shelf;
      function replace() { book = Book({leaves:[Leaf({values:[1,2],states:[Status.Live,Status.Empty]}),Leaf({values:[3,4],states:[Status.Empty,Status.Live]})],tag:9}); }
      function put(uint256 leaf, uint256 item, uint256 value, Status state) { book.leaves[leaf].values[item] = value; book.leaves[leaf].states[item] = state; }
      function replaceLeaf(uint256 leaf) { book.leaves[leaf] = Leaf({values:[7,8],states:[Status.Live,Status.Live]}); }
      function clearLeaf(uint256 leaf) { delete book.leaves[leaf]; }
      function get(uint256 leaf, uint256 item) view returns(uint256,Status,uint256) { return book.leaves[leaf].values[item], book.leaves[leaf].states[item], book.tag; }
      function store(uint256 key) { books[key] = book; }
      function mapped(uint256 key, uint256 leaf, uint256 item) view returns(uint256,Status) { return books[key].leaves[leaf].values[item], books[key].leaves[leaf].states[item]; }
      function shelve(uint256 outer, uint256 leaf) { shelf[outer].leaves[leaf] = Leaf({values:[11,12],states:[Status.Empty,Status.Live]}); }
      function shelved(uint256 outer, uint256 leaf, uint256 item) view returns(uint256,Status) { return shelf[outer].leaves[leaf].values[item], shelf[outer].leaves[leaf].states[item]; }
      function echo(Book value, uint256 leaf, uint256 item) view returns(uint256,Status,uint256) { return value.leaves[leaf].values[item], value.leaves[leaf].states[item], value.tag; }
      function snapshot() view returns(Book) { return book; }
    }`);
    assert.deepEqual(build.storageLayout.items.slice(0, 3).map((item) => [item.name, item.type, item.length, item.dimensions]), [
      ["book.leaves.values", "uint256[2][2]", 4, [2, 2]],
      ["book.leaves.states", "uint256[2][2]", 4, [2, 2]],
      ["book.tag", "uint256", undefined, undefined]
    ]);
    assert.deepEqual(build.storageLayout.items.slice(3, 5).map((item) => [item.name, item.type, item.length, item.dimensions]), [
      ["books.leaves.values", "mapping(uint256=>uint256[2][2])", 4, [2, 2]],
      ["books.leaves.states", "mapping(uint256=>uint256[2][2])", 4, [2, 2]]
    ]);
    assert.deepEqual(build.storageLayout.items.slice(6, 8).map((item) => [item.name, item.type, item.length, item.dimensions]), [
      ["shelf.leaves.values", "uint256[2][2][2]", 8, [2, 2, 2]],
      ["shelf.leaves.states", "uint256[2][2][2]", 8, [2, 2, 2]]
    ]);
    const target = `0x01${"5c".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"5d".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const word = (value: bigint) => value.toString(16).padStart(64, "0");
    const call = (state: typeof initial, signature: string, ...values: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${values.map(word).join("")}` as Hex, byteLimit: 100_000 }, context });
    const replaced = call(initial, "replace()");
    assert.equal(replaced.success, true);
    assert.equal(call(replaced.state, "get(uint256,uint256)", 1n, 1n).output, `0x${word(4n)}${word(1n)}${word(9n)}`);
    assert.equal(call(replaced.state, "get(uint256,uint256)", 2n, 0n).success, false);
    assert.equal(call(replaced.state, "get(uint256,uint256)", 0n, 2n).success, false);
    const leaf = call(replaced.state, "replaceLeaf(uint256)", 0n);
    assert.equal(call(leaf.state, "get(uint256,uint256)", 0n, 1n).output, `0x${word(8n)}${word(1n)}${word(9n)}`);
    const cleared = call(leaf.state, "clearLeaf(uint256)", 0n);
    assert.equal(call(cleared.state, "get(uint256,uint256)", 0n, 1n).output, `0x${word(0n)}${word(0n)}${word(9n)}`);
    const stored = call(replaced.state, "store(uint256)", 5n);
    assert.equal(call(stored.state, "mapped(uint256,uint256,uint256)", 5n, 1n, 0n).output, `0x${word(3n)}${word(0n)}`);
    assert.equal(call(stored.state, "mapped(uint256,uint256,uint256)", 5n, 1n, 2n).success, false);
    const shelved = call(initial, "shelve(uint256,uint256)", 1n, 0n);
    assert.equal(call(shelved.state, "shelved(uint256,uint256,uint256)", 1n, 0n, 1n).output, `0x${word(12n)}${word(1n)}`);
    assert.equal(call(shelved.state, "shelved(uint256,uint256,uint256)", 2n, 0n, 0n).success, false);
    const bookWords = [1n,2n,3n,4n,1n,0n,0n,1n,9n];
    const echoSignature = "echo(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)";
    assert.equal(call(initial, echoSignature, ...bookWords, 1n, 0n).output, `0x${word(3n)}${word(0n)}${word(9n)}`);
    assert.equal(call(initial, echoSignature, 1n,2n,3n,4n,1n,0n,0n,2n,9n,1n,0n).success, false);
    assert.equal(call(replaced.state, "snapshot()").output, `0x${bookWords.map(word).join("")}`);
  });

  it("guards enum array fields returned by untrusted contracts", () => {
    const malicious = compileTinySol(`contract P {
      function echo(uint256 a, uint256 b, uint256 c, uint256 d) view returns(uint256,uint256,uint256,uint256) { return a, 7, c, d; }
    }`);
    const relay = compileTinySol(`interface P { function echo(Book) view returns(Book); }
      contract R {
        enum Status { Empty, Live }
        struct Leaf { Status[2] states; }
        struct Book { Leaf[2] leaves; }
        function relay(account target, Book value) view returns(Book) { return staticcall P.echo(target, value); }
      }
    `);
    const remote = `0x01${"53".repeat(31)}` as Bytes32; const target = `0x01${"54".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"55".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [malicious.codeHash]: encodeProgramPackageHex(malicious.package), [relay.codeHash]: encodeProgramPackageHex(relay.package) }, programs: { [remote]: { codeHash: malicious.codeHash }, [target]: { codeHash: relay.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const payload = `${functionSelector("relay(bytes32,uint256,uint256,uint256,uint256)")}${remote.slice(2)}${[0n,1n,3n,4n].map((value) => value.toString(16).padStart(64, "0")).join("")}` as Hex;
    assert.equal(simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 100_000 }, context }).success, false);
  });

  it("executes local fixed arrays with literals, copies and dynamic checked indexes", () => {
    const source = `contract C {
      function work(uint256 index) view returns(uint256,uint256) {
        uint256[3] values = [4,5,6];
        values[1] += 2;
        uint256[3] copied;
        copied = values;
        values = [values[2], values[0], values[1]];
        delete copied[0];
        return values[index], copied[1];
      }
    }`;
    const build = compileTinySol(source, { includeSyntax: true });
    const declaration = build.ast?.contract.functions[0]?.body.statements[0];
    assert.equal(declaration?.kind, "VariableDeclaration");
    assert.equal(declaration?.kind === "VariableDeclaration" ? declaration.type.arrayLength : undefined, 3);
    assert.equal(declaration?.kind === "VariableDeclaration" && declaration.initializer?.kind === "ArrayLiteralExpression" ? declaration.initializer.elements.length : 0, 3);
    const target = `0x01${"31".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"32".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const execute = (index: bigint) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("work(uint256)")}${index.toString(16).padStart(64, "0")}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(execute(0n).output, `0x${6n.toString(16).padStart(64, "0")}${7n.toString(16).padStart(64, "0")}`);
    assert.equal(execute(2n).output, `0x${7n.toString(16).padStart(64, "0")}${7n.toString(16).padStart(64, "0")}`);
    assert.equal(execute(3n).success, false);
  });

  it("executes direct multidimensional scalar arrays across storage, mappings, structs, locals and ABI", () => {
    const build = compileTinySol(`contract C {
      struct Grid { uint256[3][2] cells; }
      uint256[3][2] matrix;
      mapping(uint256=>uint256[3][2]) mapped;
      Grid grid;
      function set(uint256 outer, uint256 inner, uint256 value) {
        matrix[outer][inner] = value;
        mapped[9][outer][inner] = value + 1;
        grid.cells[outer][inner] = value + 2;
      }
      function read(uint256 outer, uint256 inner) view returns(uint256,uint256,uint256) {
        return matrix[outer][inner], mapped[9][outer][inner], grid.cells[outer][inner];
      }
      function local(uint256 outer, uint256 inner) view returns(uint256,uint256) {
        uint256[3][2] values = [[1,2,3],[4,5,6]];
        uint256[3][2] copied;
        copied = values;
        values = [[7,8,9],[10,11,12]];
        return values[outer][inner], copied[outer][inner];
      }
      function echo(uint256[3][2] values) view returns(uint256[3][2]) { return values; }
    }`, { includeSyntax: true });
    const matrix = build.ast?.contract.stateVariables[0];
    assert.equal(matrix?.type.kind === "ScalarType" ? matrix.type.arrayLength : undefined, 6);
    assert.deepEqual(matrix?.type.kind === "ScalarType" ? matrix.type.arrayDimensions : undefined, [2, 3]);
    assert.deepEqual(build.storageLayout.items.map((item) => [item.name, item.type, item.length, item.dimensions]), [
      ["matrix", "uint256[3][2]", 6, [2, 3]],
      ["mapped", "mapping(uint256=>uint256[3][2])", 6, [2, 3]],
      ["grid.cells", "uint256[3][2]", 6, [2, 3]]
    ]);
    assert.equal(build.abi.functions[3]?.signature, "echo(uint256,uint256,uint256,uint256,uint256,uint256)");
    const target = `0x01${"61".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"62".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const word = (value: bigint) => value.toString(16).padStart(64, "0");
    const call = (state: typeof initial, signature: string, ...values: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${values.map(word).join("")}` as Hex, byteLimit: 100_000 }, context });
    const written = call(initial, "set(uint256,uint256,uint256)", 1n, 2n, 20n);
    assert.equal(written.success, true);
    assert.equal(call(written.state, "read(uint256,uint256)", 1n, 2n).output, `0x${word(20n)}${word(21n)}${word(22n)}`);
    assert.equal(call(written.state, "read(uint256,uint256)", 2n, 0n).success, false);
    assert.equal(call(written.state, "read(uint256,uint256)", 0n, 3n).success, false);
    assert.equal(call(initial, "local(uint256,uint256)", 1n, 2n).output, `0x${word(12n)}${word(6n)}`);
    const words = [1n, 2n, 3n, 4n, 5n, 6n];
    assert.equal(call(initial, "echo(uint256,uint256,uint256,uint256,uint256,uint256)", ...words).output, `0x${words.map(word).join("")}`);
    assert.equal(errorCode("contract Shape { function f(){ uint256[3][2] left; uint256[2][3] right; left = right; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract Shape { function f(){ uint256[3][2] values = [[1,2],[3,4]]; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract Shape { function make() internal view returns(uint256[2][3]) { return [[1,2],[3,4],[5,6]]; } function f(){ uint256[3][2] values = make(); } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("reads, writes and deletes partial multidimensional subarrays", () => {
    const build = compileTinySol(`contract C {
      uint256[3][2] matrix;
      mapping(uint256=>uint256[3][2]) mapped;
      uint256 cursor;
      function setRow(uint256 outer, uint256[3] row) { matrix[outer] = row; mapped[7][outer] = row; }
      function rows(uint256 outer) view returns(uint256[3],uint256[3]) { return matrix[outer], mapped[7][outer]; }
      function sum(uint256[3] row) internal view returns(uint256) { return row[0] + row[1] + row[2]; }
      function sumRow(uint256 outer) view returns(uint256) { return sum(matrix[outer]); }
      function local(uint256 outer) view returns(uint256[3]) {
        uint256[3][2] values = [[1,2,3],[4,5,6]];
        uint256[3] copied = values[outer];
        values[0] = values[1];
        delete values[1];
        return copied;
      }
      function plane() view returns(uint256[2][2]) {
        uint256[2][2][2] cube = [[[1,2],[3,4]],[[5,6],[7,8]]];
        return cube[1];
      }
      function clearRow(uint256 outer) { delete matrix[outer]; }
      function next() internal returns(uint256) { uint256 value = cursor; cursor++; return value; }
      function consume() returns(uint256[3]) { return matrix[next()]; }
      function current() view returns(uint256) { return cursor; }
    }`);
    const target = `0x01${"67".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"68".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const word = (value: bigint) => value.toString(16).padStart(64, "0");
    const call = (state: typeof initial, signature: string, ...items: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${items.map(word).join("")}` as Hex, byteLimit: 100_000 }, context });
    const first = call(initial, "setRow(uint256,uint256,uint256,uint256)", 0n, 10n, 11n, 12n);
    const second = call(first.state, "setRow(uint256,uint256,uint256,uint256)", 1n, 20n, 21n, 22n);
    assert.equal(second.success, true);
    assert.equal(call(second.state, "rows(uint256)", 1n).output, `0x${[20n,21n,22n,20n,21n,22n].map(word).join("")}`);
    assert.equal(call(second.state, "sumRow(uint256)", 0n).output, `0x${word(33n)}`);
    assert.equal(call(second.state, "rows(uint256)", 2n).success, false);
    assert.equal(call(initial, "local(uint256)", 0n).output, `0x${[1n,2n,3n].map(word).join("")}`);
    assert.equal(call(initial, "local(uint256)", 1n).output, `0x${[4n,5n,6n].map(word).join("")}`);
    assert.equal(call(initial, "plane()").output, `0x${[5n,6n,7n,8n].map(word).join("")}`);
    const consumed = call(second.state, "consume()");
    assert.equal(consumed.output, `0x${[10n,11n,12n].map(word).join("")}`);
    assert.equal(call(consumed.state, "current()").output, `0x${word(1n)}`);
    const cleared = call(second.state, "clearRow(uint256)", 1n);
    assert.equal(call(cleared.state, "rows(uint256)", 1n).output, `0x${[0n,0n,0n,20n,21n,22n].map(word).join("")}`);
    assert.equal(errorCode("contract Shape { uint256[3][2] matrix; function f(){ uint256[2] row = matrix[0]; } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("preserves nominal enum checks for direct multidimensional arrays", () => {
    const build = compileTinySol(`contract C {
      enum Status { Empty, Live, Closed }
      struct Grid { Status[3][2] cells; }
      Status[3][2] values;
      mapping(uint256=>Status[2][2]) mapped;
      Grid grid;
      function set(uint256 outer, uint256 inner, Status value) { values[outer][inner] = value; mapped[7][outer][inner] = value; grid.cells[outer][inner] = value; }
      function read(uint256 outer, uint256 inner) view returns(Status,Status,Status) { return values[outer][inner], mapped[7][outer][inner], grid.cells[outer][inner]; }
      function setRow(uint256 outer, Status[3] row) { values[outer] = row; }
      function row(uint256 outer) view returns(Status[3]) { return values[outer]; }
      function local(uint256 outer, uint256 inner) view returns(Status) { Status[3][2] items = [[Status.Empty,Status.Live,Status.Closed],[Status.Closed,Status.Live,Status.Empty]]; return items[outer][inner]; }
      function echo(Status[2][2] items) view returns(Status[2][2]) { return items; }
    }`);
    assert.deepEqual(build.storageLayout.items.map((item) => [item.name, item.type, item.dimensions]), [
      ["values", "uint256[3][2]", [2, 3]],
      ["mapped", "mapping(uint256=>uint256[2][2])", [2, 2]],
      ["grid.cells", "uint256[3][2]", [2, 3]]
    ]);
    const target = `0x01${"63".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"64".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const word = (value: bigint) => value.toString(16).padStart(64, "0");
    const call = (state: typeof initial, signature: string, ...values: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${values.map(word).join("")}` as Hex, byteLimit: 100_000 }, context });
    const written = call(initial, "set(uint256,uint256,uint256)", 1n, 1n, 2n);
    assert.equal(written.success, true);
    assert.equal(call(written.state, "read(uint256,uint256)", 1n, 1n).output, `0x${word(2n)}${word(2n)}${word(2n)}`);
    assert.equal(call(initial, "set(uint256,uint256,uint256)", 0n, 0n, 3n).success, false);
    const rowWritten = call(initial, "setRow(uint256,uint256,uint256,uint256)", 1n, 2n, 1n, 0n);
    assert.equal(call(rowWritten.state, "row(uint256)", 1n).output, `0x${word(2n)}${word(1n)}${word(0n)}`);
    assert.equal(call(initial, "setRow(uint256,uint256,uint256,uint256)", 0n, 0n, 3n, 1n).success, false);
    assert.equal(call(initial, "local(uint256,uint256)", 1n, 0n).output, `0x${word(2n)}`);
    assert.equal(call(initial, "echo(uint256,uint256,uint256,uint256)", 0n, 1n, 2n, 1n).success, true);
    assert.equal(call(initial, "echo(uint256,uint256,uint256,uint256)", 0n, 1n, 3n, 1n).success, false);
    assert.equal(errorCode("contract Shape { enum E { A,B } function f(){ E[3][2] left; E[2][3] right; left = right; } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("executes direct multidimensional struct arrays across storage, mappings, locals and ABI", () => {
    const build = compileTinySol(`contract C {
      struct Pair { uint256 x; bool ok; }
      Pair[2][2] values;
      mapping(uint256=>Pair[2][2]) mapped;
      function fill() { values = [[Pair({x:1,ok:true}),Pair({x:2,ok:false})],[Pair({x:3,ok:true}),Pair({x:4,ok:false})]]; }
      function set(uint256 outer, uint256 inner, Pair value) { values[outer][inner] = value; mapped[7][outer][inner] = value; }
      function read(uint256 outer, uint256 inner) view returns(Pair,Pair) { return values[outer][inner], mapped[7][outer][inner]; }
      function setRow(uint256 outer, Pair[2] row) { values[outer] = row; mapped[7][outer] = row; }
      function row(uint256 outer) view returns(Pair[2],Pair[2]) { return values[outer], mapped[7][outer]; }
      function clearRow(uint256 outer) { delete values[outer]; }
      function clear() { delete values; }
      function local(uint256 outer, uint256 inner) view returns(Pair) {
        Pair[2][2] items = [[Pair({x:5,ok:false}),Pair({x:6,ok:true})],[Pair({x:7,ok:false}),Pair({x:8,ok:true})]];
        return items[outer][inner];
      }
      function localRow(uint256 outer) view returns(Pair[2]) {
        Pair[2][2] items = [[Pair({x:5,ok:false}),Pair({x:6,ok:true})],[Pair({x:7,ok:false}),Pair({x:8,ok:true})]];
        Pair[2] copied = items[outer]; items[0] = items[1]; delete items[1]; return copied;
      }
      function echo(Pair[2][2] items) view returns(Pair[2][2]) { return items; }
      function make() internal view returns(Pair[2][2]) { return [[Pair({x:11,ok:true}),Pair({x:12,ok:false})],[Pair({x:13,ok:true}),Pair({x:14,ok:false})]]; }
      function forward() view returns(Pair[2][2]) { Pair[2][2] items = make(); return items; }
    }`);
    assert.deepEqual(build.storageLayout.items.map((item) => [item.name, item.type, item.length, item.dimensions]), [
      ["values.x", "uint256[2][2]", 4, [2, 2]],
      ["values.ok", "bool[2][2]", 4, [2, 2]],
      ["mapped.x", "mapping(uint256=>uint256[2][2])", 4, [2, 2]],
      ["mapped.ok", "mapping(uint256=>bool[2][2])", 4, [2, 2]]
    ]);
    assert.equal(build.abi.functions.find((fn) => fn.name === "echo")?.signature, "echo(uint256,uint256,uint256,uint256,bool,bool,bool,bool)");
    const target = `0x01${"65".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"66".repeat(20)}` as Bytes32;
    const initial = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const word = (value: bigint) => value.toString(16).padStart(64, "0");
    const call = (state: typeof initial, signature: string, ...items: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${items.map(word).join("")}` as Hex, byteLimit: 100_000 }, context });
    const filled = call(initial, "fill()");
    assert.equal(call(filled.state, "read(uint256,uint256)", 1n, 0n).output, `0x${word(3n)}${word(1n)}${word(0n)}${word(0n)}`);
    const written = call(filled.state, "set(uint256,uint256,uint256,bool)", 1n, 1n, 9n, 1n);
    assert.equal(written.success, true);
    assert.equal(call(written.state, "read(uint256,uint256)", 1n, 1n).output, `0x${word(9n)}${word(1n)}${word(9n)}${word(1n)}`);
    assert.equal(call(written.state, "read(uint256,uint256)", 2n, 0n).success, false);
    assert.equal(call(written.state, "read(uint256,uint256)", 0n, 2n).success, false);
    const rowWritten = call(initial, "setRow(uint256,uint256,uint256,bool,bool)", 1n, 30n, 31n, 1n, 0n);
    assert.equal(call(rowWritten.state, "row(uint256)", 1n).output, `0x${[30n,31n,1n,0n,30n,31n,1n,0n].map(word).join("")}`);
    const rowCleared = call(rowWritten.state, "clearRow(uint256)", 1n);
    assert.equal(call(rowCleared.state, "row(uint256)", 1n).output, `0x${[0n,0n,0n,0n,30n,31n,1n,0n].map(word).join("")}`);
    assert.equal(call(initial, "local(uint256,uint256)", 1n, 1n).output, `0x${word(8n)}${word(1n)}`);
    assert.equal(call(initial, "localRow(uint256)", 1n).output, `0x${[7n,8n,0n,1n].map(word).join("")}`);
    const abiWords = [1n, 2n, 3n, 4n, 1n, 0n, 1n, 0n];
    assert.equal(call(initial, "echo(uint256,uint256,uint256,uint256,bool,bool,bool,bool)", ...abiWords).output, `0x${abiWords.map(word).join("")}`);
    const forwarded = [11n, 12n, 13n, 14n, 1n, 0n, 1n, 0n];
    assert.equal(call(initial, "forward()").output, `0x${forwarded.map(word).join("")}`);
    const cleared = call(written.state, "clear()");
    assert.equal(call(cleared.state, "read(uint256,uint256)", 1n, 1n).output, `0x${word(0n)}${word(0n)}${word(9n)}${word(1n)}`);
    assert.equal(errorCode("contract Shape { struct P { uint256 x; } function f(){ P[3][2] left; P[2][3] right; left = right; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract Shape { struct P { uint256 x; } P[3][2] values; function f(){ P[2] row = values[0]; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract Shape { struct P { uint256 x; } function make() internal view returns(P[2][3]) { P[2][3] x; return x; } function f(){ P[3][2] values = make(); } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract Shape { struct P { uint256 x; } function f(){ P[2][2] values = [[P({x:1})],[P({x:2})]]; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    const composed = compileTinySol("contract Nested { struct Leaf { uint256[3] cells; } struct Book { Leaf[2][2] leaves; } Book book; function set(uint256 a,uint256 b,uint256 c,uint256 value){ book.leaves[a][b].cells[c]=value; } }");
    assert.deepEqual(composed.storageLayout.items.map((item) => [item.name, item.type, item.dimensions]), [["book.leaves.cells", "uint256[3][2][2]", [2, 2, 3]]]);
  });

  it("executes local arrays of structs with atomic whole-array updates", () => {
    const build = compileTinySol(`contract C {
      struct Pair { uint256 x; uint256 y; }
      function work(uint256 index) view returns(uint256,uint256,uint256,uint256) {
        Pair[2] values = [Pair({x:1,y:2}), Pair({x:3,y:4})];
        Pair[2] copied;
        copied = values;
        values = [Pair({x:values[1].y,y:values[0].x}), Pair({x:values[0].y,y:values[1].x})];
        copied[0] = values[1];
        delete copied[1];
        return values[index].x, values[index].y, copied[0].x, copied[0].y;
      }
    }`);
    const target = `0x01${"35".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"36".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const execute = (index: bigint) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("work(uint256)")}${index.toString(16).padStart(64, "0")}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(execute(0n).output, `0x${4n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${2n.toString(16).padStart(64, "0")}${3n.toString(16).padStart(64, "0")}`);
    assert.equal(execute(1n).output, `0x${2n.toString(16).padStart(64, "0")}${3n.toString(16).padStart(64, "0")}${2n.toString(16).padStart(64, "0")}${3n.toString(16).padStart(64, "0")}`);
    assert.equal(execute(2n).success, false);
  });

  it("executes local enum arrays with nominal typing and element guards", () => {
    const build = compileTinySol(`contract C { enum Status { Pending, Active, Closed }
      function work(uint256 index) view returns(Status[3]) {
        Status[3] values = [Status.Pending, Status.Active, Status.Closed];
        Status[3] copied;
        copied = values;
        values = [values[2], values[0], values[1]];
        copied[0] = values[index];
        delete copied[1];
        return values;
      }
    }`);
    assert.deepEqual(build.abi.functions[0]?.outputs, ["uint256", "uint256", "uint256"]);
    const target = `0x01${"37".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"38".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const execute = (index: bigint) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("work(uint256)")}${index.toString(16).padStart(64, "0")}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(execute(1n).output, `0x${2n.toString(16).padStart(64, "0")}${0n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}`);
    assert.equal(execute(3n).success, false);
  });

  it("statically flattens fixed arrays across ABI and external calls", () => {
    const provider = compileTinySol("contract P { function pair(uint256[3] values) view returns(uint256[2]) { return [values[0] + values[1], values[2]]; } }");
    const relay = compileTinySol(`interface P { function pair(uint256[3]) view returns(uint256[2]); }
      contract C { function relay(account target, uint256[3] values) view returns(uint256[2]) { uint256[2] output = staticcall P.pair(target, values); return output; } }`);
    assert.equal(provider.abi.functions[0]?.signature, "pair(uint256,uint256,uint256)");
    assert.deepEqual(provider.abi.functions[0]?.outputs, ["uint256", "uint256"]);
    assert.equal(relay.abi.functions[0]?.signature, "relay(bytes32,uint256,uint256,uint256)");
    const remote = `0x01${"41".repeat(31)}` as Bytes32; const target = `0x01${"42".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"43".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [provider.codeHash]: encodeProgramPackageHex(provider.package), [relay.codeHash]: encodeProgramPackageHex(relay.package) }, programs: { [remote]: { codeHash: provider.codeHash }, [target]: { codeHash: relay.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const payload = `${functionSelector("relay(bytes32,uint256,uint256,uint256)")}${remote.slice(2)}${2n.toString(16).padStart(64, "0")}${3n.toString(16).padStart(64, "0")}${4n.toString(16).padStart(64, "0")}` as Hex;
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 100_000 }, context });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${5n.toString(16).padStart(64, "0")}${4n.toString(16).padStart(64, "0")}`);
  });

  it("flattens arrays of structs field-first across ABI and external calls", () => {
    const provider = compileTinySol(`contract P { struct Pair { uint256 x; bool ok; }
      function turn(Pair[2] values) view returns(Pair[2]) {
        return [Pair({x:values[1].x,ok:values[0].ok}), Pair({x:values[0].x,ok:values[1].ok})];
      }
    }`);
    const relay = compileTinySol(`interface P { function turn(Pair[2]) view returns(Pair[2]); }
      contract C { struct Pair { uint256 x; bool ok; }
        function relay(account target, Pair[2] values) view returns(Pair[2]) { return staticcall P.turn(target, values); }
      }
    `);
    assert.equal(provider.abi.functions[0]?.signature, "turn(uint256,uint256,bool,bool)");
    assert.deepEqual(provider.abi.functions[0]?.outputs, ["uint256", "uint256", "bool", "bool"]);
    assert.equal(relay.abi.functions[0]?.signature, "relay(bytes32,uint256,uint256,bool,bool)");
    const remote = `0x01${"46".repeat(31)}` as Bytes32; const target = `0x01${"47".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"48".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [provider.codeHash]: encodeProgramPackageHex(provider.package), [relay.codeHash]: encodeProgramPackageHex(relay.package) }, programs: { [remote]: { codeHash: provider.codeHash }, [target]: { codeHash: relay.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const payload = `${functionSelector("relay(bytes32,uint256,uint256,bool,bool)")}${remote.slice(2)}${1n.toString(16).padStart(64, "0")}${2n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${0n.toString(16).padStart(64, "0")}` as Hex;
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 100_000 }, context });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${2n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${0n.toString(16).padStart(64, "0")}`);
  });

  it("guards enum arrays across ABI inputs and untrusted external returns", () => {
    const provider = compileTinySol(`contract P { enum Status { Pending, Active, Closed }
      function turn(Status[2] values) view returns(Status[2]) { return [values[1], values[0]]; }
    }`);
    const malicious = compileTinySol("contract P { function turn(uint256[2] values) view returns(uint256[2]) { return [values[0], 7]; } }");
    const relay = compileTinySol(`interface P { function turn(Status[2]) view returns(Status[2]); }
      contract R { enum Status { Pending, Active, Closed }
        function relay(account target, Status[2] values) view returns(Status[2]) { return staticcall P.turn(target, values); }
      }
    `);
    assert.equal(provider.abi.functions[0]?.signature, "turn(uint256,uint256)");
    assert.equal(relay.abi.functions[0]?.signature, "relay(bytes32,uint256,uint256)");
    const remote = `0x01${"4b".repeat(31)}` as Bytes32; const hostile = `0x01${"4c".repeat(31)}` as Bytes32; const target = `0x01${"4d".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"4e".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [provider.codeHash]: encodeProgramPackageHex(provider.package), [malicious.codeHash]: encodeProgramPackageHex(malicious.package), [relay.codeHash]: encodeProgramPackageHex(relay.package) }, programs: { [remote]: { codeHash: provider.codeHash }, [hostile]: { codeHash: malicious.codeHash }, [target]: { codeHash: relay.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const execute = (callee: Bytes32, first: bigint, second: bigint) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("relay(bytes32,uint256,uint256)")}${callee.slice(2)}${first.toString(16).padStart(64, "0")}${second.toString(16).padStart(64, "0")}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(execute(remote, 1n, 2n).output, `0x${2n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}`);
    assert.equal(execute(remote, 1n, 3n).success, false);
    assert.equal(execute(hostile, 1n, 2n).success, false);
  });

  it("directly forwards fixed-array return values", () => {
    const build = compileTinySol(`contract C {
      function make(uint256 value) internal view returns(uint256[2]) { return [value, value + 1]; }
      function relay(uint256 value) view returns(uint256[2]) { return make(value); }
    }`);
    assert.equal(build.abi.functions[0]?.signature, "relay(uint256)");
    assert.deepEqual(build.abi.functions[0]?.outputs, ["uint256", "uint256"]);
    const target = `0x01${"44".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"45".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("relay(uint256)")}${8n.toString(16).padStart(64, "0")}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${8n.toString(16).padStart(64, "0")}${9n.toString(16).padStart(64, "0")}`);
  });

  it("forwards and destructures internal struct-array returns", () => {
    const build = compileTinySol(`contract C { struct Pair { uint256 x; bool ok; }
      function make(uint256 value) internal view returns(Pair[2]) { return [Pair({x:value,ok:true}), Pair({x:value+1,ok:false})]; }
      function both(uint256 value) internal view returns(Pair[2],uint256) { return make(value), 9; }
      function relay(uint256 value) view returns(Pair[2]) { return make(value); }
      function tuple(uint256 value) view returns(Pair[2],uint256) { (Pair[2] values, uint256 tag) = both(value); return values, tag; }
    }`);
    assert.deepEqual(build.abi.functions.map((fn) => [fn.signature, fn.outputs]), [
      ["relay(uint256)", ["uint256", "uint256", "bool", "bool"]],
      ["tuple(uint256)", ["uint256", "uint256", "bool", "bool", "uint256"]]
    ]);
    const target = `0x01${"49".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"4a".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const call = (signature: string) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${7n.toString(16).padStart(64, "0")}` as Hex, byteLimit: 100_000 }, context });
    const aggregate = `${7n.toString(16).padStart(64, "0")}${8n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${0n.toString(16).padStart(64, "0")}`;
    assert.equal(call("relay(uint256)").output, `0x${aggregate}`);
    assert.equal(call("tuple(uint256)").output, `0x${aggregate}${9n.toString(16).padStart(64, "0")}`);
  });

  it("forwards and destructures internal enum-array returns", () => {
    const build = compileTinySol(`contract C { enum Status { Pending, Active }
      function make() internal view returns(Status[2],uint256) { return [Status.Pending,Status.Active], 7; }
      function read() view returns(Status[2],uint256) { (Status[2] values, uint256 tag) = make(); return values, tag; }
    }`);
    const target = `0x01${"4f".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"50".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("read()"), byteLimit: 100_000 }, context: { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } } });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${0n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${7n.toString(16).padStart(64, "0")}`);
  });

  it("rejects malformed, mismatched or over-budget fixed arrays", () => {
    assert.equal(errorCode("contract C { uint256[0] a; }"), ToolchainErrorCode.ARRAY_LENGTH_INVALID);
    assert.equal(errorCode("contract C { function f(){ uint256[2] values = [1]; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { function f() view returns(uint256){ uint256[2] values; return values; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { function f() view returns(uint256){ uint256[2] values; return values[2]; } }"), ToolchainErrorCode.ARRAY_BOUNDS);
    assert.equal(errorCode("contract C { enum S { A } enum T { A } function f(){ S[2] left = [S.A,S.A]; T[2] right = [T.A,T.A]; left = right; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { enum S { A } function f(){ S[2] values = [S.A,0]; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { struct P { uint256 value; } function f(){ P[2] left; P[3] right; left = right; } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { function f(uint256[33] values){} }"), ToolchainErrorCode.RESOURCE_LIMIT);
  });

  it("encodes named errors with deterministic typed selectors", () => {
    const source = "contract C { error Unauthorized(account actor,uint256 role); function fail(uint256 role){ revert Unauthorized(msg.sender, role); } }";
    const build = compileTinySol(source);
    const descriptor = build.abi.errors?.[0];
    assert.equal(descriptor?.signature, "Unauthorized(bytes32,uint256)");
    assert.equal(descriptor?.selector, functionSelector("Unauthorized(bytes32,uint256)"));
    const target = `0x01${"55".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"66".repeat(20)}` as Bytes32;
    const payload = `${functionSelector("fail(uint256)")}${7n.toString(16).padStart(64, "0")}` as Hex;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 100_000 }, context: { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } } });
    assert.equal(result.success, false);
    assert.equal(result.revertData, `${descriptor?.selector}${actor.slice(2)}${7n.toString(16).padStart(64, "0")}`);
    assert.deepEqual(result.storageDiff, []);
    assert.equal(errorCode("contract C { error E(bool ok); function f(){ revert E(1); } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("executes compound assignments, postfix updates, delete and ternary expressions", () => {
    const source = `contract C {
      uint256 total;
      mapping(uint256 => uint256) values;
      function mutate(uint256 index, uint256 amount, bool choose) returns(uint256,uint256) {
        total += amount;
        values[index] += amount;
        for (uint256 i = 0; i < 2; i++) { total++; }
        values[index]--;
        uint256 picked = choose ? total : values[index];
        delete values[index];
        return picked, total;
      }
      function local(uint256 value) view returns(uint256) { value *= 4; value >>= 1; value++; return value; }
    }`;
    const build = compileTinySol(source, { includeSyntax: true });
    assert.equal(build.ast?.contract.functions[0]?.body.statements[0]?.kind, "Assignment");
    assert.equal(build.ast?.contract.functions[0]?.body.statements[0]?.kind === "Assignment" ? build.ast.contract.functions[0].body.statements[0].operator : undefined, "+=");
    const target = `0x01${"55".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"66".repeat(20)}` as Bytes32;
    const call = `${functionSelector("mutate(uint256,uint256,bool)")}${3n.toString(16).padStart(64, "0")}${5n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}` as Hex;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: call, byteLimit: 100_000 }, context });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${7n.toString(16).padStart(64, "0")}${7n.toString(16).padStart(64, "0")}`);
    assert.equal(result.storageDiff.some((item) => item.value === `0x${7n.toString(16).padStart(64, "0")}`), true);
    assert.equal(result.storageDiff.some((item) => item.value === `0x${"0".repeat(64)}`), true);
  });

  it("lowers compound member writes and whole-struct delete", () => {
    const build = compileTinySol("contract C { struct P { uint256 amount; bool active; } P value; function update(){ value.amount += 2; delete value; } }");
    assert.deepEqual(build.storageLayout.items.map((item) => item.name), ["value.amount", "value.active"]);
    assert.match(build.assembly, /SLOAD/);
    assert.equal(errorCode("contract C { bool ok; function f(){ ok += true; } }"), ToolchainErrorCode.INVALID_OPERATION);
    assert.equal(errorCode("contract C { uint256 value; function f() view { delete value; } }"), ToolchainErrorCode.STATIC_VIOLATION);
    assert.equal(errorCode("contract C { function f(bool yes) view returns(uint256){ return yes ? 1 : false; } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("destructures scalar multi-return calls into new or existing bindings", () => {
    const source = `contract C {
      uint256 storedA;
      uint256 storedB;
      function pair(uint256 value) internal view returns(uint256,uint256) { return value, value + 1; }
      function read(uint256 value) view returns(uint256,uint256) {
        (uint256 a, uint256 b) = pair(value);
        return a, b;
      }
      function store(uint256 value) {
        (storedA, storedB) = pair(value);
      }
    }`;
    const build = compileTinySol(source, { includeSyntax: true });
    assert.equal(build.ast?.contract.functions[1]?.body.statements[0]?.kind, "TupleAssignment");
    const target = `0x01${"77".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"88".repeat(20)}` as Bytes32;
    const payload = `${functionSelector("read(uint256)")}${5n.toString(16).padStart(64, "0")}` as Hex;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 100_000 }, context });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${5n.toString(16).padStart(64, "0")}${6n.toString(16).padStart(64, "0")}`);
  });

  it("destructures fixed arrays inside mixed tuples", () => {
    const build = compileTinySol(`contract C {
      function make(uint256 value) internal view returns(uint256[2],uint256,bool[2][2]) {
        return [value,value + 1], value + 2, [[true,false],[false,true]];
      }
      function read(uint256 value) view returns(uint256,uint256,uint256,bool,bool,bool,bool) {
        (uint256[2] pair, uint256 tag, bool[2][2] flags) = make(value);
        (pair, tag, flags) = make(value + 10);
        return pair[0], pair[1], tag, flags[0][0], flags[0][1], flags[1][0], flags[1][1];
      }
    }`);
    const target = `0x01${"89".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"8a".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const payload = `${functionSelector("read(uint256)")}${5n.toString(16).padStart(64, "0")}` as Hex;
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 100_000 }, context });
    const words = [15n, 16n, 17n, 1n, 0n, 0n, 1n];
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${words.map((value) => value.toString(16).padStart(64, "0")).join("")}`);
    assert.equal(errorCode("contract Shape { function make() internal view returns(uint256[3],uint256){ return [1,2,3],4; } function f(){ (uint256[2] values,uint256 tag)=make(); } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("supports external multi-return destructuring and rejects unsafe tuple bindings", () => {
    const source = `interface Pair { function read() view returns(uint256,bool); }
      contract C { function relay(account target) view returns(uint256,bool) { (uint256 value, bool ok) = staticcall Pair.read(target); return value, ok; } }`;
    const build = compileTinySol(source); const provider = compileTinySol("contract PairImpl { function read() view returns(uint256,bool) { return 9, true; } }");
    assert.deepEqual(build.abi.functions[0]?.outputs, ["uint256", "bool"]);
    const relay = `0x01${"99".repeat(31)}` as Bytes32; const remote = `0x01${"aa".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"bb".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package), [provider.codeHash]: encodeProgramPackageHex(provider.package) }, programs: { [relay]: { codeHash: build.codeHash }, [remote]: { codeHash: provider.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const payload = `${functionSelector("relay(bytes32)")}${remote.slice(2)}` as Hex; const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: relay, payload, byteLimit: 100_000 }, context });
    assert.equal(result.success, true); assert.equal(result.output, `0x${9n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}`);
    assert.equal(errorCode("contract C { function pair() internal view returns(uint256,uint256){ return 1,2; } function f(){ (uint256 a) = pair(); } }"), ToolchainErrorCode.PARSE_EXPECTED_TOKEN);
    assert.equal(errorCode("contract C { function pair() internal view returns(uint256,uint256){ return 1,2; } function f(){ (uint256 a, uint256 a) = pair(); } }"), ToolchainErrorCode.DUPLICATE_DECLARATION);
    assert.equal(errorCode("contract C { function pair() internal view returns(uint256,bool){ return 1,true; } function f(){ (uint256 a, uint256 b) = pair(); } }"), ToolchainErrorCode.TYPE_MISMATCH);
    assert.equal(errorCode("contract C { function pair() internal view returns(uint256,uint256){ return 1,2; } function f(){ (uint256[2] a, uint256 b) = pair(); } }"), ToolchainErrorCode.TYPE_MISMATCH);
  });

  it("executes break and continue with the nearest loop target", () => {
    const build = compileTinySol(`contract C {
      function run(uint256 stop) view returns(uint256,uint256,uint256) {
        uint256 sum = 0;
        uint256 seen = 0;
        for (uint256 i = 0; i < 10; i++) {
          if (i == 2) { continue; }
          if (i == stop) { break; }
          sum += i;
          seen++;
        }
        uint256 j = 0;
        while (j < 5) {
          j++;
          if (j < 3) { continue; }
          if (j == 5) { break; }
          sum += j;
        }
        uint256 nested = 0;
        for (uint256 x = 0; x < 3; x++) {
          for (uint256 y = 0; y < 4; y++) {
            if (y == 1) { continue; }
            if (y == 3) { break; }
            nested++;
          }
        }
        return sum, seen, nested;
      }
    }`);
    const target = `0x01${"bc".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"bd".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const payload = `${functionSelector("run(uint256)")}${7n.toString(16).padStart(64, "0")}` as Hex;
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 100_000 }, context });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${[26n, 6n, 6n].map((value) => value.toString(16).padStart(64, "0")).join("")}`);
    assert.equal(errorCode("contract C { function f(){ break; } }"), ToolchainErrorCode.INVALID_OPERATION);
    assert.equal(errorCode("contract C { function f(){ continue; } }"), ToolchainErrorCode.INVALID_OPERATION);
  });

  it("supports fixed scalar and struct arrays in for initializers", () => {
    const build = compileTinySol(`contract C {
      struct Pair { uint256 x; uint256 y; }
      function run() view returns(uint256,uint256) {
        uint256 sum = 0;
        for (uint256[2] values = [0,4]; values[0] < 3; values[0]++) {
          if (values[0] == 1) { continue; }
          sum += values[1];
        }
        uint256 picked = 0;
        for (Pair[2] pairs = [Pair({x:1,y:2}),Pair({x:3,y:5})]; pairs[0].x < 2; pairs[0].x++) {
          picked = pairs[1].y;
        }
        return sum, picked;
      }
    }`);
    const target = `0x01${"be".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"bf".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const result = simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: functionSelector("run()"), byteLimit: 100_000 }, context });
    assert.equal(result.success, true);
    assert.equal(result.output, `0x${8n.toString(16).padStart(64, "0")}${5n.toString(16).padStart(64, "0")}`);
  });

  it("executes bounded vectors, bytes and strings across storage, mappings and structs", () => {
    const build = compileTinySol(`contract C {
      uint256[<=4] values;
      string<8> text;
      mapping(uint256 => bytes<4>) blobs;
      struct Record { string<4> name; uint256[<=3] nums; }
      Record record;
      function set() { values.push(3); values[2] = 9; text = "hi"; blobs[1] = "ab"; blobs[1].push(99); record.name = "xy"; record.nums.push(7); }
      function at(uint256 index) view returns(uint256) { return values[index]; }
      function get() view returns(uint256[<=4],string<8>,bytes<4>,string<4>,uint256[<=3]) { return values,text,blobs[1],record.name,record.nums; }
      function local() view returns(uint256,uint256) { bytes<4> data = "ab"; data.pop(); data.push(99); return data.length,data[1]; }
    }`);
    assert.deepEqual(build.storageLayout.items.map((item) => item.name), ["values$length", "values$data", "text$length", "text$data", "blobs$length", "blobs$data", "record.name$length", "record.name$data", "record.nums$length", "record.nums$data"]);
    const target = `0x01${"c1".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"c2".repeat(20)}` as Bytes32;
    let state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const execute = (signature: string, ...values: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector(signature)}${values.map((value) => value.toString(16).padStart(64, "0")).join("")}` as Hex, byteLimit: 1_000_000 }, context });
    const set = execute("set()"); assert.equal(set.success, true); state = set.state;
    const expected = [3n,3n,0n,9n,0n, 2n,104n,105n,0n,0n,0n,0n,0n,0n, 3n,97n,98n,99n,0n, 2n,120n,121n,0n,0n, 1n,7n,0n,0n];
    assert.equal(execute("get()").output, `0x${expected.map((value) => value.toString(16).padStart(64, "0")).join("")}`);
    assert.equal(execute("at(uint256)", 1n).output, `0x${"0".repeat(64)}`);
    assert.equal(execute("at(uint256)", 3n).success, false);
    assert.equal(execute("local()").output, `0x${2n.toString(16).padStart(64, "0")}${99n.toString(16).padStart(64, "0")}`);
    assert.equal(errorCode("contract C { string<2> value; function f(){ value = \"three\"; } }"), ToolchainErrorCode.ARRAY_LENGTH_INVALID);
  });

  it("uses bounded static ABI words and rejects invalid string tails", () => {
    const build = compileTinySol("contract C { function echo(string<4> value) view returns(string<4>) { return value; } }");
    assert.equal(build.abi.functions[0]?.signature, "echo(uint256,uint8,uint8,uint8,uint8)");
    const target = `0x01${"c3".repeat(31)}` as Bytes32; const actor = `0x${"00".repeat(12)}${"c4".repeat(20)}` as Bytes32;
    const state = { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) }, programs: { [target]: { codeHash: build.codeHash } } };
    const context = { worldId: actor, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
    const call = (...values: bigint[]) => simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: `${functionSelector("echo(uint256,uint8,uint8,uint8,uint8)")}${values.map((value) => value.toString(16).padStart(64, "0")).join("")}` as Hex, byteLimit: 100_000 }, context });
    assert.equal(call(2n,104n,105n,0n,0n).success, true);
    assert.equal(call(5n,104n,105n,0n,0n).success, false);
    assert.equal(call(1n,104n,9n,0n,0n).success, false);
  });

  it("supports storage-only mapping fields inside nested structs", () => {
    const build = compileTinySol(`contract C { struct Ledger { mapping(uint256=>uint256) values; uint256 total; } struct State { Ledger ledger; } State data;
      function set(uint256 key,uint256 value){ data.ledger.values[key]=value; data.ledger.total+=value; }
      function get(uint256 key) view returns(uint256,uint256){ return data.ledger.values[key],data.ledger.total; } }`);
    assert.deepEqual(build.storageLayout.items.map((item) => item.name), ["data.ledger.total", "data.ledger.values"]);
    assert.equal(errorCode("contract C { struct S { mapping(uint256=>uint256) values; } function bad(S value){} }"), ToolchainErrorCode.UNSUPPORTED_FEATURE);
  });
});
