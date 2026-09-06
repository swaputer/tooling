import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const isaPath = resolve(root, "docs/spec/SwapVM-ISA-v2.json");
const manifestPath = resolve(root, "docs/spec/SwapVM-v1.2-freeze-manifest.json");
const solidityPath = resolve(root, "src/SwapVMMiniVM.sol");
const outputPath = resolve(here, "../src/generated-isa.ts");
const check = process.argv.includes("--check");

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function hex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function parseByte(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{2}$/.test(value)) fail("ISA_SCHEMA_INVALID", { value });
  return Number.parseInt(value.slice(2), 16);
}

function numeric(value, opcode, kind) {
  if (Number.isInteger(value)) return value;
  if (kind === "immediate" && value === "code-0x5f") return opcode - 0x5f;
  if (kind === "pops" && value === "2+(code-0xa0)") return 2 + opcode - 0xa0;
  fail("ISA_SCHEMA_INVALID", { value: String(value), opcode });
}

function expandedName(pattern, index) {
  const match = /^(.*?)(\d+)\.\.(.*?)(\d+)$/.exec(pattern);
  if (match === null || match[1] !== match[3]) fail("ISA_SCHEMA_INVALID", { pattern });
  return `${match[1]}${Number(match[2]) + index}`;
}

function defaultSignature(mnemonic, pops, pushes) {
  const dup = /^DUP(\d+)$/.exec(mnemonic);
  if (dup !== null) {
    const depth = Number(dup[1]);
    const inputs = Array.from({ length: depth }, (_, index) => `v${depth - index}`);
    return `(${inputs.join(",")})->(${[...inputs, `v${depth}`].join(",")})`;
  }
  const swap = /^SWAP(\d+)$/.exec(mnemonic);
  if (swap !== null) {
    const depth = Number(swap[1]);
    const middle = Array.from({ length: Math.max(0, depth - 1) }, (_, index) => `v${depth - index - 1}`);
    return `(${[`v${depth}`, ...middle, "v0"].join(",")})->(${["v0", ...middle, `v${depth}`].join(",")})`;
  }
  const inputs = Array.from({ length: pops }, (_, index) => `arg${pops - index - 1}`).join(",");
  const outputs = Array.from({ length: pushes }, (_, index) => `result${index}`).join(",");
  return `(${inputs})->(${outputs})`;
}

function expandIsa(document) {
  if (document.version !== 2 || !Array.isArray(document.opcodes)) fail("ISA_SCHEMA_INVALID");
  const definitions = [];
  const opcodes = new Set();
  const mnemonics = new Set();
  for (const raw of document.opcodes) {
    const start = raw.code === undefined ? parseByte(raw.range.split("-")[0]) : parseByte(raw.code);
    const end = raw.code === undefined ? parseByte(`0x${raw.range.split("-")[1].replace(/^0x/, "")}`) : start;
    if (end < start) fail("ISA_SCHEMA_INVALID", { range: raw.range });
    for (let opcode = start; opcode <= end; opcode += 1) {
      if (opcodes.has(opcode)) fail("ISA_RANGE_OVERLAP", { opcode });
      const name = start === end ? raw.name : expandedName(raw.name, opcode - start);
      if (mnemonics.has(name)) fail("ISA_DUPLICATE_MNEMONIC", { mnemonic: name });
      const immediateBytes = numeric(raw.immediateBytes, opcode, "immediate");
      const pops = numeric(raw.pops, opcode, "pops");
      const pushes = numeric(raw.pushes, opcode, "pushes");
      if (immediateBytes < 0 || immediateBytes > 32 || pops < 0 || pushes < 0) fail("ISA_SCHEMA_INVALID", { opcode });
      opcodes.add(opcode);
      mnemonics.add(name);
      definitions.push({
        opcode,
        mnemonic: name,
        immediateBytes,
        pops,
        pushes,
        staticAllowed: raw.staticAllowed,
        stackSignature: raw.stackSignature ?? defaultSignature(name, pops, pushes),
        semantics: raw.semantics,
        width: 1 + immediateBytes
      });
    }
  }
  return definitions;
}

function solidityAcceptedSet(source) {
  const start = source.indexOf("function _opcodeInfo");
  const end = source.indexOf("function _binary", start);
  if (start < 0 || end < 0) fail("ISA_SOLIDITY_DRIFT", { reason: "missing _opcodeInfo" });
  const body = source.slice(start, end);
  const accepted = new Set();
  for (const match of body.matchAll(/opcode\s*==\s*(0x[0-9a-fA-F]{2})/g)) accepted.add(Number.parseInt(match[1], 16));
  for (const match of body.matchAll(/opcode\s*>=\s*(0x[0-9a-fA-F]{2})\s*&&\s*opcode\s*<=\s*(0x[0-9a-fA-F]{2})/g)) {
    const first = Number.parseInt(match[1], 16);
    const last = Number.parseInt(match[2], 16);
    for (let opcode = first; opcode <= last; opcode += 1) accepted.add(opcode);
  }
  return accepted;
}

function solidityStaticForbidden(source) {
  const forbidden = new Set();
  for (const match of source.matchAll(/else if \(opcode == (0x[0-9a-fA-F]{2})\) \{\s*if \(frame\.staticMode\) revert StaticViolation\(opcode\)/g)) {
    forbidden.add(Number.parseInt(match[1], 16));
  }
  for (const match of source.matchAll(/else if \(opcode >= (0x[0-9a-fA-F]{2}) && opcode <= (0x[0-9a-fA-F]{2})\) \{\s*if \(frame\.staticMode\) revert StaticViolation\(opcode\)/g)) {
    const first = Number.parseInt(match[1], 16);
    const last = Number.parseInt(match[2], 16);
    for (let opcode = first; opcode <= last; opcode += 1) forbidden.add(opcode);
  }
  return forbidden;
}

const isaBytes = await readFile(isaPath);
const isa = JSON.parse(isaBytes.toString("utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const solidity = await readFile(solidityPath, "utf8");
const keccak = hex(keccak_256(isaBytes));
const sha256 = createHash("sha256").update(isaBytes).digest("hex");
if (keccak !== manifest.isa.keccak256 || sha256 !== manifest.isa.sha256) fail("ISA_HASH_MISMATCH", { keccak, sha256 });

const definitions = expandIsa(isa);
const jsonSet = new Set(definitions.map((item) => item.opcode));
const soliditySet = solidityAcceptedSet(solidity);
const missing = [...jsonSet].filter((opcode) => !soliditySet.has(opcode));
const extra = [...soliditySet].filter((opcode) => !jsonSet.has(opcode));
if (missing.length !== 0 || extra.length !== 0) fail("ISA_SOLIDITY_DRIFT", { missing, extra });
const expectedForbidden = new Set(definitions.filter((item) => !item.staticAllowed).map((item) => item.opcode));
const solidityForbidden = solidityStaticForbidden(solidity);
const staticMissing = [...expectedForbidden].filter((opcode) => !solidityForbidden.has(opcode));
const staticExtra = [...solidityForbidden].filter((opcode) => !expectedForbidden.has(opcode));
if (staticMissing.length !== 0 || staticExtra.length !== 0) {
  fail("ISA_STATIC_DRIFT", { missing: staticMissing, extra: staticExtra });
}

const generated = `// Generated from docs/spec/SwapVM-ISA-v2.json by scripts/generate-isa.mjs.\n// Do not edit manually.\n\nexport const ISA_VERSION = ${isa.version} as const;\nexport const ISA_FILE_KECCAK = ${JSON.stringify(keccak)} as const;\nexport const ISA_FILE_SHA256 = ${JSON.stringify(sha256)} as const;\nexport const ISA_WORD_BITS = ${isa.wordBits} as const;\nexport const ISA_BYTE_ORDER = ${JSON.stringify(isa.byteOrder)} as const;\n\nexport const GENERATED_INSTRUCTIONS = ${JSON.stringify(definitions, null, 2)} as const;\n`;

if (check) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) fail("ISA_GENERATED_DRIFT");
} else {
  await writeFile(outputPath, generated);
}

process.stdout.write(`SwapVM ISA v${isa.version}: ${definitions.length} opcodes, hashes and Solidity drift verified\n`);
