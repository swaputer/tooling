import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ToolchainError,
  ToolchainErrorCode,
  assemble,
  canonicalAbiJson,
  encodeBuildManifest,
  eventTopic,
  exactUtf8AbiHash,
  functionSelector,
  interfaceId,
  validateEventSignature,
  validateFunctionSignature
} from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(packageRoot, "../..");

test("ABI helpers exactly match all reference selectors, topics, hashes and interface IDs", async () => {
  for (const name of ["SRC20-v1", "SRC721-v1", "SRC1155-v1", "CPAMM-v1"]) {
    const artifact = JSON.parse(await readFile(resolve(repositoryRoot, `reference/${name}.json`), "utf8")) as {
      abiCanonical: string;
      abiHash: string;
      interfaceId: string;
      selectors: Record<string, string>;
      eventTopics: Record<string, string>;
    };
    assert.equal(exactUtf8AbiHash(artifact.abiCanonical), artifact.abiHash);
    for (const [signature, selector] of Object.entries(artifact.selectors)) assert.equal(functionSelector(signature), selector);
    for (const [signature, topic] of Object.entries(artifact.eventTopics)) assert.equal(eventTopic(signature), topic);
    assert.equal(interfaceId(Object.keys(artifact.selectors).filter((signature) => signature !== "supportsInterface(bytes4)")), artifact.interfaceId);
  }
});

test("canonical signatures reject aliases, whitespace and malformed forms", () => {
  assert.equal(validateFunctionSignature("transfer(bytes32,uint256)").name, "transfer");
  assert.equal(validateEventSignature("Transfer(bytes32,bytes32,uint256)").parameterTypes.length, 3);
  for (const signature of ["transfer(bytes32,uint)", "transfer( bytes32)", "1bad()", "bad", "bad(account)", "bad(uint7)"]) {
    assert.throws(() => validateFunctionSignature(signature), (error: unknown) => error instanceof ToolchainError && error.code === ToolchainErrorCode.INVALID_SIGNATURE);
  }
});

test("canonical JSON recursively sorts keys and is deterministic", () => {
  assert.equal(canonicalAbiJson({ z: 1, a: { y: true, b: [2, 1] } }), '{"a":{"b":[2,1],"y":true},"z":1}');
});

test("sidecar manifest is reproducible and contains no machine or time data", () => {
  const source = ".constructor c\n.runtime c\nc:\nSTOP\n";
  const first = assemble(source);
  const second = assemble(source);
  const encoded = encodeBuildManifest(first.manifest);
  assert.equal(encoded, encodeBuildManifest(second.manifest));
  assert.equal(first.manifest.codeHash, first.manifest.packageHash);
  assert.equal(first.manifest.consensusEncoding, false);
  assert.ok(!encoded.includes(process.cwd()));
  assert.ok(!encoded.includes("timestamp"));
  assert.ok(!encoded.includes("createdAt"));
});
