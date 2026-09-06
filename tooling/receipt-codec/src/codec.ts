import {
  KERNEL_EMITTER_ID,
  MAX_RECEIPT_PAYLOAD_BYTES,
  MAX_RECEIPT_RECORDS,
  MAX_RECORD_DATA_BYTES,
  MAX_RECORD_TOPICS,
  MINI_CONTRACT_DEPLOYED_DATA_BYTES,
  MINI_CONTRACT_DEPLOYED_TOPIC,
  RECEIPT_FLAGS_V1,
  RECEIPT_VERSION,
  WORLD_EXECUTION_DATA_BYTES,
  WORLD_EXECUTION_TOPIC
} from "./constants.js";
import { ReceiptErrorCode, VMReceiptError } from "./errors.js";
import { assertBytes32, bytesToHex, inputToBytes, type Bytes32, type Hex } from "./hex.js";
import type {
  ApplicationRecord,
  MiniContractDeployedData,
  MiniContractDeployedRecord,
  VMReceiptV1,
  VMReceiptV1Input,
  VMRecord,
  VMRecordInput,
  WorldExecutionData,
  WorldExecutionRecord
} from "./types.js";

const HEADER_BYTES = 4;
const RECORD_LENGTH_BYTES = 4;
const EMITTER_BYTES = 32;
const TOPIC_COUNT_BYTES = 1;
const TOPIC_BYTES = 32;
const DATA_LENGTH_BYTES = 4;

function fail(
  code: (typeof ReceiptErrorCode)[keyof typeof ReceiptErrorCode],
  offset?: number,
  details?: Readonly<Record<string, string | number | bigint | boolean>>
): never {
  const options: { offset?: number; details?: Readonly<Record<string, string | number | bigint | boolean>> } = {};
  if (offset !== undefined) options.offset = offset;
  if (details !== undefined) options.details = details;
  throw new VMReceiptError(code, options);
}

function checkedAdd(left: number, right: number, offset: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) {
    fail(ReceiptErrorCode.LENGTH_OVERFLOW, offset, { left, right });
  }
  return result;
}

function requireRange(limit: number, offset: number, length: number, code: keyof typeof ReceiptErrorCode): void {
  const end = checkedAdd(offset, length, offset);
  if (end > limit) fail(ReceiptErrorCode[code], offset, { required: length, available: Math.max(0, limit - offset) });
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint256(bytes: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let index = 0; index < 32; index += 1) result = (result << 8n) | BigInt(bytes[offset + index] ?? 0);
  return result;
}

function sliceHex(bytes: Uint8Array, start: number, end: number): Hex {
  return bytesToHex(bytes.subarray(start, end));
}

function freezeRecord<T extends VMRecord>(record: T): T {
  Object.freeze(record.topics);
  if (record.kind !== "application") Object.freeze(record.decoded);
  return Object.freeze(record);
}

function publicRecordFields(raw: ParsedRawRecord) {
  return {
    recordLength: raw.recordLength,
    emitter: raw.emitter,
    topicCount: raw.topicCount,
    topics: raw.topics,
    dataLength: raw.dataLength,
    data: raw.data
  };
}

interface ParsedRawRecord {
  readonly recordLength: number;
  readonly emitter: Bytes32;
  readonly topicCount: number;
  readonly topics: readonly Bytes32[];
  readonly dataLength: number;
  readonly data: Hex;
  readonly dataBytes: Uint8Array;
}

function parseRecord(bytes: Uint8Array, start: number): { readonly raw: ParsedRawRecord; readonly next: number } {
  requireRange(bytes.length, start, RECORD_LENGTH_BYTES, "TRUNCATED_RECORD_LENGTH");
  const recordLength = readU32(bytes, start);
  const bodyStart = checkedAdd(start, RECORD_LENGTH_BYTES, start);
  const recordEnd = checkedAdd(bodyStart, recordLength, start);
  const parseLimit = Math.min(recordEnd, bytes.length);
  let cursor = bodyStart;

  requireRange(parseLimit, cursor, EMITTER_BYTES, "TRUNCATED_EMITTER");
  const emitter = sliceHex(bytes, cursor, cursor + EMITTER_BYTES) as Bytes32;
  cursor += EMITTER_BYTES;
  requireRange(parseLimit, cursor, TOPIC_COUNT_BYTES, "TRUNCATED_TOPIC_COUNT");
  const topicCount = bytes[cursor] ?? 0;
  cursor += TOPIC_COUNT_BYTES;
  if (topicCount > MAX_RECORD_TOPICS) {
    fail(ReceiptErrorCode.TOPIC_COUNT_EXCEEDED, cursor - 1, { topicCount, maximum: MAX_RECORD_TOPICS });
  }

  const topicsBytes = TOPIC_BYTES * topicCount;
  requireRange(parseLimit, cursor, topicsBytes, "TRUNCATED_TOPICS");
  const topics: Bytes32[] = [];
  for (let index = 0; index < topicCount; index += 1) {
    topics.push(sliceHex(bytes, cursor + index * TOPIC_BYTES, cursor + (index + 1) * TOPIC_BYTES) as Bytes32);
  }
  cursor += topicsBytes;
  requireRange(parseLimit, cursor, DATA_LENGTH_BYTES, "TRUNCATED_DATA_LENGTH");
  const dataLengthOffset = cursor;
  const dataLength = readU32(bytes, cursor);
  cursor += DATA_LENGTH_BYTES;
  if (dataLength > MAX_RECORD_DATA_BYTES) {
    fail(ReceiptErrorCode.DATA_LENGTH_EXCEEDED, dataLengthOffset, {
      dataLength,
      maximum: MAX_RECORD_DATA_BYTES
    });
  }

  const expectedLength = EMITTER_BYTES + TOPIC_COUNT_BYTES + topicsBytes + DATA_LENGTH_BYTES + dataLength;
  if (recordLength !== expectedLength) {
    fail(ReceiptErrorCode.RECORD_LENGTH_MISMATCH, start, { declared: recordLength, expected: expectedLength });
  }
  requireRange(bytes.length, cursor, dataLength, "TRUNCATED_DATA");
  const dataEnd = checkedAdd(cursor, dataLength, cursor);
  if (dataEnd !== recordEnd) {
    fail(ReceiptErrorCode.RECORD_LENGTH_MISMATCH, start, { declared: recordLength, expected: expectedLength });
  }
  const dataBytes = bytes.slice(cursor, dataEnd);
  return {
    raw: Object.freeze({
      recordLength,
      emitter,
      topicCount,
      topics: Object.freeze(topics),
      dataLength,
      data: bytesToHex(dataBytes),
      dataBytes
    }),
    next: recordEnd
  };
}

function parseWorldExecution(raw: ParsedRawRecord): WorldExecutionRecord {
  if (raw.dataLength !== WORLD_EXECUTION_DATA_BYTES) {
    fail(ReceiptErrorCode.KERNEL_RECORD_DATA_WIDTH, undefined, {
      selector: WORLD_EXECUTION_TOPIC,
      actual: raw.dataLength,
      expected: WORLD_EXECUTION_DATA_BYTES
    });
  }
  for (let index = 64; index < 92; index += 1) {
    if ((raw.dataBytes[index] ?? 0) !== 0) {
      fail(ReceiptErrorCode.NON_CANONICAL_EXECUTED_BYTES, index);
    }
  }
  const decoded: WorldExecutionData = {
    actor: sliceHex(raw.dataBytes, 0, 32) as Bytes32,
    rootTarget: sliceHex(raw.dataBytes, 32, 64) as Bytes32,
    executedBytes: readU32(raw.dataBytes, 92),
    tokenBurned: readUint256(raw.dataBytes, 96),
    grossTokenOut: readUint256(raw.dataBytes, 128),
    netTokenOut: readUint256(raw.dataBytes, 160)
  };
  return freezeRecord({ ...publicRecordFields(raw), kind: "worldExecution", decoded });
}

function parseDeployment(raw: ParsedRawRecord): MiniContractDeployedRecord {
  if (raw.dataLength !== MINI_CONTRACT_DEPLOYED_DATA_BYTES) {
    fail(ReceiptErrorCode.KERNEL_RECORD_DATA_WIDTH, undefined, {
      selector: MINI_CONTRACT_DEPLOYED_TOPIC,
      actual: raw.dataLength,
      expected: MINI_CONTRACT_DEPLOYED_DATA_BYTES
    });
  }
  const decoded: MiniContractDeployedData = {
    contractId: sliceHex(raw.dataBytes, 0, 32) as Bytes32,
    creator: sliceHex(raw.dataBytes, 32, 64) as Bytes32,
    codeHash: sliceHex(raw.dataBytes, 64, 96) as Bytes32
  };
  return freezeRecord({ ...publicRecordFields(raw), kind: "miniContractDeployed", decoded });
}

function classifyRecord(raw: ParsedRawRecord): VMRecord {
  const firstTopic = raw.topics[0];
  const isKnownKernelSelector = firstTopic === WORLD_EXECUTION_TOPIC || firstTopic === MINI_CONTRACT_DEPLOYED_TOPIC;
  if (isKnownKernelSelector && raw.emitter !== KERNEL_EMITTER_ID) {
    fail(ReceiptErrorCode.KERNEL_SELECTOR_EMITTER_MISMATCH, undefined, {
      emitter: raw.emitter,
      selector: firstTopic
    });
  }
  if (raw.emitter !== KERNEL_EMITTER_ID) {
    const application: ApplicationRecord = { ...publicRecordFields(raw), kind: "application" };
    return freezeRecord(application);
  }
  if (raw.topicCount !== 1) {
    fail(ReceiptErrorCode.KERNEL_RECORD_TOPIC_COUNT, undefined, { topicCount: raw.topicCount });
  }
  if (firstTopic === WORLD_EXECUTION_TOPIC) return parseWorldExecution(raw);
  if (firstTopic === MINI_CONTRACT_DEPLOYED_TOPIC) return parseDeployment(raw);
  fail(ReceiptErrorCode.UNKNOWN_KERNEL_SELECTOR, undefined, { selector: firstTopic ?? "none" });
}

function looksLikeCompleteRecord(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length - offset < RECORD_LENGTH_BYTES) return false;
  const declared = readU32(bytes, offset);
  return declared <= bytes.length - offset - RECORD_LENGTH_BYTES;
}

export function decodeVMReceipt(input: Uint8Array | Hex): VMReceiptV1 {
  const bytes = inputToBytes(input);
  if (bytes.length > MAX_RECEIPT_PAYLOAD_BYTES) {
    fail(ReceiptErrorCode.PAYLOAD_TOO_LARGE, undefined, {
      length: bytes.length,
      maximum: MAX_RECEIPT_PAYLOAD_BYTES
    });
  }
  if (bytes.length < HEADER_BYTES) fail(ReceiptErrorCode.TRUNCATED_HEADER, bytes.length);
  const version = bytes[0] ?? 0;
  const flags = bytes[1] ?? 0;
  const recordCount = readU16(bytes, 2);
  if (version !== RECEIPT_VERSION) {
    fail(ReceiptErrorCode.UNSUPPORTED_VERSION, 0, { version });
  }
  if (flags !== RECEIPT_FLAGS_V1) fail(ReceiptErrorCode.NONZERO_FLAGS, 1, { flags });
  if (recordCount === 0) fail(ReceiptErrorCode.RECORD_COUNT_ZERO, 2);
  if (recordCount > MAX_RECEIPT_RECORDS) {
    fail(ReceiptErrorCode.RECORD_COUNT_EXCEEDED, 2, { recordCount, maximum: MAX_RECEIPT_RECORDS });
  }

  let cursor = HEADER_BYTES;
  const rawRecords: ParsedRawRecord[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    if (cursor === bytes.length) {
      fail(ReceiptErrorCode.RECORD_COUNT_MISMATCH, cursor, { declared: recordCount, parsed: index });
    }
    const parsed = parseRecord(bytes, cursor);
    rawRecords.push(parsed.raw);
    cursor = parsed.next;
  }
  if (cursor !== bytes.length) {
    const code = looksLikeCompleteRecord(bytes, cursor)
      ? ReceiptErrorCode.RECORD_COUNT_MISMATCH
      : ReceiptErrorCode.TRAILING_BYTES;
    fail(code, cursor, { trailing: bytes.length - cursor });
  }

  const records = rawRecords.map(classifyRecord);
  const summaries = records.filter((record): record is WorldExecutionRecord => record.kind === "worldExecution");
  if (summaries.length === 0) fail(ReceiptErrorCode.MISSING_WORLD_EXECUTION);
  if (summaries.length > 1) fail(ReceiptErrorCode.DUPLICATE_WORLD_EXECUTION, undefined, { count: summaries.length });
  if (records.at(-1)?.kind !== "worldExecution") fail(ReceiptErrorCode.WORLD_EXECUTION_NOT_FINAL);
  const summary = summaries[0];
  if (summary === undefined) fail(ReceiptErrorCode.MISSING_WORLD_EXECUTION);

  Object.freeze(records);
  return Object.freeze({
    version: RECEIPT_VERSION,
    flags: RECEIPT_FLAGS_V1,
    recordCount,
    records,
    worldExecution: summary.decoded
  });
}

function pushU16(target: number[], value: number): void {
  target.push((value >>> 8) & 0xff, value & 0xff);
}

function pushU32(target: number[], value: number): void {
  target.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function append(target: number[], bytes: Uint8Array): void {
  for (const byte of bytes) target.push(byte);
}

function normalizeInputRecord(record: VMRecordInput): { emitter: Uint8Array; topics: Uint8Array[]; data: Uint8Array } {
  assertBytes32(record.emitter, "emitter");
  if (record.topics.length > MAX_RECORD_TOPICS) {
    fail(ReceiptErrorCode.TOPIC_COUNT_EXCEEDED, undefined, {
      topicCount: record.topics.length,
      maximum: MAX_RECORD_TOPICS
    });
  }
  const topics = record.topics.map((topic, index) => {
    assertBytes32(topic, `topics[${index}]`);
    return inputToBytes(topic);
  });
  const data = inputToBytes(record.data);
  if (data.length > MAX_RECORD_DATA_BYTES) {
    fail(ReceiptErrorCode.DATA_LENGTH_EXCEEDED, undefined, {
      dataLength: data.length,
      maximum: MAX_RECORD_DATA_BYTES
    });
  }
  return { emitter: inputToBytes(record.emitter), topics, data };
}

export function encodeVMReceipt(receipt: VMReceiptV1Input | VMReceiptV1): Uint8Array {
  if (receipt.version !== undefined && receipt.version !== RECEIPT_VERSION) {
    fail(ReceiptErrorCode.UNSUPPORTED_VERSION, 0, { version: receipt.version });
  }
  if (receipt.flags !== undefined && receipt.flags !== RECEIPT_FLAGS_V1) {
    fail(ReceiptErrorCode.NONZERO_FLAGS, 1, { flags: receipt.flags });
  }
  if (receipt.records.length === 0) fail(ReceiptErrorCode.RECORD_COUNT_ZERO, 2);
  if (receipt.records.length > MAX_RECEIPT_RECORDS) {
    fail(ReceiptErrorCode.RECORD_COUNT_EXCEEDED, 2, {
      recordCount: receipt.records.length,
      maximum: MAX_RECEIPT_RECORDS
    });
  }

  const output: number[] = [RECEIPT_VERSION, RECEIPT_FLAGS_V1];
  pushU16(output, receipt.records.length);
  for (const record of receipt.records) {
    const normalized = normalizeInputRecord(record);
    const recordLength =
      EMITTER_BYTES + TOPIC_COUNT_BYTES + TOPIC_BYTES * normalized.topics.length + DATA_LENGTH_BYTES + normalized.data.length;
    if (!Number.isSafeInteger(recordLength) || recordLength > 0xffffffff) {
      fail(ReceiptErrorCode.LENGTH_OVERFLOW);
    }
    pushU32(output, recordLength);
    append(output, normalized.emitter);
    output.push(normalized.topics.length);
    for (const topic of normalized.topics) append(output, topic);
    pushU32(output, normalized.data.length);
    append(output, normalized.data);
    if (output.length > MAX_RECEIPT_PAYLOAD_BYTES) {
      fail(ReceiptErrorCode.PAYLOAD_TOO_LARGE, undefined, {
        length: output.length,
        maximum: MAX_RECEIPT_PAYLOAD_BYTES
      });
    }
  }
  const encoded = Uint8Array.from(output);
  decodeVMReceipt(encoded);
  return encoded;
}

export function encodeVMReceiptHex(receipt: VMReceiptV1Input | VMReceiptV1): Hex {
  return bytesToHex(encodeVMReceipt(receipt));
}
