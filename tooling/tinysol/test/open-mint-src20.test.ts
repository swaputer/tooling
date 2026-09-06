import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bytesToHex,
  functionSelector,
  programPackageCodeHash,
  simulateMiniVM,
  type Bytes32,
  type Hex,
  type MiniVMContextInput,
  type MiniVMWorldState
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const programDirectory = resolve(here, "../../programs/open-mint-src20");
const WORLD = `0x${"11".repeat(32)}` as Bytes32;
const CREATOR = `0x${"00".repeat(12)}00000000000000000000000000000000000a11ce` as Bytes32;
const RECIPIENT = `0x${"00".repeat(12)}000000000000000000000000000000000000beef` as Bytes32;
const context: MiniVMContextInput = Object.freeze({
  worldId: WORLD,
  executionHeight: "1",
  byteGasPrice: "11",
  buy: { ethAmountIn: "1", grossTokenOut: "1000000", tickAfter: 0, liquidityAfter: "1" },
  block: { number: "1", timestamp: "1" }
});

const word = (value: bigint): Bytes32 => `0x${value.toString(16).padStart(64, "0")}` as Bytes32;
const textWord = (value: string): Bytes32 => {
  const encoded = bytesToHex(new TextEncoder().encode(value)).slice(2);
  return `0x${encoded.padEnd(64, "0")}` as Bytes32;
};
const call = (signature: string, ...values: bigint[]): Hex =>
  `${functionSelector(signature)}${values.map((value) => word(value).slice(2)).join("")}` as Hex;

async function artifact() {
  const packageHex = bytesToHex(await readFile(resolve(programDirectory, "OpenMintSRC20.svm"))) as Hex;
  return { packageHex, codeHash: programPackageCodeHash(packageHex) };
}

function invoke(state: MiniVMWorldState, target: Bytes32, payload: Hex) {
  return simulateMiniVM({ state, action: { op: "CALL", actor: CREATOR, targetOrCodeHash: target, payload, byteLimit: 1_000_000 }, context });
}

test("OpenMintSRC20 applies constructor metadata, supply and mint amount", async () => {
  const item = await artifact();
  const name = textWord("Community Token");
  const symbol = textWord("COM");
  const cap = 10_000n * 10n ** 18n;
  const mintAmount = 250n * 10n ** 18n;
  const payload = `${name}${symbol.slice(2)}${word(cap).slice(2)}${word(mintAmount).slice(2)}` as Hex;
  const deployed = simulateMiniVM({
    state: { packages: { [item.codeHash]: item.packageHex }, programs: {}, storage: {}, creatorNonces: {} },
    action: { op: "DEPLOY", actor: CREATOR, targetOrCodeHash: item.codeHash, payload, byteLimit: 1_000_000 },
    context
  });
  assert.equal(deployed.success, true);
  assert.equal(invoke(deployed.state, deployed.rootTarget, call("name()")).output, name);
  assert.equal(invoke(deployed.state, deployed.rootTarget, call("symbol()")).output, symbol);
  assert.equal(invoke(deployed.state, deployed.rootTarget, call("cap()")).output, word(cap));
  assert.equal(invoke(deployed.state, deployed.rootTarget, call("mintAmount()")).output, word(mintAmount));
  const minted = invoke(deployed.state, deployed.rootTarget, call("mint(bytes32)", BigInt(RECIPIENT)));
  assert.equal(minted.success, true);
  assert.equal(minted.output, word(mintAmount));
  assert.equal(invoke(minted.state, deployed.rootTarget, call("totalSupply()")).output, word(mintAmount));
});

test("OpenMintSRC20 rejects invalid constructor supply atomically", async () => {
  const item = await artifact();
  const payload = `${textWord("Bad")}${textWord("BAD").slice(2)}${word(1n).slice(2)}${word(2n).slice(2)}` as Hex;
  const initial = { packages: { [item.codeHash]: item.packageHex }, programs: {}, storage: {}, creatorNonces: {} };
  const deployed = simulateMiniVM({
    state: initial,
    action: { op: "DEPLOY", actor: CREATOR, targetOrCodeHash: item.codeHash, payload, byteLimit: 1_000_000 },
    context
  });
  assert.equal(deployed.success, false);
  assert.deepEqual(deployed.deploymentDiff, []);
  assert.deepEqual(deployed.storageDiff, []);
  assert.deepEqual(deployed.state, initial);
});
