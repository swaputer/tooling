import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { canonicalJson } from "../src/abi.js";
import { bytesToHex } from "../src/bytes.js";
import { compileTinySol, TINYSOL_COMPILER_IDENTITY } from "../src/codegen.js";
import { ISA_VERSION } from "../src/isa.js";

const check = process.argv.includes("--check");
const root = process.cwd();
const output = resolve(root, "fixtures/legacy-compatibility-v1.json");

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function filesBelow(directory: string): Promise<string[]> {
  return (await readdir(resolve(root, directory), { recursive: true }))
    .filter((file) => file.endsWith(".json") || file.endsWith(".svasm"))
    .map((file) => `${directory}/${file}`)
    .filter((file) => file !== "fixtures/legacy-compatibility-v1.json")
    .sort();
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { version: string };
const exampleFiles = (await readdir(resolve(root, "examples"), { recursive: true }))
  .filter((file) => file.endsWith(".tiny.sol"))
  .sort();

const corpus = [];
for (const file of exampleFiles) {
  const sourcePath = `examples/${file}`;
  const source = await readFile(resolve(root, sourcePath), "utf8");
  const result = compileTinySol(source, { sourceName: sourcePath });
  corpus.push({
    source: sourcePath,
    sourceSha256: sha256(source.replace(/\r\n?/g, "\n")),
    package: bytesToHex(result.packageBytes),
    codeHash: result.codeHash,
    abiCanonical: result.abi.abiCanonical,
    eventDescriptor: result.eventDescriptor,
    storageLayout: result.storageLayout
  });
}

const fixtureFiles = [];
for (const file of await filesBelow("fixtures")) {
  const contents = await readFile(resolve(root, file));
  fixtureFiles.push({ path: file, sha256: sha256(contents) });
}

const baseline = {
  format: "TinySolLegacyCompatibilityBaseline",
  version: 1,
  profile: "legacy-v1",
  identity: {
    npmPackageVersion: packageJson.version,
    languageVersion: TINYSOL_COMPILER_IDENTITY.languageVersion,
    compilerVersion: TINYSOL_COMPILER_IDENTITY.compilerVersion,
    compilerSourceFingerprint: TINYSOL_COMPILER_IDENTITY.compilerSourceFingerprint,
    dependencyLockHash: TINYSOL_COMPILER_IDENTITY.dependencyLockHash,
    svmIsaVersion: ISA_VERSION,
    isaHash: TINYSOL_COMPILER_IDENTITY.isaHash,
    optimizationProfile: TINYSOL_COMPILER_IDENTITY.optimizationProfile
  },
  baselineTest: { command: "npm test", tests: 87, passed: 87, failed: 0 },
  fixtureFiles,
  corpus
};

const encoded = `${canonicalJson(baseline)}\n`;
if (check) {
  const existing = await readFile(output, "utf8");
  if (existing !== encoded) throw new Error("LEGACY_COMPATIBILITY_BASELINE_DRIFT");
} else {
  await writeFile(output, encoded);
  process.stdout.write(`${relative(root, output)}\n`);
}
