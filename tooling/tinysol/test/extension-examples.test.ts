import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { compileTinySol } from "../src/codegen.js";
import { compileTinySolProject } from "../src/project.js";
import { functionSelector } from "../src/abi.js";
import { encodeProgramPackageHex } from "../src/package.js";
import { emptyMiniVMWorldState, type MiniVMContextInput, type MiniVMWorldState } from "../src/simulator-types.js";
import { simulateMiniVM } from "../src/simulator.js";
import type { Bytes32, Hex } from "../src/bytes.js";

const ACTOR = `0x${"00".repeat(12)}${"aa".repeat(20)}` as Bytes32;
const OTHER = `0x${"00".repeat(12)}${"bb".repeat(20)}` as Bytes32;
const context: MiniVMContextInput = { worldId: `0x${"cc".repeat(32)}` as Bytes32, executionHeight: "1", byteGasPrice: "1", buy: { ethAmountIn: "0", grossTokenOut: "0", tickAfter: 0, liquidityAfter: "0" }, block: { number: "1", timestamp: "1" } };
const word = (value: bigint | string) => (typeof value === "bigint" ? value.toString(16) : value.slice(2)).padStart(64, "0");
const payload = (signature: string, ...values: (bigint | string)[]): Hex => `${functionSelector(signature)}${values.map(word).join("")}` as Hex;

function installed(build: ReturnType<typeof compileTinySol>): MiniVMWorldState {
  return { ...emptyMiniVMWorldState(), packages: { [build.codeHash]: encodeProgramPackageHex(build.package) } };
}

function deploy(build: ReturnType<typeof compileTinySol>, actor = ACTOR) {
  return simulateMiniVM({ state: installed(build), action: { op: "DEPLOY", actor, targetOrCodeHash: build.codeHash, payload: "0x", byteLimit: 1_000_000 }, context });
}

function call(state: MiniVMWorldState, target: Bytes32, signature: string, values: (bigint | string)[] = [], actor = ACTOR) {
  return simulateMiniVM({ state, action: { op: "CALL", actor, targetOrCodeHash: target, payload: payload(signature, ...values), byteLimit: 1_000_000 }, context });
}

describe("required extension examples", () => {
  it("StructuredRegistry stores and returns a flattened bounded record", async () => {
    const build = compileTinySol(await readFile(resolve("examples/StructuredRegistry.tiny.sol"), "utf8")); const deployed = deploy(build); assert.equal(deployed.success, true);
    const set = call(deployed.state, deployed.rootTarget, "set(uint256,bytes32,uint256,uint256)", [2n, ACTOR, 77n, 1n]); assert.equal(set.success, true); assert.equal(set.virtualRecords.length, 1);
    const get = call(set.state, deployed.rootTarget, "get(uint256)", [2n]); assert.equal(get.success, true); assert.equal(get.output, `0x${word(ACTOR)}${word(77n)}${word(1n)}`);
  });

  it("Voting executes bounded set, page and remove atomically", async () => {
    const build = compileTinySol(await readFile(resolve("examples/Voting.tiny.sol"), "utf8")); const deployed = deploy(build); assert.equal(deployed.success, true);
    const set = call(deployed.state, deployed.rootTarget, "set(uint256,bytes32,uint256,bool)", [9n, ACTOR, 0n, 1n]); assert.equal(set.success, true);
    const page = call(set.state, deployed.rootTarget, "page(uint256,uint256)", [0n, 2n]); assert.equal(page.output, `0x${word(9n)}${word(0n)}${word(1n)}${word(1n)}`);
    const unauthorized = call(set.state, deployed.rootTarget, "remove(uint256)", [9n], OTHER); assert.equal(unauthorized.success, false); assert.deepEqual(unauthorized.storageDiff, []);
    const removed = call(set.state, deployed.rootTarget, "remove(uint256)", [9n]); assert.equal(removed.success, true);
    const contains = call(removed.state, deployed.rootTarget, "contains(uint256)", [9n]); assert.equal(contains.output, `0x${word(0n)}`);
  });

  it("MultiFileToken links its library, exposes bindings and returns named errors", async () => {
    const build = await compileTinySolProject({ projectRoot: resolve("examples/multifile-token"), entry: "MultiFileToken.tiny.sol" }); const deployed = deploy(build); assert.equal(deployed.success, true);
    const denied = call(deployed.state, deployed.rootTarget, "mint(bytes32,uint256)", [OTHER, 5n], OTHER); assert.equal(denied.success, false); assert.equal(denied.revertData.slice(0, 10), build.abi.errors?.find((item) => item.name === "Unauthorized")?.selector);
    const minted = call(deployed.state, deployed.rootTarget, "mint(bytes32,uint256)", [OTHER, 5n]); assert.equal(minted.success, true); assert.equal(minted.output, `0x${word(5n)}`);
    const binding = await readFile(resolve("examples/multifile-token/MultiFileToken.bindings.ts"), "utf8"); assert.match(binding, /callMint/); assert.match(binding, /decodeTransferEvent/);
  });
});
