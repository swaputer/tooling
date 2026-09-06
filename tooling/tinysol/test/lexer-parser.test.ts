import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolchainErrorCode, isToolchainError } from "../src/errors.js";
import { lexTinySol } from "../src/lexer.js";
import { parseTinySol } from "../src/parser.js";

function code(action: () => unknown): string {
  try { action(); return "NO_ERROR"; } catch (error) { return isToolchainError(error) ? error.code : "UNKNOWN"; }
}
function withoutSpans(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSpans);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "span").map(([key, item]) => [key, withoutSpans(item)]));
  return value;
}

describe("TinySol lexer and parser", () => {
  it("lexes every literal/operator/comment family with byte spans", () => {
    const tokens = lexTinySol("// x\ncontract C { /* y */ bytes32 x; address a; function f(uint256 n) view returns (bool) { return n >= 0 && true; } }");
    assert.equal(tokens.at(-1)?.kind, "eof");
    assert.ok(tokens.some((token) => token.value === ">="));
    assert.ok(tokens.some((token) => token.value === "&&"));
    assert.equal(tokens.find((token) => token.value === "contract")?.span.start.line, 2);
  });

  it("normalizes CRLF and LF to the same syntax tree apart from source positions", () => {
    const lf = "contract C { function f() view returns (uint256) { return 1; } }\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    assert.deepEqual(withoutSpans(parseTinySol(lf)), withoutSpans(parseTinySol(crlf)));
  });

  it("parses precedence left-associatively", () => {
    const program = parseTinySol("contract C { function f(uint256 a) view returns (uint256) { return a + 2 * 3 - 4; } }");
    const statement = program.contract.functions[0]?.body.statements[0];
    assert.equal(statement?.kind, "ReturnStatement");
    if (statement?.kind !== "ReturnStatement") return;
    assert.equal(statement.values[0]?.kind, "BinaryExpression");
    assert.equal(statement.values[0]?.kind === "BinaryExpression" ? statement.values[0].operator : "", "-");
  });

  it("parses mappings, events, loops, calls and create", () => {
    const source = `interface I { constructor(uint256); function read() view returns (uint256); }
      contract C { event E(account indexed a,uint256 v); mapping(account=>uint256) m;
      function f(account a,bytes32 h) returns(account) { for(uint256 i=0;i<1;i=i+1){m[a]=i;} emit E(a,m[a]); return create I(h,1); } }`;
    const program = parseTinySol(source);
    assert.equal(program.interfaces.length, 1);
    assert.equal(program.contract.events.length, 1);
    assert.equal(program.contract.functions[0]?.body.statements[0]?.kind, "ForStatement");
  });

  it("rejects unterminated comments, non-ASCII identifiers and control characters", () => {
    assert.equal(code(() => lexTinySol("contract C { /*")), ToolchainErrorCode.UNTERMINATED_COMMENT);
    assert.equal(code(() => lexTinySol("contract Ｃ {}")), ToolchainErrorCode.NON_ASCII_IDENTIFIER);
    assert.equal(code(() => lexTinySol("contract C {\u0001}")), ToolchainErrorCode.INVALID_SOURCE_CHARACTER);
  });

  it("reports a stable parser code and exact location", () => {
    try { parseTinySol("contract C { function f( }"); assert.fail("expected parse error"); }
    catch (error) {
      assert.ok(isToolchainError(error));
      assert.equal(error.code, ToolchainErrorCode.PARSE_EXPECTED_TOKEN);
      assert.equal(error.line, 1);
      assert.ok((error.column ?? 0) > 1);
    }
  });

  it("enforces source and literal limits", () => {
    assert.equal(code(() => lexTinySol(" ".repeat(262_145))), ToolchainErrorCode.SOURCE_LIMIT);
    const tooLarge = (1n << 256n).toString();
    assert.equal(code(() => parseTinySol(`contract C { function f() view returns(uint256){ return ${tooLarge}; } }`)), "NO_ERROR");
  });
});
