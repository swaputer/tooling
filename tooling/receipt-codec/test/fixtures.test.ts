import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  VMReceiptError,
  bytesToHex,
  decodeVMReceipt,
  encodeVMReceiptHex,
  hexToBytes,
  type Bytes32,
  type Hex
} from "../src/index.js";

const scenarios = [
  "unsigned-nop",
  "authenticated-call",
  "deploy",
  "src20-transfer",
  "src721-transfer",
  "cpamm-swap"
] as const;

interface FixtureRecord {
  readonly index: number;
  readonly recordLength: number;
  readonly emitter: Bytes32;
  readonly topicCount: number;
  readonly topics: readonly Bytes32[];
  readonly dataLength: number;
  readonly data: Hex;
}

interface GoldenFixture {
  readonly scenario: string;
  readonly worldId: Bytes32;
  readonly executionHeight: number;
  readonly payload: Hex;
  readonly recordCount: number;
  readonly records: readonly FixtureRecord[];
  readonly expectedRecordOrder: readonly string[];
}

async function loadFixture(scenario: string): Promise<GoldenFixture> {
  const path = resolve(process.cwd(), "fixtures", `${scenario}.json`);
  return JSON.parse(await readFile(path, "utf8")) as GoldenFixture;
}

describe("real Foundry VMReceiptV1 golden fixtures", () => {
  for (const scenario of scenarios) {
    it(`${scenario}: matches every independently expanded Solidity field and round-trips`, async () => {
      const fixture = await loadFixture(scenario);
      const decoded = decodeVMReceipt(fixture.payload);
      assert.equal(fixture.scenario, scenario);
      assert.match(fixture.worldId, /^0x[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(fixture.executionHeight) && fixture.executionHeight > 0);
      assert.equal(decoded.recordCount, fixture.recordCount);
      assert.equal(decoded.records.length, fixture.records.length);

      const expanded = decoded.records.map((record, index) => ({
        index,
        recordLength: record.recordLength,
        emitter: record.emitter,
        topicCount: record.topicCount,
        topics: record.topics,
        dataLength: record.dataLength,
        data: record.data
      }));
      assert.deepEqual(expanded, fixture.records);
      assert.deepEqual(
        decoded.records.map(
          (record) => `${record.emitter}:${record.topics[0] ?? (`0x${"00".repeat(32)}` as Bytes32)}`
        ),
        fixture.expectedRecordOrder
      );
      assert.equal(encodeVMReceiptHex(decoded), fixture.payload);
      assert.equal(bytesToHex(hexToBytes(fixture.payload)), fixture.payload);
    });

    it(`${scenario}: rejects truncation at every byte position`, async () => {
      const fixture = await loadFixture(scenario);
      const payload = hexToBytes(fixture.payload);
      for (let length = 0; length < payload.length; length += 1) {
        assert.throws(() => decodeVMReceipt(payload.slice(0, length)), VMReceiptError, `${scenario}:${length}`);
      }
    });
  }

  it("locks the expected scenario-specific record kinds and order", async () => {
    const expectedKinds = {
      "unsigned-nop": ["worldExecution"],
      "authenticated-call": ["worldExecution"],
      deploy: ["miniContractDeployed", "worldExecution"],
      "src20-transfer": ["application", "worldExecution"],
      "src721-transfer": ["application", "worldExecution"],
      "cpamm-swap": ["application", "application", "application", "worldExecution"]
    } as const;
    for (const scenario of scenarios) {
      const decoded = decodeVMReceipt((await loadFixture(scenario)).payload);
      assert.deepEqual(
        decoded.records.map((record) => record.kind),
        expectedKinds[scenario]
      );
    }
  });
});
