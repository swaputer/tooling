import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ts from "typescript";
import { compileTinySol } from "../src/codegen.js";
import { formatTinySol } from "../src/formatter.js";
import { generateTypeScriptBindings } from "../src/bindings.js";

describe("frontend bindings and formatter", () => {
  it("generates deterministic framework-neutral call, read, event and error helpers", () => {
    const build = compileTinySol("contract C { error Bad(uint256 value); event Set(uint256 indexed value); function get() view returns(uint256){ return 1; } function set(uint256 value) returns(bool){ emit Set(value); return true; } }");
    const first = generateTypeScriptBindings(build.abi, build.eventDescriptor); const second = generateTypeScriptBindings(build.abi, build.eventDescriptor);
    assert.equal(first, second); assert.match(first, /encodeGet/); assert.match(first, /readGet/); assert.match(first, /callSet/); assert.match(first, /decodeSetEvent/); assert.match(first, /errorSelectors/); assert.match(first, /decodeBadError/);
    const transpiled = ts.transpileModule(first, { compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
    assert.equal(transpiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  });

  it("emits bigint bindings and range guards for narrow integers", () => {
    const build = compileTinySol("contract C { function narrow(uint8 value) view returns(int24){ return int24(value); } }");
    const bindings = generateTypeScriptBindings(build.abi);
    assert.match(bindings, /type NarrowArgs = readonly \[bigint\]/);
    assert.match(bindings, /type NarrowResult = bigint/);
    assert.match(bindings, /TINYSOL_BINDING_RANGE/);
    assert.match(bindings, /decodeInt\(values\[0\]!, 24\)/);
    const transpiled = ts.transpileModule(bindings, { compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
    assert.equal(transpiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  });

  it("formats every extension syntax without changing compiled artifacts", () => {
    const source = "contract C {  enum S { A, B } struct P { uint256 x; S s; } error Bad(P p); P[2] values; function pair(uint256 x) internal view returns(uint256,uint256){ return x,x+1; } function set(uint256 i,P p){ values[i]=p; uint256 n=true?1:2; n++; n+=1; (uint256 a,uint256 b)=pair(n); delete values[i]; } }   \r\n";
    const formatted = formatTinySol(source); assert.equal(formatTinySol(formatted), formatted); assert.equal(formatted.endsWith("\n"), true);
    assert.deepEqual(compileTinySol(formatted).packageBytes, compileTinySol(source).packageBytes);
  });
});
