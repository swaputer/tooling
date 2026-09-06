import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, type Bytes4, type Bytes32 } from "./bytes.js";
import { ToolchainErrorCode, fail } from "./errors.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CANONICAL_TYPES = /^(?:uint(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)|int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)|bool|address|bytes(?:[1-9]|[12][0-9]|3[0-2])|bytes|string)$/;

export interface ParsedSignature {
  readonly name: string;
  readonly parameterTypes: readonly string[];
  readonly canonical: string;
}

function hashUtf8(value: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(value));
}

export function parseCanonicalSignature(signature: string): ParsedSignature {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(signature);
  if (match === null || !IDENTIFIER.test(match[1] ?? "")) fail(ToolchainErrorCode.INVALID_SIGNATURE);
  const parameters = match[2] === "" ? [] : (match[2]?.split(",") ?? []);
  if (parameters.some((type) => !CANONICAL_TYPES.test(type))) {
    fail(ToolchainErrorCode.INVALID_SIGNATURE, { details: { signature } });
  }
  return Object.freeze({ name: match[1] ?? "", parameterTypes: Object.freeze(parameters), canonical: signature });
}

export function validateFunctionSignature(signature: string): ParsedSignature {
  return parseCanonicalSignature(signature);
}

export function validateEventSignature(signature: string): ParsedSignature {
  return parseCanonicalSignature(signature);
}

export function functionSelector(signature: string): Bytes4 {
  validateFunctionSignature(signature);
  return bytesToHex(hashUtf8(signature).slice(0, 4)) as Bytes4;
}

export function eventTopic(signature: string): Bytes32 {
  validateEventSignature(signature);
  return bytesToHex(hashUtf8(signature)) as Bytes32;
}

export function interfaceId(signatures: readonly string[]): Bytes4 {
  let result = 0;
  for (const signature of signatures) result ^= Number.parseInt(functionSelector(signature).slice(2), 16);
  return `0x${(result >>> 0).toString(16).padStart(8, "0")}` as Bytes4;
}

export function exactUtf8AbiHash(canonical: string): Bytes32 {
  return bytesToHex(hashUtf8(canonical)) as Bytes32;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint" || value === undefined || typeof value === "function" || typeof value === "symbol") {
      fail(ToolchainErrorCode.INVALID_INPUT);
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(ToolchainErrorCode.INVALID_INPUT);
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}

export function canonicalAbiJson(value: unknown): string {
  return canonicalJson(value);
}
