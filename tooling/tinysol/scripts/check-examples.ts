import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileTinySol } from "../src/codegen.js";

const directory = resolve(process.cwd(), "examples");
const files = (await readdir(directory, { recursive: true })).filter((file) => file.endsWith(".tiny.sol")).sort();
if (files.length < 13) throw new Error("EXAMPLE_SET_MISMATCH");
const results = [];
for (const file of files) {
  const source = await readFile(resolve(directory, file), "utf8");
  const result = compileTinySol(source, { sourceName: `examples/${file}` });
  results.push({ file, codeHash: result.codeHash, codeLength: result.code.length, abiHash: result.abi.abiHash, descriptorHash: result.descriptorHash });
}
process.stdout.write(`${JSON.stringify(results)}\n`);
