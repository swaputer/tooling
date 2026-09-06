import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KERNEL_EMITTER_ID,
  MAX_RECEIPT_PAYLOAD_BYTES,
  MAX_RECEIPT_RECORDS,
  MAX_RECORD_DATA_BYTES,
  MINI_CONTRACT_DEPLOYED_TOPIC,
  ReceiptErrorCode,
  VMReceiptError,
  WORLD_EXECUTION_TOPIC,
  bytesToHex,
  decodeVMReceipt,
  encodeVMReceipt,
  encodeVMReceiptHex,
  hexToBytes,
  type Bytes32,
  type Hex,
  type VMReceiptV1Input,
  type VMRecordInput
} from "../src/index.js";

const ZERO = `0x${"00".repeat(32)}` as Bytes32;
const APP = `0x01${"00".repeat(30)}01` as Bytes32;
const OTHER_APP = `0x01${"00".repeat(30)}02` as Bytes32;
const APP_TOPIC = `0x${"42".repeat(32)}` as Bytes32;
const TRANSFER_TOPIC = "0xbc7a322f72742a0c810e1f76615f57ed3a5bbfcbd956d3d451b3158968faace9" as Bytes32;

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function word(value: bigint): Uint8Array {
  const result = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  assert.equal(remaining, 0n);
  return result;
}

function summaryData(executedBytes = 7): Hex {
  return bytesToHex(
    concat(
      hexToBytes(ZERO),
      hexToBytes(APP),
      word(BigInt(executedBytes)),
      word(70n),
      word(1_000n),
      word(930n)
    )
  );
}

function summaryRecord(executedBytes = 7): VMRecordInput {
  return { emitter: KERNEL_EMITTER_ID, topics: [WORLD_EXECUTION_TOPIC], data: summaryData(executedBytes) };
}

function applicationRecord(
  topics: readonly Bytes32[] = [APP_TOPIC],
  data: Uint8Array | Hex = "0x"
): VMRecordInput {
  return { emitter: APP, topics, data };
}

function canonicalInput(): VMReceiptV1Input {
  return { records: [applicationRecord([APP_TOPIC], "0x1234"), summaryRecord()] };
}

function expectCode(action: () => unknown, code: (typeof ReceiptErrorCode)[keyof typeof ReceiptErrorCode]): void {
  assert.throws(action, (error: unknown) => error instanceof VMReceiptError && error.code === code);
}

function rawRecord(
  emitter: Bytes32,
  topics: readonly Bytes32[],
  data: Uint8Array,
  overrides: { readonly recordLength?: number; readonly topicCount?: number; readonly dataLength?: number } = {}
): Uint8Array {
  const topicBytes = topics.map(hexToBytes);
  const bodyLength = 32 + 1 + 32 * topics.length + 4 + data.length;
  return concat(
    u32(overrides.recordLength ?? bodyLength),
    hexToBytes(emitter),
    Uint8Array.of(overrides.topicCount ?? topics.length),
    ...topicBytes,
    u32(overrides.dataLength ?? data.length),
    data
  );
}

function rawReceipt(records: readonly Uint8Array[], count = records.length): Uint8Array {
  return concat(Uint8Array.of(1, 0), u16(count), ...records);
}

function setU16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  copy.set(u16(value), offset);
  return copy;
}

function setU32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  copy.set(u32(value), offset);
  return copy;
}

describe("VMReceiptV1 canonical codec", () => {
  it("accepts Uint8Array and hex, exposes readonly typed kernel data, and round-trips canonically", () => {
    const encoded = encodeVMReceipt(canonicalInput());
    const decodedBytes = decodeVMReceipt(encoded);
    const decodedHex = decodeVMReceipt(bytesToHex(encoded));

    assert.deepEqual(decodedBytes, decodedHex);
    assert.equal(decodedBytes.version, 1);
    assert.equal(decodedBytes.flags, 0);
    assert.equal(decodedBytes.recordCount, 2);
    assert.equal(decodedBytes.records[0]?.kind, "application");
    assert.equal(decodedBytes.records[1]?.kind, "worldExecution");
    assert.deepEqual(decodedBytes.worldExecution, {
      actor: ZERO,
      rootTarget: APP,
      executedBytes: 7,
      tokenBurned: 70n,
      grossTokenOut: 1_000n,
      netTokenOut: 930n
    });
    assert.ok(Object.isFrozen(decodedBytes));
    assert.ok(Object.isFrozen(decodedBytes.records));
    assert.ok(Object.isFrozen(decodedBytes.records[0]));
    assert.equal(encodeVMReceiptHex(decodedBytes), bytesToHex(encoded));
  });

  it("keeps unknown application records lossless, including Transfer-shaped claims", () => {
    const data = Uint8Array.of(1, 2, 3, 4, 5);
    const encoded = encodeVMReceipt({ records: [applicationRecord([TRANSFER_TOPIC], data), summaryRecord()] });
    const decoded = decodeVMReceipt(encoded);
    const record = decoded.records[0];
    assert.equal(record?.kind, "application");
    assert.equal(record?.emitter, APP);
    assert.deepEqual(record?.topics, [TRANSFER_TOPIC]);
    assert.equal(record?.data, "0x0102030405");
    assert.equal(encodeVMReceiptHex(decoded), bytesToHex(encoded));
  });

  it("accepts application topicCount boundaries 0 and 4", () => {
    const four = [APP_TOPIC, APP_TOPIC, APP_TOPIC, APP_TOPIC] as const;
    for (const topics of [[], four] as const) {
      const decoded = decodeVMReceipt(encodeVMReceipt({ records: [applicationRecord(topics), summaryRecord()] }));
      assert.equal(decoded.records[0]?.topicCount, topics.length);
    }
  });

  it("accepts maximum data and rejects data above 4096 bytes", () => {
    const maximum = new Uint8Array(MAX_RECORD_DATA_BYTES);
    const decoded = decodeVMReceipt(
      encodeVMReceipt({ records: [applicationRecord([], maximum), summaryRecord()] })
    );
    assert.equal(decoded.records[0]?.dataLength, MAX_RECORD_DATA_BYTES);
    expectCode(
      () => encodeVMReceipt({ records: [applicationRecord([], new Uint8Array(MAX_RECORD_DATA_BYTES + 1)), summaryRecord()] }),
      ReceiptErrorCode.DATA_LENGTH_EXCEEDED
    );
  });

  it("accepts 64 records and an exactly 65,536-byte payload, then rejects one byte more", () => {
    const records: VMRecordInput[] = [];
    for (let index = 0; index < 15; index += 1) records.push(applicationRecord([], new Uint8Array(4096)));
    records.push(applicationRecord([], new Uint8Array(1244)));
    for (let index = 0; index < 47; index += 1) records.push(applicationRecord([], "0x"));
    records.push(summaryRecord());

    const encoded = encodeVMReceipt({ records });
    assert.equal(records.length, MAX_RECEIPT_RECORDS);
    assert.equal(encoded.length, MAX_RECEIPT_PAYLOAD_BYTES);
    assert.equal(decodeVMReceipt(encoded).recordCount, MAX_RECEIPT_RECORDS);

    const oversized = records.slice();
    oversized[15] = applicationRecord([], new Uint8Array(1245));
    expectCode(() => encodeVMReceipt({ records: oversized }), ReceiptErrorCode.PAYLOAD_TOO_LARGE);
  });
});

describe("VMReceiptV1 structural rejection", () => {
  it("rejects every truncation point of a canonical receipt without returning partial records", () => {
    const encoded = encodeVMReceipt(canonicalInput());
    for (let length = 0; length < encoded.length; length += 1) {
      assert.throws(() => decodeVMReceipt(encoded.slice(0, length)), VMReceiptError, `length ${length}`);
    }
  });

  it("rejects version, flags, recordCount and trailing-byte mutations", () => {
    const encoded = encodeVMReceipt(canonicalInput());
    const badVersion = encoded.slice();
    badVersion[0] = 2;
    expectCode(() => decodeVMReceipt(badVersion), ReceiptErrorCode.UNSUPPORTED_VERSION);
    const badFlags = encoded.slice();
    badFlags[1] = 1;
    expectCode(() => decodeVMReceipt(badFlags), ReceiptErrorCode.NONZERO_FLAGS);
    expectCode(() => decodeVMReceipt(setU16(encoded, 2, 0)), ReceiptErrorCode.RECORD_COUNT_ZERO);
    expectCode(() => decodeVMReceipt(setU16(encoded, 2, 1)), ReceiptErrorCode.RECORD_COUNT_MISMATCH);
    expectCode(() => decodeVMReceipt(setU16(encoded, 2, 64)), ReceiptErrorCode.RECORD_COUNT_MISMATCH);
    expectCode(() => decodeVMReceipt(setU16(encoded, 2, 65)), ReceiptErrorCode.RECORD_COUNT_EXCEEDED);
    expectCode(() => decodeVMReceipt(setU16(encoded, 2, 0xffff)), ReceiptErrorCode.RECORD_COUNT_EXCEEDED);
    expectCode(() => decodeVMReceipt(concat(encoded, Uint8Array.of(0))), ReceiptErrorCode.TRAILING_BYTES);
  });

  it("rejects recordLength and dataLength plus/minus one", () => {
    const encoded = encodeVMReceipt(canonicalInput());
    const recordLength = 32 + 1 + 32 + 4 + 2;
    expectCode(() => decodeVMReceipt(setU32(encoded, 4, recordLength - 1)), ReceiptErrorCode.RECORD_LENGTH_MISMATCH);
    expectCode(() => decodeVMReceipt(setU32(encoded, 4, recordLength + 1)), ReceiptErrorCode.RECORD_LENGTH_MISMATCH);
    const dataLengthOffset = 4 + 4 + 32 + 1 + 32;
    expectCode(() => decodeVMReceipt(setU32(encoded, dataLengthOffset, 1)), ReceiptErrorCode.RECORD_LENGTH_MISMATCH);
    expectCode(() => decodeVMReceipt(setU32(encoded, dataLengthOffset, 3)), ReceiptErrorCode.RECORD_LENGTH_MISMATCH);
  });

  it("rejects topicCount 5 and 255 and malformed uint32 length claims", () => {
    const encoded = encodeVMReceipt(canonicalInput());
    const five = encoded.slice();
    five[40] = 5;
    expectCode(() => decodeVMReceipt(five), ReceiptErrorCode.TOPIC_COUNT_EXCEEDED);
    const twoFiftyFive = encoded.slice();
    twoFiftyFive[40] = 255;
    expectCode(() => decodeVMReceipt(twoFiftyFive), ReceiptErrorCode.TOPIC_COUNT_EXCEEDED);
    expectCode(() => decodeVMReceipt(setU32(encoded, 4, 0xffffffff)), ReceiptErrorCode.RECORD_LENGTH_MISMATCH);
  });

  it("rejects declared data above the limit before unsafe length arithmetic", () => {
    const malformed = rawReceipt([
      rawRecord(APP, [], new Uint8Array(), { recordLength: 32 + 1 + 4 + 4097, dataLength: 4097 })
    ]);
    expectCode(() => decodeVMReceipt(malformed), ReceiptErrorCode.DATA_LENGTH_EXCEEDED);
  });

  it("rejects payloads above the global limit before parsing", () => {
    const bytes = new Uint8Array(MAX_RECEIPT_PAYLOAD_BYTES + 1);
    bytes.set([1, 0, 0, 1]);
    expectCode(() => decodeVMReceipt(bytes), ReceiptErrorCode.PAYLOAD_TOO_LARGE);
  });

  it("rejects fewer and extra encoded records relative to recordCount", () => {
    const app = rawRecord(APP, [APP_TOPIC], new Uint8Array());
    const summary = rawRecord(KERNEL_EMITTER_ID, [WORLD_EXECUTION_TOPIC], hexToBytes(summaryData()));
    expectCode(() => decodeVMReceipt(rawReceipt([app, summary], 1)), ReceiptErrorCode.RECORD_COUNT_MISMATCH);
    expectCode(() => decodeVMReceipt(rawReceipt([app, summary], 3)), ReceiptErrorCode.RECORD_COUNT_MISMATCH);
  });

  it("rejects invalid input and malformed hex", () => {
    expectCode(() => decodeVMReceipt("0x0" as Hex), ReceiptErrorCode.INVALID_HEX);
    expectCode(() => decodeVMReceipt("0xzz" as Hex), ReceiptErrorCode.INVALID_HEX);
    expectCode(() => decodeVMReceipt(42 as never), ReceiptErrorCode.INVALID_INPUT);
  });
});

describe("VMReceiptV1 Kernel record semantics", () => {
  it("rejects missing, duplicate, and non-final WorldExecution", () => {
    expectCode(
      () => decodeVMReceipt(rawReceipt([rawRecord(APP, [APP_TOPIC], new Uint8Array())])),
      ReceiptErrorCode.MISSING_WORLD_EXECUTION
    );
    expectCode(
      () => encodeVMReceipt({ records: [summaryRecord(), summaryRecord()] }),
      ReceiptErrorCode.DUPLICATE_WORLD_EXECUTION
    );
    expectCode(
      () => encodeVMReceipt({ records: [summaryRecord(), applicationRecord()] }),
      ReceiptErrorCode.WORLD_EXECUTION_NOT_FINAL
    );
  });

  it("strictly parses deployment data and rejects wrong Kernel data widths", () => {
    const deploymentData = concat(hexToBytes(APP), hexToBytes(OTHER_APP), hexToBytes(APP_TOPIC));
    const decoded = decodeVMReceipt(
      encodeVMReceipt({
        records: [
          { emitter: KERNEL_EMITTER_ID, topics: [MINI_CONTRACT_DEPLOYED_TOPIC], data: deploymentData },
          summaryRecord()
        ]
      })
    );
    const deployment = decoded.records[0];
    assert.equal(deployment?.kind, "miniContractDeployed");
    if (deployment?.kind === "miniContractDeployed") {
      assert.deepEqual(deployment.decoded, { contractId: APP, creator: OTHER_APP, codeHash: APP_TOPIC });
    }

    for (const [topic, width] of [
      [WORLD_EXECUTION_TOPIC, 191],
      [WORLD_EXECUTION_TOPIC, 193],
      [MINI_CONTRACT_DEPLOYED_TOPIC, 95],
      [MINI_CONTRACT_DEPLOYED_TOPIC, 97]
    ] as const) {
      const records = [
        rawRecord(KERNEL_EMITTER_ID, [topic], new Uint8Array(width)),
        rawRecord(KERNEL_EMITTER_ID, [WORLD_EXECUTION_TOPIC], hexToBytes(summaryData()))
      ];
      expectCode(() => decodeVMReceipt(rawReceipt(records)), ReceiptErrorCode.KERNEL_RECORD_DATA_WIDTH);
    }
  });

  it("rejects a correct Kernel selector under a non-Kernel emitter", () => {
    for (const topic of [WORLD_EXECUTION_TOPIC, MINI_CONTRACT_DEPLOYED_TOPIC]) {
      const fake = rawRecord(APP, [topic], new Uint8Array(topic === WORLD_EXECUTION_TOPIC ? 192 : 96));
      const summary = rawRecord(KERNEL_EMITTER_ID, [WORLD_EXECUTION_TOPIC], hexToBytes(summaryData()));
      expectCode(() => decodeVMReceipt(rawReceipt([fake, summary])), ReceiptErrorCode.KERNEL_SELECTOR_EMITTER_MISMATCH);
    }
  });

  it("rejects unknown Kernel selectors, extra Kernel topics, and noncanonical uint32 words", () => {
    const summary = rawRecord(KERNEL_EMITTER_ID, [WORLD_EXECUTION_TOPIC], hexToBytes(summaryData()));
    expectCode(
      () => decodeVMReceipt(rawReceipt([rawRecord(KERNEL_EMITTER_ID, [APP_TOPIC], new Uint8Array()), summary])),
      ReceiptErrorCode.UNKNOWN_KERNEL_SELECTOR
    );
    expectCode(
      () =>
        decodeVMReceipt(
          rawReceipt([
            rawRecord(KERNEL_EMITTER_ID, [MINI_CONTRACT_DEPLOYED_TOPIC, APP_TOPIC], new Uint8Array(96)),
            summary
          ])
        ),
      ReceiptErrorCode.KERNEL_RECORD_TOPIC_COUNT
    );
    const noncanonical = hexToBytes(summaryData());
    noncanonical[64] = 1;
    expectCode(
      () => decodeVMReceipt(rawReceipt([rawRecord(KERNEL_EMITTER_ID, [WORLD_EXECUTION_TOPIC], noncanonical)])),
      ReceiptErrorCode.NON_CANONICAL_EXECUTED_BYTES
    );
  });
});
