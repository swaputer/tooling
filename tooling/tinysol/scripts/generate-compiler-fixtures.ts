import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../src/abi.js";
import { bytesToHex } from "../src/bytes.js";
import { compileTinySol } from "../src/codegen.js";

const check = process.argv.includes("--check");
const examples = resolve(process.cwd(), "examples");
const fixtures = resolve(process.cwd(), "fixtures/compiler");
await mkdir(fixtures, { recursive: true });
const names = ["Counter", "Mapping", "EventDemo", "MiniToken", "MiniNFT", "Context", "NestedCaller", "Factory", "ControlFlow", "Conformance"];
for (const name of names) {
  const file = `${name}.tiny.sol`; const source = await readFile(resolve(examples, file), "utf8"); const result = compileTinySol(source, { sourceName: `examples/${file}` });
  const fixture = {
    name,
    source: `examples/${file}`,
    package: bytesToHex(result.packageBytes),
    code: result.codeHex,
    codeHash: result.codeHash,
    abi: result.abi,
    events: result.eventDescriptor,
    descriptorHash: result.descriptorHash,
    storageLayout: result.storageLayout,
    assembly: result.assembly,
    sourceMap: result.sourceMap,
    manifest: result.manifest
  };
  const encoded = `${canonicalJson(fixture)}\n`; const output = resolve(fixtures, `${name}.json`);
  if (check) {
    try { if (await readFile(output, "utf8") !== encoded) throw new Error(`COMPILER_FIXTURE_DRIFT:${name}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`COMPILER_FIXTURE_MISSING:${name}`); throw error; }
  } else await writeFile(output, encoded);
}
