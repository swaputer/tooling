import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeVMReceipt, type Bytes32, type Hex } from "@swaputer/receipt-codec";

import {
  EventAbiError,
  EventAbiErrorCode,
  canonicalDescriptorJson,
  classifyAccount,
  decodeApplicationEvent,
  eventAbiDescriptorHash,
  normalizeEventAbiDescriptor
} from "../src/event-abi.js";
import { referenceEventAbis } from "../src/registry.js";
import { fixturePayload, hash } from "./helpers.js";

function descriptor(standard: string) {
  const result = referenceEventAbis().find((entry) => entry.standard === standard);
  assert.notEqual(result, undefined);
  return result!;
}

function applicationFixture(name: string, index: number) {
  const record = decodeVMReceipt(fixturePayload(name)).records[index];
  assert.equal(record?.kind, "application");
  if (record?.kind !== "application") throw new Error("missing application fixture");
  return record;
}

describe("SwapVMEventABI v1", () => {
  it("normalizes and hashes four generated reference descriptors deterministically", () => {
    const references = referenceEventAbis();
    assert.deepEqual(references.map((entry) => entry.standard), ["SRC-20", "SRC-721", "SRC-1155", "SwapVM-CPAMM"]);
    for (const entry of references) {
      assert.equal(normalizeEventAbiDescriptor(JSON.parse(canonicalDescriptorJson(entry))).codeHash, entry.codeHash);
      assert.match(eventAbiDescriptorHash(entry), /^0x[0-9a-f]{64}$/);
      assert.equal(canonicalDescriptorJson(entry), canonicalDescriptorJson(JSON.parse(canonicalDescriptorJson(entry))));
    }
  });

  it("decodes real SRC-20, SRC-721 and nested CPAMM golden records", () => {
    const transfer20 = decodeApplicationEvent(descriptor("SRC-20"), applicationFixture("src20-transfer", 0));
    assert.equal(transfer20?.signature, "Transfer(bytes32,bytes32,uint256)");
    assert.equal(transfer20?.fields[2]?.value, 125n);
    assert.equal(transfer20?.fields[0]?.accountKind, "EOA");

    const transfer721 = decodeApplicationEvent(descriptor("SRC-721"), applicationFixture("src721-transfer", 0));
    assert.equal(transfer721?.fields[2]?.normalized, "7");
    assert.equal(transfer721?.fields[1]?.accountKind, "EOA");

    const swap = decodeApplicationEvent(descriptor("SwapVM-CPAMM"), applicationFixture("cpamm-swap", 2));
    assert.equal(swap?.signature, "Swap(bytes32,bytes32,uint256,uint256)");
    assert.equal(swap?.fields[2]?.normalized, "10000");
    assert.ok(BigInt(swap?.fields[3]?.normalized ?? "0") > 0n);
  });

  it("decodes every declared event and enforces its exact indexed/data layout", () => {
    const account = `0x${"00".repeat(12)}${"45".repeat(20)}` as Bytes32;
    const valueFor = (type: string): Bytes32 => {
      if (type === "bool") return `0x${"00".repeat(31)}01`;
      if (type === "int256") return `0x${"ff".repeat(32)}`;
      if (type === "address") return `0x${"00".repeat(12)}${"67".repeat(20)}`;
      if (type === "account") return account;
      return `0x${"00".repeat(31)}07`;
    };
    let count = 0;
    for (const abi of referenceEventAbis()) {
      for (const declared of abi.events) {
        const topics: Bytes32[] = [declared.topic0];
        const data: Bytes32[] = [];
        for (const field of declared.fields) {
          if (field.indexed) topics[field.position] = valueFor(field.type);
          else data[field.position] = valueFor(field.type);
        }
        const decoded = decodeApplicationEvent(abi, {
          topics,
          data: `0x${data.map((word) => word.slice(2)).join("")}` as Hex
        });
        assert.equal(decoded?.signature, declared.signature);
        assert.equal(decoded?.fields.length, declared.fields.length);
        count += 1;
      }
    }
    assert.equal(count, 11);
  });

  it("strictly decodes int, bool, address, bytes32 and every account class", () => {
    const topic0 = hash("Typed(int256,bool,address,bytes32,bytes32)");
    const typed = normalizeEventAbiDescriptor({
      format: "SwapVMEventABI",
      descriptorVersion: 1,
      codeHash: hash("typed-code"),
      standard: "Typed",
      version: 1,
      events: [{
        name: "Typed",
        signature: "Typed(int256,bool,address,bytes32,bytes32)",
        topic0,
        fields: [
          { name: "signed", type: "int256", indexed: true, position: 1 },
          { name: "truth", type: "bool", indexed: false, position: 0 },
          { name: "evm", type: "address", indexed: false, position: 1 },
          { name: "blob", type: "bytes32", indexed: false, position: 2 },
          { name: "who", type: "account", indexed: false, position: 3 }
        ]
      }]
    });
    const minusOne = `0x${"ff".repeat(32)}` as Bytes32;
    const boolWord = `0x${"00".repeat(31)}01`;
    const addressWord = `0x${"00".repeat(12)}${"12".repeat(20)}`;
    const contract = `0x01${"34".repeat(31)}` as Bytes32;
    const event = decodeApplicationEvent(typed, {
      topics: [topic0, minusOne],
      data: `${boolWord}${addressWord.slice(2)}${hash("blob").slice(2)}${contract.slice(2)}` as Hex
    });
    assert.equal(event?.fields[0]?.value, -1n);
    assert.equal(event?.fields[1]?.value, true);
    assert.equal(event?.fields[2]?.normalized, `0x${"12".repeat(20)}`);
    assert.equal(event?.fields[4]?.accountKind, "contract");
    assert.equal(classifyAccount(`0x${"00".repeat(32)}`), "zero");
    assert.equal(classifyAccount(`0x${"00".repeat(12)}${"11".repeat(20)}`), "EOA");
    assert.equal(classifyAccount(`0xff${"00".repeat(30)}01`), "Kernel");
    assert.equal(classifyAccount(`0x02${"00".repeat(31)}`), "unknown-tag");
  });

  it("rejects malformed descriptors and refuses partial event decoding", () => {
    const base = JSON.parse(canonicalDescriptorJson(descriptor("SRC-20"))) as Record<string, unknown>;
    assert.throws(
      () => normalizeEventAbiDescriptor({ ...base, descriptorVersion: 2 }),
      (error: unknown) => error instanceof EventAbiError && error.code === EventAbiErrorCode.UNSUPPORTED_DESCRIPTOR_VERSION
    );
    const events = structuredClone(base.events) as Array<Record<string, unknown>>;
    const firstFields = events[0]?.fields as Array<Record<string, unknown>>;
    if (firstFields?.[0] !== undefined) firstFields[0].type = "string";
    assert.throws(
      () => normalizeEventAbiDescriptor({ ...base, events }),
      (error: unknown) => error instanceof EventAbiError && error.code === EventAbiErrorCode.UNSUPPORTED_FIELD_TYPE
    );
    const transfer = descriptor("SRC-20").events[0];
    assert.notEqual(transfer, undefined);
    assert.throws(
      () => decodeApplicationEvent(descriptor("SRC-20"), { topics: [transfer!.topic0], data: "0x" }),
      (error: unknown) => error instanceof EventAbiError && error.code === EventAbiErrorCode.EVENT_TOPIC_COUNT_MISMATCH
    );
    assert.equal(decodeApplicationEvent(descriptor("SRC-20"), { topics: [hash("unknown")], data: "0x" }), null);
  });
});
