import { decodeVMReceipt, hexToBytes, type Bytes32, type Hex } from "@swaputer/receipt-codec";
import { keccak_256 } from "@noble/hashes/sha3";

import { IndexerError, IndexerErrorCode } from "./errors.js";
import { normalizeAddress, normalizeBytes32, normalizeDataHex } from "./encoding.js";
import type { Address, ParsedEvents, RpcLog } from "./types.js";

export const EVENTS_SIGNATURE = "Events(bytes32,uint64,bytes)" as const;
export const EVENTS_TOPIC = `0x${Buffer.from(keccak_256(new TextEncoder().encode(EVENTS_SIGNATURE))).toString("hex")}` as Bytes32;

function readWord(bytes: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let index = 0; index < 32; index += 1) result = (result << 8n) | BigInt(bytes[offset + index] ?? 0);
  return result;
}

function decodeHeight(topic: string): bigint {
  const normalized = normalizeBytes32(topic, IndexerErrorCode.OUTER_HEIGHT_WORD);
  const bytes = hexToBytes(normalized);
  for (let index = 0; index < 24; index += 1) {
    if (bytes[index] !== 0) throw new IndexerError(IndexerErrorCode.OUTER_HEIGHT_WORD, "EVENTS");
  }
  return readWord(bytes, 0);
}

export function decodeOuterData(value: string): Hex {
  const normalized = normalizeDataHex(value);
  const bytes = hexToBytes(normalized);
  if (bytes.length < 64) throw new IndexerError(IndexerErrorCode.OUTER_DATA_TRUNCATED, "EVENTS");
  const offset = readWord(bytes, 0);
  if (offset !== 32n) throw new IndexerError(IndexerErrorCode.OUTER_DATA_OFFSET, "EVENTS");
  const length = readWord(bytes, 32);
  if (length > 65_536n) {
    throw new IndexerError(IndexerErrorCode.OUTER_DATA_LENGTH, "EVENTS", { details: { length } });
  }
  const padded = ((length + 31n) / 32n) * 32n;
  const expected = 64n + padded;
  if (expected > BigInt(bytes.length)) throw new IndexerError(IndexerErrorCode.OUTER_DATA_TRUNCATED, "EVENTS");
  if (expected < BigInt(bytes.length)) throw new IndexerError(IndexerErrorCode.OUTER_DATA_TRAILING, "EVENTS");
  const numericLength = Number(length);
  const payloadEnd = 64 + numericLength;
  for (let index = payloadEnd; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) throw new IndexerError(IndexerErrorCode.OUTER_DATA_PADDING, "EVENTS");
  }
  return `0x${normalized.slice(2 + 64 * 2, 2 + payloadEnd * 2)}` as Hex;
}

export function parseEvents(log: RpcLog, configuredKernel: string): ParsedEvents {
  const kernel = normalizeAddress(configuredKernel);
  const address = normalizeAddress(log.address);
  if (address !== kernel) throw new IndexerError(IndexerErrorCode.OUTER_ADDRESS_MISMATCH, "EVENTS");
  if (log.topics.length === 0 || log.topics[0]?.toLowerCase() !== EVENTS_TOPIC) {
    throw new IndexerError(IndexerErrorCode.OUTER_TOPIC0_MISMATCH, "EVENTS");
  }
  if (log.topics.length !== 3) throw new IndexerError(IndexerErrorCode.OUTER_TOPIC_COUNT, "EVENTS");
  const worldId = normalizeBytes32(log.topics[1] ?? "", IndexerErrorCode.OUTER_WORLD_ID);
  const executionHeight = decodeHeight(log.topics[2] ?? "");
  const payload = decodeOuterData(log.data);
  try {
    const receipt = decodeVMReceipt(payload);
    return Object.freeze({
      kernelAddress: address as Address,
      worldId,
      executionHeight,
      payload,
      receipt
    });
  } catch (error) {
    throw new IndexerError(IndexerErrorCode.RECEIPT_INVALID, "RECEIPT", {
      details: {
        receiptCode:
          typeof error === "object" && error !== null && "code" in error ? String(error.code) : "UNKNOWN_RECEIPT_ERROR"
      }
    });
  }
}
