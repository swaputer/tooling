import { ReceiptErrorCode, VMReceiptError } from "./errors.js";

export type Hex = `0x${string}`;
export type Bytes32 = `0x${string}`;
export type ReceiptInput = Uint8Array | Hex;

export function bytesToHex(bytes: Uint8Array): Hex {
  let value = "0x";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value as Hex;
}

export function hexToBytes(value: Hex): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new VMReceiptError(ReceiptErrorCode.INVALID_HEX);
  }
  const result = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return result;
}

export function inputToBytes(input: ReceiptInput): Uint8Array {
  if (typeof input === "string") return hexToBytes(input);
  if (!(input instanceof Uint8Array)) {
    throw new VMReceiptError(ReceiptErrorCode.INVALID_INPUT);
  }
  return new Uint8Array(input);
}

export function assertBytes32(value: string, field: string): asserts value is Bytes32 {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new VMReceiptError(ReceiptErrorCode.INVALID_BYTES32, { details: { field } });
  }
}
