import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
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

const WORLD = `0x${"44".repeat(32)}` as Bytes32;
const ACTOR = `0x${"00".repeat(12)}00000000000000000000000000000000000a11ce` as Bytes32;
const OTHER = `0x${"00".repeat(12)}0000000000000000000000000000000000000b0b` as Bytes32;
const TEXT = `0x${Buffer.from("Ship TinySol").toString("hex").padEnd(64, "0")}` as Bytes32;
const context: MiniVMContextInput = Object.freeze({
  worldId: WORLD,
  executionHeight: "12",
  byteGasPrice: "1",
  buy: { ethAmountIn: "1", grossTokenOut: "1000000", tickAfter: 0, liquidityAfter: "1" },
  block: { number: "100", timestamp: "200" }
});

type Build = ReturnType<typeof compileTinySol>;

function word(value: bigint | string): string {
  const raw = typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "");
  return raw.padStart(64, "0");
}

function payload(signature: string, ...values: (bigint | string)[]): Hex {
  return `${functionSelector(signature)}${values.map(word).join("")}` as Hex;
}

function stateWith(...builds: Build[]): MiniVMWorldState {
  return {
    ...emptyMiniVMWorldState(),
    packages: Object.fromEntries(builds.map((build) => [build.codeHash, encodeProgramPackageHex(build.package)]))
  };
}

function deploy(state: MiniVMWorldState, build: Build, constructorArgs: Hex = "0x", actor = ACTOR) {
  return simulateMiniVM({
    state,
    action: { op: "DEPLOY", actor, targetOrCodeHash: build.codeHash, payload: constructorArgs, byteLimit: 1_000_000 },
    context
  });
}

function call(
  state: MiniVMWorldState,
  target: Bytes32,
  signature: string,
  values: (bigint | string)[] = [],
  actor = ACTOR
) {
  return simulateMiniVM({
    state,
    action: { op: "CALL", actor, targetOrCodeHash: target, payload: payload(signature, ...values), byteLimit: 1_000_000 },
    context
  });
}

async function classic(name: string): Promise<Build> {
  const source = await readFile(resolve("examples/solidity-classics", `${name}.tiny.sol`), "utf8");
  return compileTinySol(source, { sourceName: `examples/solidity-classics/${name}.tiny.sol` });
}

describe("classic Solidity patterns execute as TinySol Mini Contracts", () => {
  it("compiles deterministic packages for all classic examples", async () => {
    for (const name of ["SimpleStorage", "TodoList", "Ballot", "OwnableVault"]) {
      const first = await classic(name);
      const second = await classic(name);
      assert.equal(first.codeHash, second.codeHash, name);
      assert.deepEqual(first.packageBytes, second.packageBytes, name);
    }
  });

  it("SimpleStorage persists state and emits the actor-bound change event", async () => {
    const build = await classic("SimpleStorage");
    const deployed = deploy(stateWith(build), build);
    assert.equal(deployed.success, true);

    const updated = call(deployed.state, deployed.rootTarget, "set(uint256)", [42n]);
    assert.equal(updated.success, true);
    assert.equal(updated.output, `0x${word(42n)}`);
    assert.equal(updated.virtualRecords.length, 1);
    assert.equal(updated.virtualRecords[0]?.topics[1], ACTOR);

    const read = call(updated.state, deployed.rootTarget, "get()");
    assert.equal(read.success, true);
    assert.equal(read.output, `0x${word(42n)}`);
  });

  it("Counter deploys with constructor state and increments through the runtime dispatcher", async () => {
    const source = await readFile(resolve("examples/Counter.tiny.sol"), "utf8");
    const build = compileTinySol(source, { sourceName: "examples/Counter.tiny.sol" });
    const deployed = deploy(stateWith(build), build, `0x${word(5n)}` as Hex);
    assert.equal(deployed.success, true);

    const incremented = call(deployed.state, deployed.rootTarget, "increment(uint256)", [3n]);
    assert.equal(incremented.success, true);
    assert.equal(incremented.output, `0x${word(8n)}`);

    const read = call(incremented.state, deployed.rootTarget, "get()");
    assert.equal(read.output, `0x${word(8n)}`);
  });

  it("TodoList creates, reads and toggles tasks while invalid IDs roll back", async () => {
    const build = await classic("TodoList");
    const deployed = deploy(stateWith(build), build);
    const created = call(deployed.state, deployed.rootTarget, "createTask(bytes32)", [TEXT]);
    assert.equal(created.success, true);
    assert.equal(created.output, `0x${word(0n)}`);

    const initial = call(created.state, deployed.rootTarget, "get(uint256)", [0n]);
    assert.equal(initial.output, `0x${word(TEXT)}${word(0n)}`);

    const toggled = call(created.state, deployed.rootTarget, "toggle(uint256)", [0n]);
    assert.equal(toggled.success, true);
    assert.equal(toggled.output, `0x${word(1n)}`);

    const invalid = call(toggled.state, deployed.rootTarget, "toggle(uint256)", [1n]);
    assert.equal(invalid.success, false);
    assert.equal(invalid.error?.code, MiniVMErrorCode.EXPLICIT_REVERT);
    assert.deepEqual(invalid.storageDiff, []);

    const unchanged = call(invalid.state, deployed.rootTarget, "get(uint256)", [0n]);
    assert.equal(unchanged.output, `0x${word(TEXT)}${word(1n)}`);
  });

  it("Ballot enforces one vote per account and counts independent proposals", async () => {
    const build = await classic("Ballot");
    const deployed = deploy(stateWith(build), build, `0x${word(3n)}` as Hex);
    const firstVote = call(deployed.state, deployed.rootTarget, "vote(uint256)", [1n], ACTOR);
    assert.equal(firstVote.success, true);
    const secondVote = call(firstVote.state, deployed.rootTarget, "vote(uint256)", [1n], OTHER);
    assert.equal(secondVote.success, true);
    assert.equal(secondVote.output, `0x${word(2n)}`);

    const duplicate = call(secondVote.state, deployed.rootTarget, "vote(uint256)", [2n], ACTOR);
    assert.equal(duplicate.success, false);
    assert.equal(duplicate.error?.code, MiniVMErrorCode.EXPLICIT_REVERT);
    assert.deepEqual(duplicate.storageDiff, []);

    const proposalOne = call(duplicate.state, deployed.rootTarget, "votes(uint256)", [1n]);
    const proposalTwo = call(duplicate.state, deployed.rootTarget, "votes(uint256)", [2n]);
    const actorVoted = call(duplicate.state, deployed.rootTarget, "hasVoted(bytes32)", [ACTOR]);
    assert.equal(proposalOne.output, `0x${word(2n)}`);
    assert.equal(proposalTwo.output, `0x${word(0n)}`);
    assert.equal(actorVoted.output, `0x${word(1n)}`);
  });

  it("OwnableVault pulls real SRC20 balances, rejects non-owners and releases to a recipient", async () => {
    const tokenSource = await readFile(resolve("programs/mintable-src20/MintableSRC20.tiny.sol"), "utf8");
    const tokenBuild = compileTinySol(tokenSource, { sourceName: "programs/mintable-src20/MintableSRC20.tiny.sol" });
    const vaultBuild = await classic("OwnableVault");
    const base = stateWith(tokenBuild, vaultBuild);
    const tokenDeployment = deploy(base, tokenBuild);
    assert.equal(tokenDeployment.success, true);
    const vaultDeployment = deploy(
      tokenDeployment.state,
      vaultBuild,
      `0x${word(tokenDeployment.rootTarget)}${word(ACTOR)}` as Hex
    );
    assert.equal(vaultDeployment.success, true);

    const minted = call(vaultDeployment.state, tokenDeployment.rootTarget, "mint(bytes32)", [ACTOR]);
    assert.equal(minted.success, true);
    const depositAmount = 400n * 10n ** 18n;
    const withdrawalAmount = 150n * 10n ** 18n;
    const approved = call(
      minted.state,
      tokenDeployment.rootTarget,
      "approve(bytes32,uint256)",
      [vaultDeployment.rootTarget, depositAmount]
    );
    assert.equal(approved.success, true);

    const deposited = call(approved.state, vaultDeployment.rootTarget, "deposit(uint256)", [depositAmount]);
    assert.equal(deposited.success, true);
    assert.equal(deposited.output, `0x${word(depositAmount)}`);
    assert.equal(deposited.virtualRecords.length, 2);

    const rejected = call(
      deposited.state,
      vaultDeployment.rootTarget,
      "withdraw(bytes32,uint256)",
      [OTHER, withdrawalAmount],
      OTHER
    );
    assert.equal(rejected.success, false);
    assert.equal(rejected.error?.code, MiniVMErrorCode.EXPLICIT_REVERT);
    assert.deepEqual(rejected.storageDiff, []);

    const withdrawn = call(
      rejected.state,
      vaultDeployment.rootTarget,
      "withdraw(bytes32,uint256)",
      [OTHER, withdrawalAmount]
    );
    assert.equal(withdrawn.success, true);
    assert.equal(withdrawn.output, `0x${word(depositAmount - withdrawalAmount)}`);

    const recipientBalance = call(withdrawn.state, tokenDeployment.rootTarget, "balanceOf(bytes32)", [OTHER]);
    const vaultBalance = call(withdrawn.state, vaultDeployment.rootTarget, "balance()");
    assert.equal(recipientBalance.output, `0x${word(withdrawalAmount)}`);
    assert.equal(vaultBalance.output, `0x${word(depositAmount - withdrawalAmount)}`);
  });
});
