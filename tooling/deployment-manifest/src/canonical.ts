import { keccak_256 } from "@noble/hashes/sha3";
import { ManifestError } from "./errors.js";
import type { Bytes32 } from "./types.js";

function normalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new ManifestError("INVALID_INTEGER", path, "canonical JSON numbers must be safe integers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value !== "object") throw new ManifestError("INVALID_TYPE", path, "unsupported canonical JSON value");
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const item = input[key];
    if (item === undefined) throw new ManifestError("INVALID_TYPE", `${path}.${key}`, "undefined is forbidden");
    output[key] = normalize(item, `${path}.${key}`);
  }
  return output;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

/** Parse JSON without the duplicate-name ambiguity of JSON.parse. Keys are
 * compared after escape decoding, so `"x"` and `"\u0078"` are duplicates. */
export function parseStrictJson(source: string): unknown {
  let offset = 0;
  const fail = (message: string): never => {
    throw new ManifestError("INVALID_JSON", `$@${offset}`, message);
  };
  const space = (): void => { while (/\s/u.test(source[offset] ?? "")) offset += 1; };
  const stringValue = (): string => {
    if (source[offset] !== '"') fail("expected JSON string");
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') {
        try { return JSON.parse(source.slice(start, offset)) as string; }
        catch { fail("invalid JSON string escape"); }
      }
      if (char === "\\") offset += 1;
      else if (char !== undefined && char.charCodeAt(0) < 0x20) fail("unescaped control character");
    }
    return fail("unterminated JSON string");
  };
  const value = (): unknown => {
    space();
    const char = source[offset];
    if (char === '"') return stringValue();
    if (char === "{") {
      offset += 1; space();
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (source[offset] === "}") { offset += 1; return result; }
      while (true) {
        space(); const key = stringValue(); space();
        if (keys.has(key)) fail(`duplicate object member ${JSON.stringify(key)}`);
        keys.add(key);
        if (source[offset++] !== ":") fail("expected colon");
        result[key] = value(); space();
        const separator = source[offset++];
        if (separator === "}") return result;
        if (separator !== ",") fail("expected comma or object close");
      }
    }
    if (char === "[") {
      offset += 1; space();
      const result: unknown[] = [];
      if (source[offset] === "]") { offset += 1; return result; }
      while (true) {
        result.push(value()); space();
        const separator = source[offset++];
        if (separator === "]") return result;
        if (separator !== ",") fail("expected comma or array close");
      }
    }
    for (const [literal, decoded] of [["true", true], ["false", false], ["null", null]] as const) {
      if (source.startsWith(literal, offset)) { offset += literal.length; return decoded; }
    }
    const match = source.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (match === null) return fail("invalid JSON value");
    offset += match[0].length;
    const decoded = Number(match[0]);
    if (!Number.isFinite(decoded)) fail("non-finite JSON number");
    return decoded;
  };
  const decoded = value(); space();
  if (offset !== source.length) fail("trailing JSON bytes");
  return decoded;
}

export function keccakHex(bytes: Uint8Array): Bytes32 {
  return `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`;
}

export function keccakUtf8(value: string): Bytes32 {
  return keccakHex(new TextEncoder().encode(value));
}
