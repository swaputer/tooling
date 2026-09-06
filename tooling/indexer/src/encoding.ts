import type { Address, Bytes32, Hex } from "./types.js";
import { IndexerError, IndexerErrorCode, type IndexerErrorCode as IndexerErrorCodeType } from "./errors.js";

export function normalizeAddress(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new IndexerError(IndexerErrorCode.INVALID_ADDRESS, "EVENTS", { details: { value } });
  }
  return value.toLowerCase() as Address;
}

export function normalizeBytes32(
  value: string,
  code: IndexerErrorCodeType = IndexerErrorCode.INVALID_BYTES32
): Bytes32 {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new IndexerError(code, "EVENTS");
  }
  return value.toLowerCase() as Bytes32;
}

export function normalizeDataHex(value: string): Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new IndexerError(IndexerErrorCode.OUTER_DATA_HEX, "EVENTS");
  }
  return value.toLowerCase() as Hex;
}

export function parseQuantity(value: string): bigint {
  if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new IndexerError(IndexerErrorCode.INVALID_QUANTITY, "RPC");
  }
  return BigInt(value);
}

export function toQuantity(value: bigint): Hex {
  if (value < 0n) throw new IndexerError(IndexerErrorCode.INVALID_QUANTITY, "RPC");
  return `0x${value.toString(16)}`;
}

export function decimal(value: bigint): string {
  if (value < 0n) throw new IndexerError(IndexerErrorCode.INVALID_QUANTITY, "INTEGRITY");
  return value.toString(10);
}

export function parseDecimal(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new IndexerError(IndexerErrorCode.DATABASE_INTEGRITY, "INTEGRITY", { fatal: true });
  }
  return BigInt(value);
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString(10) : item));
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
