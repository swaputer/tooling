import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";

const root = resolve(process.cwd(), "../..");
const layoutsPath = resolve(process.cwd(), "registry/reference-event-layouts.json");
const outputPath = resolve(process.cwd(), "src/generated-reference-registry.ts");
const artifactNames = ["SRC20-v1", "SRC721-v1", "SRC1155-v1", "CPAMM-v1"];

function hex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function hashUtf8(value) {
  return hex(keccak_256(new TextEncoder().encode(value)));
}

function hashHex(value) {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("invalid artifact hex");
  return hex(keccak_256(Buffer.from(value.slice(2), "hex")));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function selector(signature) {
  return hashUtf8(signature).slice(0, 10);
}

function interfaceId(signatures) {
  let result = 0;
  for (const signature of signatures) result = (result ^ Number.parseInt(selector(signature).slice(2), 16)) >>> 0;
  return `0x${result.toString(16).padStart(8, "0")}`;
}

function requiredArtifact(artifact, name) {
  for (const field of ["standard", "version", "interfaceId", "abiHash", "codeHash", "package", "abiCanonical", "selectors", "eventTopics"]) {
    if (!(field in artifact)) throw new Error(`${name}: missing ${field}`);
  }
}

const layouts = JSON.parse(readFileSync(layoutsPath, "utf8"));
const seenCodeHashes = new Set();
const seenIdentities = new Set();
const entries = [];
for (const name of artifactNames) {
  const artifactPath = resolve(root, `reference/${name}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  requiredArtifact(artifact, name);
  if (hashHex(artifact.package) !== artifact.codeHash.toLowerCase()) throw new Error(`${name}: package codeHash mismatch`);
  if (hashUtf8(artifact.abiCanonical) !== artifact.abiHash.toLowerCase()) throw new Error(`${name}: abiHash mismatch`);
  const abi = JSON.parse(artifact.abiCanonical);
  if (abi.standard !== artifact.standard || abi.version !== artifact.version) throw new Error(`${name}: ABI identity mismatch`);
  if (!Array.isArray(abi.events) || !Array.isArray(abi.functions)) throw new Error(`${name}: malformed canonical ABI`);
  if (Object.keys(artifact.eventTopics).length !== abi.events.length) throw new Error(`${name}: extra event topic`);
  if (Object.keys(artifact.selectors).length !== abi.functions.length) throw new Error(`${name}: extra selector`);
  for (const signature of abi.events) {
    if (artifact.eventTopics[signature]?.toLowerCase() !== hashUtf8(signature)) throw new Error(`${name}: event topic mismatch ${signature}`);
  }
  for (const signature of abi.functions) {
    if (artifact.selectors[signature]?.toLowerCase() !== selector(signature)) throw new Error(`${name}: selector mismatch ${signature}`);
  }
  const interfaceFunctions = abi.functions.filter((signature) => signature !== "supportsInterface(bytes4)");
  if (interfaceId(interfaceFunctions) !== artifact.interfaceId.toLowerCase()) throw new Error(`${name}: interface ID mismatch`);
  const codeHash = artifact.codeHash.toLowerCase();
  if (seenCodeHashes.has(codeHash)) throw new Error(`${name}: duplicate codeHash`);
  seenCodeHashes.add(codeHash);
  const identity = `${artifact.standard}:${artifact.version}:${artifact.interfaceId.toLowerCase()}`;
  if (seenIdentities.has(identity)) throw new Error(`${name}: duplicate identity`);
  seenIdentities.add(identity);

  const source = layouts[name];
  if (source === undefined || !Array.isArray(source.events)) throw new Error(`${name}: missing event layout`);
  if (source.events.length !== abi.events.length) throw new Error(`${name}: event layout count mismatch`);
  const events = source.events.map((event) => {
    if (!abi.events.includes(event.signature)) throw new Error(`${name}: layout signature missing from ABI`);
    const eventName = event.signature.slice(0, event.signature.indexOf("("));
    const signatureTypes = event.signature.slice(event.signature.indexOf("(") + 1, -1).split(",").filter(Boolean);
    if (!Array.isArray(event.fields) || signatureTypes.length !== event.fields.length) throw new Error(`${name}: field count mismatch`);
    const indexed = event.fields.filter((field) => field.indexed).map((field) => field.position).sort((a, b) => a - b);
    const data = event.fields.filter((field) => !field.indexed).map((field) => field.position).sort((a, b) => a - b);
    if (indexed.length > 3 || indexed.some((position, index) => position !== index + 1) || data.some((position, index) => position !== index)) {
      throw new Error(`${name}: invalid event layout`);
    }
    const mappedTypes = event.fields.map((field) => field.type === "account" ? "bytes32" : field.type);
    if (mappedTypes.some((type, index) => type !== signatureTypes[index])) throw new Error(`${name}: field type mismatch`);
    return { name: eventName, signature: event.signature, topic0: artifact.eventTopics[event.signature].toLowerCase(), fields: event.fields };
  });
  const descriptor = {
    format: "SwapVMEventABI",
    descriptorVersion: 1,
    codeHash,
    standard: artifact.standard,
    version: artifact.version,
    interfaceId: artifact.interfaceId.toLowerCase(),
    artifactAbiHash: artifact.abiHash.toLowerCase(),
    events
  };
  const descriptorJson = canonical(descriptor);
  entries.push({
    artifactSource: `reference/${name}.json`,
    descriptor,
    descriptorHash: hashUtf8(descriptorJson),
    descriptorJson
  });
}

const generated = `// Generated by scripts/generate-reference-registry.mjs from reference artifacts\n// and registry/reference-event-layouts.json. Do not edit by hand.\nexport const GENERATED_REFERENCE_REGISTRY = ${JSON.stringify(entries, null, 2)} as const;\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== generated) throw new Error("generated reference registry is stale");
} else {
  writeFileSync(outputPath, generated);
}
