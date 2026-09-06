import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const outputDirectory = resolve(here, "../fixtures/reference");
const names = ["SRC20-v1", "SRC721-v1", "SRC1155-v1", "CPAMM-v1"];
const check = process.argv.includes("--check");

function expandIsa(document) {
  const namesByOpcode = new Map();
  for (const item of document.opcodes) {
    if (item.code !== undefined) {
      namesByOpcode.set(Number.parseInt(item.code.slice(2), 16), { name: item.name, immediate: Number(item.immediateBytes) });
      continue;
    }
    const [firstText, lastText] = item.range.split("-");
    const first = Number.parseInt(firstText.slice(2), 16);
    const last = Number.parseInt(lastText.replace(/^0x/, ""), 16);
    const prefix = item.name.split("..")[0].replace(/[0-9]+$/, "");
    const initial = Number(item.name.match(/(\d+)\.\./)[1]);
    for (let opcode = first; opcode <= last; opcode += 1) {
      const immediate = typeof item.immediateBytes === "number" ? item.immediateBytes : opcode - 0x5f;
      namesByOpcode.set(opcode, { name: `${prefix}${initial + opcode - first}`, immediate });
    }
  }
  return namesByOpcode;
}

function disassemble(artifact, table) {
  const code = Buffer.from(artifact.code.slice(2), "hex");
  const lines = [
    ".constructor __constructor",
    ".runtime __runtime",
    `.abi-hash ${artifact.abiHash.toLowerCase()}`,
    ".code"
  ];
  let offset = 0;
  while (offset < code.length) {
    if (offset === artifact.constructorEntry) lines.push("__constructor:");
    if (offset === artifact.runtimeEntry) lines.push("__runtime:");
    const definition = table.get(code[offset]);
    if (definition === undefined || offset + 1 + definition.immediate > code.length) throw new Error(`invalid reference opcode at ${offset}`);
    if (definition.immediate === 0) {
      lines.push(definition.name);
    } else {
      lines.push(`${definition.name} 0x${code.subarray(offset + 1, offset + 1 + definition.immediate).toString("hex")}`);
    }
    offset += 1 + definition.immediate;
  }
  return `${lines.join("\n")}\n`;
}

const isa = JSON.parse(await readFile(resolve(root, "docs/spec/SwapVM-ISA-v2.json"), "utf8"));
const table = expandIsa(isa);
await mkdir(outputDirectory, { recursive: true });
for (const name of names) {
  const artifact = JSON.parse(await readFile(resolve(root, `reference/${name}.json`), "utf8"));
  const output = disassemble(artifact, table);
  const path = resolve(outputDirectory, `${name}.svasm`);
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== output) throw new Error(`REFERENCE_ASSEMBLY_DRIFT:${name}`);
  } else {
    await writeFile(path, output);
  }
}
process.stdout.write(`Reference assembly: ${names.length} fixtures verified\n`);
