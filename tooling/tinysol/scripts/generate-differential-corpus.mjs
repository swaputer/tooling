import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const outputPath = resolve(here, "../fixtures/differential-corpus.json");
const check = process.argv.includes("--check");
const isa = JSON.parse(await readFile(resolve(root, "docs/spec/SwapVM-ISA-v2.json"), "utf8"));

const definitions = new Map();
for (const item of isa.opcodes) {
  if (item.code !== undefined) {
    definitions.set(Number.parseInt(item.code.slice(2), 16), Number(item.immediateBytes));
  } else {
    const [firstText, lastText] = item.range.split("-");
    const first = Number.parseInt(firstText.slice(2), 16);
    const last = Number.parseInt(lastText.replace(/^0x/, ""), 16);
    for (let opcode = first; opcode <= last; opcode += 1) {
      definitions.set(opcode, typeof item.immediateBytes === "number" ? item.immediateBytes : opcode - 0x5f);
    }
  }
}

const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;
const codeCases = [];
for (let opcode = 0; opcode < 256; opcode += 1) {
  const immediate = definitions.get(opcode);
  if (immediate === undefined) {
    codeCases.push({ id: `unknown-${opcode.toString(16).padStart(2, "0")}`, bytes: hex([opcode]), accepted: false, error: "UnknownOpcode", offset: 0 });
  } else {
    codeCases.push({ id: `opcode-${opcode.toString(16).padStart(2, "0")}`, bytes: hex([opcode, ...new Array(immediate).fill(0)]), accepted: true, error: "", offset: 0 });
  }
}
for (let width = 1; width <= 32; width += 1) {
  codeCases.push({ id: `truncated-push${width}`, bytes: hex([0x5f + width, ...new Array(width - 1).fill(0)]), accepted: false, error: "TruncatedImmediate", offset: 0 });
}
codeCases.push(
  { id: "empty", bytes: "0x", accepted: false, error: "EmptyCode", offset: 0 },
  { id: "max-code", bytes: `0x${"00".repeat(16_384)}`, accepted: true, error: "", offset: 0 },
  { id: "over-max-code", bytes: `0x${"00".repeat(16_385)}`, accepted: false, error: "CodeTooLarge", offset: 0 },
  { id: "jumpdest-after-push", bytes: "0x61005b5b00", accepted: true, error: "", offset: 0 }
);

function packageBytes({ magic = "53564d31", version = 1, constructorEntry = 0, runtimeEntry = 0, code = "00", abiHash = "00".repeat(32), declaredLength } = {}) {
  const u16 = (value) => value.toString(16).padStart(4, "0");
  const length = declaredLength ?? code.length / 2;
  return `0x${magic}${u16(version)}${u16(constructorEntry)}${u16(runtimeEntry)}${u16(length)}${abiHash}${code}`;
}
const packageCases = [
  { id: "valid-stop", bytes: packageBytes(), accepted: true, error: "" },
  { id: "too-short", bytes: "0x53564d31", accepted: false, error: "InvalidPackageLength" },
  { id: "bad-magic", bytes: packageBytes({ magic: "00000000" }), accepted: false, error: "InvalidPackageMagic" },
  { id: "bad-version", bytes: packageBytes({ version: 2 }), accepted: false, error: "InvalidPackageVersion" },
  { id: "length-short", bytes: packageBytes({ declaredLength: 2 }), accepted: false, error: "InvalidPackageCodeLength" },
  { id: "length-trailing", bytes: packageBytes({ code: "0000", declaredLength: 1 }), accepted: false, error: "InvalidPackageCodeLength" },
  { id: "entry-out-of-range", bytes: packageBytes({ runtimeEntry: 1 }), accepted: false, error: "InvalidPackageEntry" },
  { id: "entry-inside-push", bytes: packageBytes({ code: "61000000", runtimeEntry: 1 }), accepted: false, error: "InvalidPackageEntry" }
];
for (const name of ["SRC20-v1", "SRC721-v1", "SRC1155-v1", "CPAMM-v1"]) {
  const artifact = JSON.parse(await readFile(resolve(root, `reference/${name}.json`), "utf8"));
  packageCases.push({ id: `reference-${name}`, bytes: artifact.package.toLowerCase(), accepted: true, error: "" });
}

const output = `${JSON.stringify({ version: 1, isaVersion: isa.version, codeCases, packageCases }, null, 2)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
if (check) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== output) throw new Error("DIFFERENTIAL_CORPUS_DRIFT");
} else {
  await writeFile(outputPath, output);
}
process.stdout.write(`Differential corpus: ${codeCases.length} code cases, ${packageCases.length} package cases verified\n`);
