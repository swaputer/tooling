import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IndexerError, IndexerErrorCode } from "../src/errors.js";
import { decodeOuterData, parseEvents, EVENTS_TOPIC } from "../src/events.js";
import { hash, fixturePayload, KERNEL, makeLog, outerData, WORLD } from "./helpers.js";

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof IndexerError && error.code === code);
}

describe("strict outer Events decoding", () => {
  it("decodes canonical indexed fields, dynamic bytes ABI and Stage 6A receipt", () => {
    const log = makeLog(1n, hash("block"), 9n);
    const parsed = parseEvents(log, KERNEL.toUpperCase().replace("0X", "0x"));
    assert.equal(parsed.kernelAddress, KERNEL);
    assert.equal(parsed.worldId, WORLD);
    assert.equal(parsed.executionHeight, 9n);
    assert.equal(parsed.receipt.recordCount, 1);
    assert.equal(parsed.receipt.records[0]?.kind, "worldExecution");
  });

  it("rejects an unconfigured address and an inexact topic0", () => {
    expectCode(() => parseEvents(makeLog(1n, hash("b"), 1n, { address: "0x2000000000000000000000000000000000000002" }), KERNEL), IndexerErrorCode.OUTER_ADDRESS_MISMATCH);
    const log = makeLog(1n, hash("b"), 1n, { topics: [hash("not-events"), WORLD, `0x${"00".repeat(31)}01`] });
    expectCode(() => parseEvents(log, KERNEL), IndexerErrorCode.OUTER_TOPIC0_MISMATCH);
  });

  it("requires exactly three topics and canonical bytes32 world/uint64 height words", () => {
    expectCode(
      () => parseEvents(makeLog(1n, hash("b"), 1n, { topics: [EVENTS_TOPIC, WORLD] }), KERNEL),
      IndexerErrorCode.OUTER_TOPIC_COUNT
    );
    expectCode(
      () => parseEvents(makeLog(1n, hash("b"), 1n, { topics: [EVENTS_TOPIC, "0x12", `0x${"00".repeat(31)}01`] }), KERNEL),
      IndexerErrorCode.OUTER_WORLD_ID
    );
    expectCode(
      () => parseEvents(makeLog(1n, hash("b"), 1n, { topics: [EVENTS_TOPIC, WORLD, `0x01${"00".repeat(31)}`] }), KERNEL),
      IndexerErrorCode.OUTER_HEIGHT_WORD
    );
  });

  it("rejects malformed hex, truncation and noncanonical dynamic offsets", () => {
    expectCode(() => decodeOuterData("0x0"), IndexerErrorCode.OUTER_DATA_HEX);
    expectCode(() => decodeOuterData("0x"), IndexerErrorCode.OUTER_DATA_TRUNCATED);
    expectCode(() => decodeOuterData(outerData(fixturePayload(), { offset: 64n })), IndexerErrorCode.OUTER_DATA_OFFSET);
  });

  it("rejects length overflow, truncation, nonzero padding and trailing bytes", () => {
    expectCode(() => decodeOuterData(outerData("0x", { length: 65_537n })), IndexerErrorCode.OUTER_DATA_LENGTH);
    expectCode(() => decodeOuterData(outerData(fixturePayload(), { length: 65_000n })), IndexerErrorCode.OUTER_DATA_TRUNCATED);
    expectCode(() => decodeOuterData(outerData("0x01", { paddingByte: "ff" })), IndexerErrorCode.OUTER_DATA_PADDING);
    expectCode(() => decodeOuterData(outerData(fixturePayload(), { trailing: "00" })), IndexerErrorCode.OUTER_DATA_TRAILING);
  });

  it("wraps Stage 6A failures without exposing partial records", () => {
    const payload = fixturePayload();
    const malformed = `0x02${payload.slice(4)}` as `0x${string}`;
    const log = makeLog(1n, hash("b"), 1n, { payload: malformed });
    expectCode(() => parseEvents(log, KERNEL), IndexerErrorCode.RECEIPT_INVALID);
  });
});
