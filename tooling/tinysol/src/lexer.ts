import { ToolchainErrorCode, fail } from "./errors.js";
import { TINYSOL_LIMITS, type SourcePosition, type SourceSpan, type TinySolToken, type TinySolTokenKind } from "./compiler-types.js";

const KEYWORDS = new Set([
  "contract", "interface", "constructor", "function", "event", "indexed", "returns", "view", "external", "internal", "mapping",
  "uint256", "int256", "bool", "account", "address", "bytes32", "if", "else", "while", "for", "return",
  "require", "revert", "emit", "true", "false", "call", "staticcall", "create"
]);
const TWO = new Set(["=>", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>"]);
const ONE_OPERATORS = new Set(["=", "+", "-", "*", "/", "%", "<", ">", "!", "~", "&", "|", "^"]);
const PUNCTUATION = new Set(["{", "}", "(", ")", "[", "]", ";", ",", "."]);

function position(offset: number, byteOffset: number, line: number, column: number): SourcePosition {
  return Object.freeze({ offset, byteOffset, line, column });
}

export function lexTinySol(source: string): readonly TinySolToken[] {
  if (typeof source !== "string") fail(ToolchainErrorCode.INVALID_INPUT);
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > TINYSOL_LIMITS.sourceBytes) fail(ToolchainErrorCode.SOURCE_LIMIT, { details: { actual: sourceBytes, maximum: TINYSOL_LIMITS.sourceBytes } });
  const tokens: TinySolToken[] = [];
  let offset = 0;
  let byteOffset = 0;
  let line = 1;
  let column = 1;

  const current = (): SourcePosition => position(offset, byteOffset, line, column);
  const advance = (): string => {
    const char = source[offset] ?? "";
    offset += char.length;
    byteOffset += Buffer.byteLength(char, "utf8");
    if (char === "\n") { line += 1; column = 1; } else { column += 1; }
    return char;
  };
  const add = (kind: TinySolTokenKind, value: string, start: SourcePosition): void => {
    tokens.push(Object.freeze({ kind, value, span: Object.freeze({ start, end: current() }) }));
    if (tokens.length > TINYSOL_LIMITS.tokens) fail(ToolchainErrorCode.TOKEN_LIMIT, { line: start.line, column: start.column, details: { maximum: TINYSOL_LIMITS.tokens } });
  };

  while (offset < source.length) {
    const char = source[offset] ?? "";
    if (char === "\r") {
      if (source[offset + 1] === "\n") { offset += 2; byteOffset += 2; } else { offset += 1; byteOffset += 1; }
      line += 1; column = 1; continue;
    }
    if (char === "\n" || char === " " || char === "\t") { advance(); continue; }
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) {
      fail(ToolchainErrorCode.INVALID_SOURCE_CHARACTER, { line, column, details: { codePoint: code } });
    }
    if (char === "/" && source[offset + 1] === "/") {
      advance(); advance(); while (offset < source.length && source[offset] !== "\n" && source[offset] !== "\r") advance(); continue;
    }
    if (char === "/" && source[offset + 1] === "*") {
      const start = current(); advance(); advance(); let closed = false;
      while (offset < source.length) {
        if (source[offset] === "*" && source[offset + 1] === "/") { advance(); advance(); closed = true; break; }
        if (source[offset] === "\r") {
          if (source[offset + 1] === "\n") { offset += 2; byteOffset += 2; } else { offset += 1; byteOffset += 1; }
          line += 1; column = 1;
        } else advance();
      }
      if (!closed) fail(ToolchainErrorCode.UNTERMINATED_COMMENT, { line: start.line, column: start.column, offset: start.byteOffset });
      continue;
    }
    const start = current();
    if (/[A-Za-z_]/.test(char)) {
      let value = ""; while (offset < source.length && /[A-Za-z0-9_]/.test(source[offset] ?? "")) value += advance();
      add(KEYWORDS.has(value) ? "keyword" : "identifier", value, start); continue;
    }
    if (/[0-9]/.test(char)) {
      let value = "";
      if (char === "0" && (source[offset + 1] === "x" || source[offset + 1] === "X")) {
        value += advance(); value += advance();
        while (offset < source.length && /[0-9a-fA-F]/.test(source[offset] ?? "")) value += advance();
        if (value.length === 2) fail(ToolchainErrorCode.INVALID_LITERAL, { line, column });
        const digits = value.length - 2;
        add(digits === 64 ? "bytes32" : digits === 40 ? "address" : "integer", value.toLowerCase(), start);
      } else {
        while (offset < source.length && /[0-9]/.test(source[offset] ?? "")) value += advance();
        add("integer", value, start);
      }
      continue;
    }
    if (code > 0x7f) fail(ToolchainErrorCode.NON_ASCII_IDENTIFIER, { line, column, offset: byteOffset, details: { codePoint: code } });
    const pair = source.slice(offset, offset + 2);
    if (TWO.has(pair)) { advance(); advance(); add("operator", pair, start); continue; }
    if (ONE_OPERATORS.has(char)) { advance(); add("operator", char, start); continue; }
    if (PUNCTUATION.has(char)) { advance(); add("punctuation", char, start); continue; }
    fail(ToolchainErrorCode.INVALID_SOURCE_CHARACTER, { line, column, offset: byteOffset, details: { codePoint: code } });
  }
  const end = current();
  tokens.push(Object.freeze({ kind: "eof", value: "", span: Object.freeze({ start: end, end }) }));
  return Object.freeze(tokens);
}

export function mergeSpans(start: SourceSpan | TinySolToken, end: SourceSpan | TinySolToken): SourceSpan {
  const left = "span" in start ? start.span : start;
  const right = "span" in end ? end.span : end;
  return Object.freeze({ start: left.start, end: right.end });
}
