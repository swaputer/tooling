import { ToolchainErrorCode, fail } from "./errors.js";

export type Hex = `0x${string}`;
export type Bytes4 = `0x${string}`;
export type Bytes32 = `0x${string}`;
export type BinaryInput = Uint8Array | Hex;

export function bytesToHex(bytes: Uint8Array): Hex {
  let value = "0x";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value as Hex;
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) fail(ToolchainErrorCode.INVALID_HEX);
  const output = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return output;
}

export function inputToBytes(input: BinaryInput): Uint8Array {
  if (typeof input === "string") return hexToBytes(input);
  if (!(input instanceof Uint8Array)) fail(ToolchainErrorCode.INVALID_INPUT);
  return new Uint8Array(input);
}

export function normalizeBytes32(value: string, code = ToolchainErrorCode.INVALID_ABI_HASH): Bytes32 {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) fail(code);
  return value.toLowerCase() as Bytes32;
}

export function concatBytes(...items: readonly Uint8Array[]): Uint8Array {
  const size = items.reduce((sum, item) => sum + item.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const item of items) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

export function writeU16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) fail(ToolchainErrorCode.INVALID_INPUT);
  return Uint8Array.of(value >>> 8, value & 0xff);
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}
