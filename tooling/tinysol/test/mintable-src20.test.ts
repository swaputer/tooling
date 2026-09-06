import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  MiniVMErrorCode,
  bytesToHex,
  compileTinySol,
  functionSelector,
  programPackageCodeHash,
  simulateMiniVM,
  type Bytes32,
  type Hex,
  type MiniVMContextInput,
  type MiniVMWorldState
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const programDirectory = resolve(here, "../../programs/mintable-src20");
const WORLD = `0x${"11".repeat(32)}` as Bytes32;
const MINTER = `0x${"00".repeat(12)}00000000000000000000000000000000000a11ce` as Bytes32;
const OTHER_MINTER = `0x${"00".repeat(12)}000000000000000000000000000000000000b0b0` as Bytes32;
const RECIPIENT = `0x${"00".repeat(12)}000000000000000000000000000000000000beef` as Bytes32;
const ZERO = `0x${"00".repeat(32)}` as Bytes32;
const MINT_AMOUNT = 1_000n * 10n ** 18n;
const CAP = 10_000_000n * 10n ** 18n;
const ISSUED_SLOT = ZERO;
const context: MiniVMContextInput = Object.freeze({
  worldId: WORLD,
  executionHeight: "1",
  byteGasPrice: "11",
  buy: { ethAmountIn: "1", grossTokenOut: "1000000", tickAfter: 0, liquidityAfter: "1" },
  block: { number: "1", timestamp: "1" }
});

const word = (value: bigint): Bytes32 => `0x${value.toString(16).padStart(64, "0")}` as Bytes32;
const call = (signature: string, ...values: bigint[]): Hex =>
  `${functionSelector(signature)}${values.map((value) => word(value).slice(2)).join("")}` as Hex;

async function artifact(): Promise<{ packageHex: Hex; codeHash: Bytes32 }> {
  const packageHex = bytesToHex(await readFile(resolve(programDirectory, "MintableSRC20.svm"))) as Hex;
  const source = await readFile(resolve(programDirectory, "MintableSRC20.tiny.sol"), "utf8");
  const manifest = JSON.parse(await readFile(resolve(programDirectory, "MintableSRC20.manifest.json"), "utf8")) as {
    packageHash: Bytes32;
  };
  const rebuilt = compileTinySol(source, { sourceName: "programs/mintable-src20/MintableSRC20.tiny.sol" });
  assert.equal(bytesToHex(rebuilt.packageBytes), packageHex);
  assert.equal(programPackageCodeHash(packageHex), manifest.packageHash);
  return { packageHex, codeHash: manifest.packageHash };
}

function invoke(state: MiniVMWorldState, target: Bytes32, actor: Bytes32, payload: Hex) {
  return simulateMiniVM({
    state,
    action: { op: "CALL", actor, targetOrCodeHash: target, payload, byteLimit: 1_000_000 },
    context
  });
}

test("MintableSRC20 lets any actor mint exactly 1,000 tokens to any nonzero AccountId", async () => {
  const item = await artifact();
  const deployed = simulateMiniVM({
    state: { packages: { [item.codeHash]: item.packageHex }, programs: {}, storage: {}, creatorNonces: {} },
    action: { op: "DEPLOY", actor: MINTER, targetOrCodeHash: item.codeHash, payload: "0x", byteLimit: 1_000_000 },
    context
  });
  assert.equal(deployed.success, true);
  assert.equal(deployed.executedBytes, 13);

  const first = invoke(deployed.state, deployed.rootTarget, MINTER, call("mint(bytes32)", BigInt(RECIPIENT)));
  assert.equal(first.success, true);
  assert.equal(first.executedBytes, 278);
  assert.equal(first.output, word(MINT_AMOUNT));
  assert.equal(first.virtualRecords.length, 1);
  assert.deepEqual(first.virtualRecords[0], {
    emitter: deployed.rootTarget,
    topics: [bytesToHex(keccak_256(new TextEncoder().encode("Transfer(bytes32,bytes32,uint256)"))), ZERO, RECIPIENT],
    data: word(MINT_AMOUNT)
  });
  const second = invoke(first.state, deployed.rootTarget, OTHER_MINTER, call("mint(bytes32)", BigInt(RECIPIENT)));
  assert.equal(second.success, true);
  assert.equal(invoke(second.state, deployed.rootTarget, MINTER, call("totalSupply()")).output, word(2n * MINT_AMOUNT));
  assert.equal(
    invoke(second.state, deployed.rootTarget, MINTER, call("balanceOf(bytes32)", BigInt(RECIPIENT))).output,
    word(2n * MINT_AMOUNT)
  );
});

test("MintableSRC20 transfer preserves supply and emits the ordered virtual Transfer record", async () => {
  const item = await artifact();
  const deployed = simulateMiniVM({
    state: { packages: { [item.codeHash]: item.packageHex }, programs: {}, storage: {}, creatorNonces: {} },
    action: { op: "DEPLOY", actor: MINTER, targetOrCodeHash: item.codeHash, payload: "0x", byteLimit: 1_000_000 },
    context
  });
  assert.equal(deployed.success, true);
  const minted = invoke(deployed.state, deployed.rootTarget, OTHER_MINTER, call("mint(bytes32)", BigInt(RECIPIENT)));
  assert.equal(minted.success, true);
  const amount = 250n * 10n ** 18n;
  const transferred = invoke(
    minted.state,
    deployed.rootTarget,
    RECIPIENT,
    call("transfer(bytes32,uint256)", BigInt(MINTER), amount)
  );
  assert.equal(transferred.success, true);
  assert.equal(transferred.executedBytes, 396);
  assert.equal(transferred.output, word(1n));
  assert.equal(invoke(transferred.state, deployed.rootTarget, MINTER, call("totalSupply()")).output, word(MINT_AMOUNT));
  assert.deepEqual(transferred.virtualRecords[0]?.topics.slice(1), [RECIPIENT, MINTER]);
  assert.equal(transferred.virtualRecords[0]?.data, word(amount));
});

test("MintableSRC20 approve and transferFrom enforce allowance and roll back failed spends", async () => {
  const item = await artifact();
  const deployed = simulateMiniVM({
    state: { packages: { [item.codeHash]: item.packageHex }, programs: {}, storage: {}, creatorNonces: {} },
    action: { op: "DEPLOY", actor: MINTER, targetOrCodeHash: item.codeHash, payload: "0x", byteLimit: 1_000_000 },
    context
  });
  assert.equal(deployed.success, true);
  const minted = invoke(deployed.state, deployed.rootTarget, MINTER, call("mint(bytes32)", BigInt(RECIPIENT)));
  assert.equal(minted.success, true);

  const approvedAmount = 400n * 10n ** 18n;
  const approved = invoke(
    minted.state,
    deployed.rootTarget,
    RECIPIENT,
    call("approve(bytes32,uint256)", BigInt(OTHER_MINTER), approvedAmount)
  );
  assert.equal(approved.success, true);
  assert.equal(approved.output, word(1n));
  assert.deepEqual(approved.virtualRecords[0], {
    emitter: deployed.rootTarget,
    topics: [
      bytesToHex(keccak_256(new TextEncoder().encode("Approval(bytes32,bytes32,uint256)"))),
      RECIPIENT,
      OTHER_MINTER
    ],
    data: word(approvedAmount)
  });
  assert.equal(
    invoke(
      approved.state,
      deployed.rootTarget,
      MINTER,
      call("allowance(bytes32,bytes32)", BigInt(RECIPIENT), BigInt(OTHER_MINTER))
    ).output,
    word(approvedAmount)
  );

  const amount = 250n * 10n ** 18n;
  const spent = invoke(
    approved.state,
    deployed.rootTarget,
    OTHER_MINTER,
    call("transferFrom(bytes32,bytes32,uint256)", BigInt(RECIPIENT), BigInt(MINTER), amount)
  );
  assert.equal(spent.success, true);
  assert.equal(spent.output, word(1n));
  assert.deepEqual(spent.virtualRecords[0]?.topics.slice(1), [RECIPIENT, MINTER]);
  assert.equal(spent.virtualRecords[0]?.data, word(amount));
  assert.equal(
    invoke(
      spent.state,
      deployed.rootTarget,
      MINTER,
      call("allowance(bytes32,bytes32)", BigInt(RECIPIENT), BigInt(OTHER_MINTER))
    ).output,
    word(approvedAmount - amount)
  );
  assert.equal(
    invoke(spent.state, deployed.rootTarget, MINTER, call("balanceOf(bytes32)", BigInt(RECIPIENT))).output,
    word(MINT_AMOUNT - amount)
  );

  const unauthorized = invoke(
    spent.state,
    deployed.rootTarget,
    MINTER,
    call("transferFrom(bytes32,bytes32,uint256)", BigInt(RECIPIENT), BigInt(MINTER), 1n)
  );
  assert.equal(unauthorized.success, false);
  assert.deepEqual(unauthorized.storageDiff, []);
  assert.deepEqual(unauthorized.virtualRecords, []);
  assert.deepEqual(unauthorized.state, spent.state);

  const overAllowance = invoke(
    spent.state,
    deployed.rootTarget,
    OTHER_MINTER,
    call("transferFrom(bytes32,bytes32,uint256)", BigInt(RECIPIENT), BigInt(MINTER), approvedAmount)
  );
  assert.equal(overAllowance.success, false);
  assert.deepEqual(overAllowance.storageDiff, []);
  assert.deepEqual(overAllowance.virtualRecords, []);
  assert.deepEqual(overAllowance.state, spent.state);
});

test("MintableSRC20 cap and failed mint are atomic", async () => {
  const item = await artifact();
  const deployed = simulateMiniVM({
    state: { packages: { [item.codeHash]: item.packageHex }, programs: {}, storage: {}, creatorNonces: {} },
    action: { op: "DEPLOY", actor: MINTER, targetOrCodeHash: item.codeHash, payload: "0x", byteLimit: 1_000_000 },
    context
  });
  assert.equal(deployed.success, true);
  const nearCap: MiniVMWorldState = {
    ...deployed.state,
    storage: {
      ...deployed.state.storage,
      [deployed.rootTarget]: { ...deployed.state.storage[deployed.rootTarget], [ISSUED_SLOT]: word(CAP - MINT_AMOUNT) }
    }
  };
  const finalMint = invoke(nearCap, deployed.rootTarget, OTHER_MINTER, call("mint(bytes32)", BigInt(RECIPIENT)));
  assert.equal(finalMint.success, true);
  assert.equal(invoke(finalMint.state, deployed.rootTarget, MINTER, call("totalSupply()")).output, word(CAP));

  const rejected = invoke(finalMint.state, deployed.rootTarget, MINTER, call("mint(bytes32)", BigInt(RECIPIENT)));
  assert.equal(rejected.success, false);
  assert.equal(rejected.error?.code, MiniVMErrorCode.EXPLICIT_REVERT);
  assert.deepEqual(rejected.storageDiff, []);
  assert.deepEqual(rejected.virtualRecords, []);
  assert.deepEqual(rejected.state, finalMint.state);

  const zeroRecipient = invoke(deployed.state, deployed.rootTarget, MINTER, call("mint(bytes32)", 0n));
  assert.equal(zeroRecipient.success, false);
  assert.deepEqual(zeroRecipient.storageDiff, []);
  assert.deepEqual(zeroRecipient.virtualRecords, []);
});
