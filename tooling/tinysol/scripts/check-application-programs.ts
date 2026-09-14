import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTinySol, encodeCompilerArtifact } from "../src/index.js";

const tinysolRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

const programs = Object.freeze([
  Object.freeze({ directory: "market-escrow", contract: "MarketEscrow" }),
  Object.freeze({ directory: "mintable-src20", contract: "MintableSRC20" }),
  Object.freeze({ directory: "open-mint-src20", contract: "OpenMintSRC20" }),
  Object.freeze({ directory: "seth", contract: "SETH" })
]);

async function checkProgram(directory: string, contract: string): Promise<string> {
  const root = resolve(tinysolRoot, "programs", directory);
  const sourcePath = resolve(root, `${contract}.tiny.sol`);
  const source = await readFile(sourcePath, "utf8");
  const compiled = compileTinySol(source, { sourceName: basename(sourcePath) });
  const existingManifest = JSON.parse(await readFile(resolve(root, `${contract}.manifest.json`), "utf8")) as { compiler: typeof compiled.manifest.compiler };
  const compatibilityManifest = { ...compiled.manifest, compiler: existingManifest.compiler };
  const expected = new Map<string, string | Uint8Array>([
    [`${contract}.svm`, compiled.packageBytes],
    [`${contract}.abi.json`, encodeCompilerArtifact(compiled.abi)],
    [`${contract}.events.json`, encodeCompilerArtifact(compiled.eventDescriptor)],
    [`${contract}.storage.json`, encodeCompilerArtifact(compiled.storageLayout)],
    [`${contract}.manifest.json`, encodeCompilerArtifact(compatibilityManifest)],
    [`${contract}.svasm`, compiled.assembly],
    [`${contract}.map.json`, encodeCompilerArtifact(compiled.sourceMap)]
  ]);

  for (const [name, value] of expected) {
    const actual = await readFile(resolve(root, name));
    const wanted = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    assert.deepEqual(
      actual,
      wanted,
      `${directory}/${name} is stale; regenerate the complete artifact set with tinysol compile --force`
    );
  }

  return `${contract} ${compiled.codeHash}`;
}

const checked = await Promise.all(programs.map(({ directory, contract }) => checkProgram(directory, contract)));
process.stdout.write(`Application programs: ${checked.join(", ")} verified\n`);
