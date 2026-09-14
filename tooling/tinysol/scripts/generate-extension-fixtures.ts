import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "../src/abi.js";
import { bytesToHex } from "../src/bytes.js";
import { compileTinySol } from "../src/codegen.js";
import { compileTinySolProject } from "../src/project.js";
import { generateTypeScriptBindings } from "../src/bindings.js";

const check = process.argv.includes("--check"); const root = process.cwd(); const directory = resolve(root, "fixtures/extensions"); await mkdir(directory, { recursive: true });

async function output(path: string, value: string): Promise<void> {
  if (check) { if (await readFile(path, "utf8") !== value) throw new Error(`EXTENSION_FIXTURE_DRIFT:${path}`); }
  else await writeFile(path, value);
}

function fixture(name: string, result: ReturnType<typeof compileTinySol>, source: string) {
  return { name, source, package: bytesToHex(result.packageBytes), codeHash: result.codeHash, abi: result.abi, events: result.eventDescriptor, storageLayout: result.storageLayout, sourceMap: result.sourceMap, manifest: result.manifest };
}

for (const name of ["StructuredRegistry", "Voting"]) {
  const sourcePath = `examples/${name}.tiny.sol`; const source = await readFile(resolve(root, sourcePath), "utf8"); const result = compileTinySol(source, { sourceName: sourcePath });
  await output(resolve(directory, `${name}.json`), `${canonicalJson(fixture(name, result, sourcePath))}\n`);
}

const projectRoot = resolve(root, "examples/multifile-token"); const multi = await compileTinySolProject({ projectRoot, entry: "MultiFileToken.tiny.sol" });
await output(resolve(directory, "MultiFileToken.json"), `${canonicalJson(fixture("MultiFileToken", multi, "examples/multifile-token/MultiFileToken.tiny.sol"))}\n`);
await output(resolve(projectRoot, "MultiFileToken.bindings.ts"), generateTypeScriptBindings(multi.abi, multi.eventDescriptor));
if (!check) process.stdout.write("Extension fixtures: StructuredRegistry, Voting, MultiFileToken\n");
