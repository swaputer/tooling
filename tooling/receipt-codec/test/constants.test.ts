import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3";

import {
  KERNEL_EMITTER_ID,
  MAX_RECEIPT_PAYLOAD_BYTES,
  MAX_RECEIPT_RECORDS,
  MAX_RECORD_DATA_BYTES,
  MAX_RECORD_TOPICS,
  MINI_CONTRACT_DEPLOYED_SIGNATURE,
  MINI_CONTRACT_DEPLOYED_TOPIC,
  RECEIPT_VERSION,
  WORLD_EXECUTION_SIGNATURE,
  WORLD_EXECUTION_TOPIC
} from "../src/index.js";

function hash(signature: string): string {
  return `0x${Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex")}`;
}

function capture(source: string, expression: RegExp, label: string): string {
  const value = source.match(expression)?.[1];
  assert.notEqual(value, undefined, label);
  return value?.replaceAll("_", "") ?? "";
}

describe("generated constants stay bound to Solidity source", () => {
  it("matches Kernel IDs/signatures and MiniVM receipt limits", async () => {
    const repositoryRoot = resolve(process.cwd(), "../..");
    const kernel = await readFile(resolve(repositoryRoot, "src/SwapVMKernel.sol"), "utf8");
    const miniVm = await readFile(resolve(repositoryRoot, "src/SwapVMMiniVM.sol"), "utf8");
    const spec = await readFile(resolve(repositoryRoot, "docs/spec/SwapVM-v1.1-frozen-spec.md"), "utf8");

    assert.equal(Number(capture(kernel, /RECEIPT_VERSION\s*=\s*(\d+)/, "receipt version")), RECEIPT_VERSION);
    assert.equal(
      capture(kernel, /KERNEL_EMITTER_ID\s*=\s*(0x[0-9a-fA-F]{64})/, "Kernel emitter").toLowerCase(),
      KERNEL_EMITTER_ID
    );
    assert.ok(kernel.includes(`keccak256("${WORLD_EXECUTION_SIGNATURE}")`));
    assert.ok(kernel.includes(`keccak256("${MINI_CONTRACT_DEPLOYED_SIGNATURE}")`));
    assert.equal(hash(WORLD_EXECUTION_SIGNATURE), WORLD_EXECUTION_TOPIC);
    assert.equal(hash(MINI_CONTRACT_DEPLOYED_SIGNATURE), MINI_CONTRACT_DEPLOYED_TOPIC);
    assert.equal(
      Number(capture(miniVm, /MAX_RECEIPT_RECORDS\s*=\s*([\d_]+)/, "max records")),
      MAX_RECEIPT_RECORDS
    );
    assert.equal(
      Number(capture(miniVm, /MAX_RECORD_DATA_BYTES\s*=\s*([\d_]+)/, "max data")),
      MAX_RECORD_DATA_BYTES
    );
    assert.equal(
      Number(capture(miniVm, /MAX_RECEIPT_PAYLOAD_BYTES\s*=\s*([\d_]+)/, "max payload")),
      MAX_RECEIPT_PAYLOAD_BYTES
    );
    assert.match(spec, new RegExp(`version\\s+uint8\\s+=\\s+${RECEIPT_VERSION}`));
    assert.match(spec, new RegExp(`maximum\\s+${MAX_RECORD_TOPICS}\\s+mini topics per record`));
    assert.match(spec, /maximum\s+4,096\s+data bytes per record/);
    assert.match(spec, /maximum\s+64\s+records per VM execution/);
    assert.match(spec, /maximum\s+65,536\s+encoded `payload` bytes/);
  });
});
