import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  MiniVMErrorCode,
  compileTinySol,
  emptyMiniVMWorldState,
  encodeProgramPackageHex,
  functionSelector,
  simulateMiniVM,
  type Bytes32,
  type Hex,
  type MiniVMContextInput,
  type MiniVMWorldState
} from "../src/index.js";

const WORLD = `0x${"55".repeat(32)}` as Bytes32;
const SELLER = `0x${"00".repeat(12)}00000000000000000000000000000000000a11ce` as Bytes32;
const EXECUTOR = "0x0000000000000000000000000000000000000b02";
const context: MiniVMContextInput = Object.freeze({
  worldId: WORLD,
  executionHeight: "1",
  byteGasPrice: "1",
  buy: { ethAmountIn: "1", grossTokenOut: "1000000", tickAfter: 0, liquidityAfter: "1" },
  block: { number: "1", timestamp: "1" },
  tx: { executor: EXECUTOR }
});

const dishonestTokenSource = `
contract DishonestSRC20 {
  function transfer(account to, uint256 amount) returns (bool) { return true; }
  function transferFrom(account from, account to, uint256 amount) returns (bool) { return true; }
  function balanceOf(account owner) view returns (uint256) { return 0; }
  function decimals() view returns (uint256) { return 18; }
}`;

function word(value: bigint | string): string {
  const raw = typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "");
  return raw.padStart(64, "0");
}

function deploy(state: MiniVMWorldState, codeHash: Bytes32, payload: Hex = "0x") {
  return simulateMiniVM({
    state,
    action: { op: "DEPLOY", actor: SELLER, targetOrCodeHash: codeHash, payload, byteLimit: 1_000_000 },
    context
  });
}

for (const [directory, contractName] of [
  ["market-escrow", "MarketEscrow"],
  ["auction-escrow", "AuctionEscrow"]
] as const) {
  test(`${contractName} rejects a token that reports successful transfers without changing balances`, async () => {
    const escrowSource = await readFile(resolve("programs", directory, `${contractName}.tiny.sol`), "utf8");
    const token = compileTinySol(dishonestTokenSource, { sourceName: "test/DishonestSRC20.tiny.sol" });
    const escrow = compileTinySol(escrowSource, { sourceName: `programs/${directory}/${contractName}.tiny.sol` });
    const state: MiniVMWorldState = {
      ...emptyMiniVMWorldState(),
      packages: {
        [token.codeHash]: encodeProgramPackageHex(token.package),
        [escrow.codeHash]: encodeProgramPackageHex(escrow.package)
      }
    };

    const tokenDeployment = deploy(state, token.codeHash);
    assert.equal(tokenDeployment.success, true);
    const escrowDeployment = deploy(
      tokenDeployment.state,
      escrow.codeHash,
      `0x${word(tokenDeployment.rootTarget)}${word(EXECUTOR)}` as Hex
    );
    assert.equal(escrowDeployment.success, true);

    const amount = 100n * 10n ** 18n;
    const depositPayload = `${functionSelector("deposit(bytes32,uint256)")}${word(SELLER)}${word(amount)}` as Hex;
    const deposited = simulateMiniVM({
      state: escrowDeployment.state,
      action: {
        op: "CALL",
        actor: SELLER,
        targetOrCodeHash: escrowDeployment.rootTarget,
        payload: depositPayload,
        byteLimit: 1_000_000
      },
      context
    });

    assert.equal(deposited.success, false);
    assert.equal(deposited.error?.code, MiniVMErrorCode.EXPLICIT_REVERT);
    assert.deepEqual(deposited.storageDiff, []);
    assert.deepEqual(deposited.state, escrowDeployment.state);
  });
}
