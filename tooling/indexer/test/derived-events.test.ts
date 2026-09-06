import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KERNEL_EMITTER_ID,
  MINI_CONTRACT_DEPLOYED_TOPIC,
  WORLD_EXECUTION_TOPIC,
  encodeVMReceiptHex,
  type Bytes32,
  type Hex,
  type VMRecordInput
} from "@swaputer-labs/receipt-codec";

import { migrate, openIndexerDatabase } from "../src/database.js";
import { listDecodedEvents, rebuildDecodedEvents } from "../src/derived-events.js";
import { disableAbiRegistry, listAbiRegistry, referenceEventAbis, registerDeclaredEventAbi } from "../src/registry.js";
import { SwapVMIndexer } from "../src/indexer.js";
import { FakeRpcTransport, TEST_CONFIG, WORLD, hash, makeLog } from "./helpers.js";

const CONTRACT = `0x01${"44".repeat(31)}` as Bytes32;
const CREATOR = `0x${"00".repeat(12)}${"11".repeat(20)}` as Bytes32;
const FROM = CREATOR;
const TO = `0x${"00".repeat(12)}${"22".repeat(20)}` as Bytes32;

function reference(standard: string) {
  const result = referenceEventAbis().find((entry) => entry.standard === standard);
  assert.notEqual(result, undefined);
  return result!;
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function summaryData(): Hex {
  return `0x${FROM.slice(2)}${CONTRACT.slice(2)}${word(1n)}${word(1n)}${word(100n)}${word(99n)}` as Hex;
}

function deploymentData(codeHash: Bytes32): Hex {
  return `0x${CONTRACT.slice(2)}${CREATOR.slice(2)}${codeHash.slice(2)}` as Hex;
}

function receipt(
  codeHash: Bytes32,
  event: { readonly topics: readonly Bytes32[]; readonly data: Hex }
): Hex {
  const records: VMRecordInput[] = [
    { emitter: CONTRACT, topics: event.topics, data: event.data },
    { emitter: KERNEL_EMITTER_ID, topics: [MINI_CONTRACT_DEPLOYED_TOPIC], data: deploymentData(codeHash) },
    { emitter: KERNEL_EMITTER_ID, topics: [WORLD_EXECUTION_TOPIC], data: summaryData() }
  ];
  return encodeVMReceiptHex({ records });
}

function transferReceipt(codeHash: Bytes32, amount = 125n): Hex {
  const event = reference("SRC-20").events.find((item) => item.name === "Transfer");
  assert.notEqual(event, undefined);
  return receipt(codeHash, { topics: [event!.topic0, FROM, TO], data: `0x${word(amount)}` as Hex });
}

function memoryDatabase() {
  const database = openIndexerDatabase(":memory:");
  migrate(database);
  return database;
}

describe("derived application event views", () => {
  it("decodes a constructor event before its deployment record as verified_reference", async () => {
    const rpc = new FakeRpcTransport();
    const src20 = reference("SRC-20");
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n, { payload: transferReceipt(src20.codeHash) })]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      const events = listDecodedEvents(database, { canonicalOnly: true });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.decode_status, "decoded");
      assert.equal(events[0]?.trust_level, "verified_reference");
      assert.equal(events[0]?.standard, "SRC-20");
      assert.equal(events[0]?.code_hash, src20.codeHash);
      const fields = database.prepare("SELECT field_name, normalized_value FROM decoded_event_fields ORDER BY field_index").all();
      assert.deepEqual(fields, [
        { field_name: "from", normalized_value: FROM },
        { field_name: "to", normalized_value: TO },
        { field_name: "amount", normalized_value: "125" }
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps an unknown selector on a verified program raw without invalidating ingestion", async () => {
    const rpc = new FakeRpcTransport();
    const src20 = reference("SRC-20");
    rpc.addBlock((number, blockHash) => [
      makeLog(number, blockHash, 1n, { payload: receipt(src20.codeHash, { topics: [hash("Unknown(bytes32)")], data: "0x" }) })
    ]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      const event = listDecodedEvents(database)[0];
      assert.equal(event?.decode_status, "unknown_event");
      assert.equal(event?.raw_data, "0x");
      assert.equal((database.prepare("SELECT count(*) value FROM ingestion_errors").get() as { value: bigint }).value, 0n);
      assert.equal((database.prepare("SELECT count(*) value FROM event_decode_errors").get() as { value: bigint }).value, 0n);
    } finally {
      database.close();
    }
  });

  it("records a strict event decode failure without partial fields or raw rollback", async () => {
    const rpc = new FakeRpcTransport();
    const src721 = reference("SRC-721");
    const approval = src721.events.find((event) => event.name === "ApprovalForAll");
    assert.notEqual(approval, undefined);
    rpc.addBlock((number, blockHash) => [
      makeLog(number, blockHash, 1n, {
        payload: receipt(src721.codeHash, { topics: [approval!.topic0, FROM, TO], data: `0x${word(2n)}` as Hex })
      })
    ]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      assert.equal(listDecodedEvents(database)[0]?.decode_status, "failed");
      assert.equal((database.prepare("SELECT count(*) value FROM decoded_event_fields").get() as { value: bigint }).value, 0n);
      assert.equal(
        (database.prepare("SELECT error_code FROM event_decode_errors").get() as { error_code: string }).error_code,
        "BOOL_NON_CANONICAL"
      );
      assert.equal((database.prepare("SELECT count(*) value FROM vm_records").get() as { value: bigint }).value, 3n);
      assert.equal((database.prepare("SELECT next_block FROM ingestion_cursor").get() as { next_block: string }).next_block, "2");
    } finally {
      database.close();
    }
  });

  it("promotes historical unknown code only to declared_unverified and detects same-level ambiguity", async () => {
    const rpc = new FakeRpcTransport();
    const customHash = hash("custom-transfer-code");
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n, { payload: transferReceipt(customHash) })]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      assert.equal(listDecodedEvents(database)[0]?.decode_status, "unknown_program");
      assert.equal(listDecodedEvents(database, { codeHash: customHash }).length, 1);

      const src20 = reference("SRC-20");
      const first = registerDeclaredEventAbi(database, { ...src20, codeHash: customHash });
      let rebuilt = rebuildDecodedEvents(database);
      assert.equal(rebuilt.decoded, 1n);
      assert.equal(listDecodedEvents(database)[0]?.trust_level, "declared_unverified");
      assert.equal(listDecodedEvents(database)[0]?.registry_id, first.registryId);

      const altered = JSON.parse(JSON.stringify({ ...src20, codeHash: customHash })) as Record<string, unknown>;
      altered.standard = "User-Claimed-Transfer";
      registerDeclaredEventAbi(database, altered);
      rebuilt = rebuildDecodedEvents(database);
      assert.equal(rebuilt.ambiguous, 1n);
      assert.equal(listDecodedEvents(database)[0]?.decode_status, "ambiguous");
      assert.equal(
        (database.prepare("SELECT error_code FROM event_decode_errors").get() as { error_code: string }).error_code,
        "REGISTRY_AMBIGUOUS"
      );
      assert.equal((database.prepare("SELECT count(*) value FROM decoded_event_fields").get() as { value: bigint }).value, 0n);
      assert.equal(listAbiRegistry(database).filter((entry) => entry.codeHash === customHash).length, 2);
    } finally {
      database.close();
    }
  });

  it("rebuilds idempotently and honors codeHash/block filters", async () => {
    const rpc = new FakeRpcTransport();
    const src20 = reference("SRC-20");
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n, { payload: transferReceipt(src20.codeHash) })]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      const first = rebuildDecodedEvents(database, { codeHash: src20.codeHash, fromBlock: 1n, toBlock: 1n });
      const second = rebuildDecodedEvents(database, { codeHash: src20.codeHash, fromBlock: 1n, toBlock: 1n });
      assert.deepEqual(second, first);
      assert.equal(listDecodedEvents(database, { account: FROM, tokenId: 125n }).length, 0);
      assert.equal(listDecodedEvents(database, { account: FROM, signature: "Transfer(bytes32,bytes32,uint256)" }).length, 1);
      assert.equal((database.prepare("SELECT count(*) value FROM decoded_events").get() as { value: bigint }).value, 1n);
    } finally {
      database.close();
    }
  });

  it("removes stale decoding when a registry is disabled and selectively rebuilt", async () => {
    const rpc = new FakeRpcTransport();
    const src20 = reference("SRC-20");
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n, { payload: transferReceipt(src20.codeHash) })]);
    const database = memoryDatabase();
    try {
      await new SwapVMIndexer(database, rpc).sync(TEST_CONFIG);
      const registry = listAbiRegistry(database).find((entry) => entry.codeHash === src20.codeHash);
      assert.notEqual(registry, undefined);
      assert.equal(disableAbiRegistry(database, registry!.registryId), true);
      const rebuilt = rebuildDecodedEvents(database, { registryId: registry!.registryId });
      assert.equal(rebuilt.unknown, 1n);
      assert.equal(listDecodedEvents(database)[0]?.decode_status, "unknown_program");
      assert.equal((database.prepare("SELECT count(*) value FROM decoded_event_fields").get() as { value: bigint }).value, 0n);
    } finally {
      database.close();
    }
  });

  it("rebinds canonical events after a real hash-based reorg and preserves orphan decoded history", async () => {
    const rpc = new FakeRpcTransport();
    const src20 = reference("SRC-20");
    const customHash = hash("replacement-code");
    rpc.addBlock((number, blockHash) => [makeLog(number, blockHash, 1n, { payload: transferReceipt(src20.codeHash) })]);
    const database = memoryDatabase();
    try {
      const indexer = new SwapVMIndexer(database, rpc);
      await indexer.sync(TEST_CONFIG);
      registerDeclaredEventAbi(database, { ...src20, codeHash: customHash });
      rpc.replaceAfter(0n, [
        (number, blockHash) => [makeLog(number, blockHash, 1n, { payload: transferReceipt(customHash), transactionHash: hash("new-tx") })]
      ]);
      await indexer.sync(TEST_CONFIG);
      const canonical = listDecodedEvents(database, { canonicalOnly: true });
      assert.equal(canonical.length, 1);
      assert.equal(canonical[0]?.code_hash, customHash);
      assert.equal(canonical[0]?.trust_level, "declared_unverified");
      const all = listDecodedEvents(database);
      assert.equal(all.length, 2);
      assert.deepEqual(new Set(all.map((event) => event.trust_level)), new Set(["verified_reference", "declared_unverified"]));
    } finally {
      database.close();
    }
  });
});
