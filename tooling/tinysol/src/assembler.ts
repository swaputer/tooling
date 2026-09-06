import { exactUtf8AbiHash } from "./abi.js";
import { bytesToHex, hexToBytes, normalizeBytes32, type Bytes32, type Hex } from "./bytes.js";
import { ToolchainErrorCode, fail } from "./errors.js";
import { instructionForMnemonic, ISA_FILE_KECCAK, type InstructionDefinition } from "./isa.js";
import { buildManifest, type BuildManifestV1 } from "./manifest.js";
import { buildProgramPackage, encodeProgramPackage, programPackageCodeHash, type ProgramPackageV1 } from "./package.js";
import { MAX_CODE_BYTES, validateCode } from "./validator.js";

export interface SourceMapEntry {
  readonly offset: number;
  readonly width: number;
  readonly line: number;
  readonly column: number;
}

export interface AssemblyDiagnostic {
  readonly severity: "warning" | "info";
  readonly code: string;
  readonly line?: number;
}

export interface AssemblyResult {
  readonly code: Uint8Array;
  readonly codeHex: Hex;
  readonly constructorEntry: number;
  readonly runtimeEntry: number;
  readonly abiHash: Bytes32;
  readonly package: ProgramPackageV1;
  readonly packageBytes: Uint8Array;
  readonly codeHash: Bytes32;
  readonly isaHash: typeof ISA_FILE_KECCAK;
  readonly sourceMap: readonly SourceMapEntry[];
  readonly diagnostics: readonly AssemblyDiagnostic[];
  readonly manifest: BuildManifestV1;
}

interface InstructionItem {
  readonly kind: "instruction";
  readonly definition: InstructionDefinition;
  readonly operand?: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

interface RelocationItem {
  readonly kind: "pushlabel";
  readonly label: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

type AssemblyItem = InstructionItem | RelocationItem;

function stripComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === ";" || char === "#" || (char === "/" && line[index + 1] === "/"))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function literal(value: string, line: number, column: number): bigint {
  if (!/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) {
    fail(ToolchainErrorCode.ASSEMBLY_SYNTAX, { line, column, details: { token: value } });
  }
  return BigInt(value);
}

function encodeLiteral(value: bigint, width: number, line: number, column: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(width * 8)) {
    fail(ToolchainErrorCode.LITERAL_OVERFLOW, { line, column, details: { value, width } });
  }
  const output = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function directiveTarget(value: string | undefined, line: number): string {
  if (value === undefined || value.length === 0 || !/^(?:[A-Za-z_.$][A-Za-z0-9_.$]*|0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) {
    fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line });
  }
  return value;
}

function resolveTarget(value: string | undefined, labels: ReadonlyMap<string, number>, line: number, field: string): number {
  const target = directiveTarget(value, line);
  if (/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(target)) {
    const parsed = literal(target, line, 1);
    if (parsed > 0xffffn) fail(ToolchainErrorCode.INVALID_ENTRYPOINT, { line, details: { field } });
    return Number(parsed);
  }
  const offset = labels.get(target);
  if (offset === undefined) fail(ToolchainErrorCode.UNDEFINED_LABEL, { line, details: { label: target, field } });
  return offset;
}

export function assemble(source: string): AssemblyResult {
  if (typeof source !== "string") fail(ToolchainErrorCode.INVALID_INPUT);
  const labels = new Map<string, number>();
  const items: AssemblyItem[] = [];
  let constructorTarget: string | undefined;
  let constructorLine = 1;
  let runtimeTarget: string | undefined;
  let runtimeLine = 1;
  let declaredAbiHash: Bytes32 | undefined;
  let canonicalAbiHash: Bytes32 | undefined;
  let offset = 0;

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let text = stripComment(lines[index] ?? "").trim();
    if (text.length === 0) continue;
    const labelMatch = /^([A-Za-z_.$][A-Za-z0-9_.$]*):(?:\s*(.*))?$/.exec(text);
    if (labelMatch !== null) {
      const name = labelMatch[1] ?? "";
      if (labels.has(name)) fail(ToolchainErrorCode.DUPLICATE_LABEL, { line: lineNumber, details: { label: name } });
      labels.set(name, offset);
      text = (labelMatch[2] ?? "").trim();
      if (text.length === 0) continue;
    }
    if (text.startsWith(".")) {
      const match = /^(\.[A-Za-z-]+)(?:\s+(.*))?$/.exec(text);
      if (match === null) fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line: lineNumber });
      const name = match[1];
      const argument = match[2]?.trim();
      if (name === ".constructor") {
        if (constructorTarget !== undefined) fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line: lineNumber });
        constructorTarget = directiveTarget(argument, lineNumber);
        constructorLine = lineNumber;
      } else if (name === ".runtime") {
        if (runtimeTarget !== undefined) fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line: lineNumber });
        runtimeTarget = directiveTarget(argument, lineNumber);
        runtimeLine = lineNumber;
      } else if (name === ".abi-hash") {
        if (argument === undefined || declaredAbiHash !== undefined) fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line: lineNumber });
        declaredAbiHash = normalizeBytes32(argument);
      } else if (name === ".abi-canonical") {
        if (argument === undefined || canonicalAbiHash !== undefined) fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line: lineNumber });
        let literalValue: unknown;
        try {
          literalValue = JSON.parse(argument);
        } catch {
          fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line: lineNumber });
        }
        if (typeof literalValue !== "string") fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line: lineNumber });
        canonicalAbiHash = exactUtf8AbiHash(literalValue);
      } else if (name === ".pushlabel") {
        const label = directiveTarget(argument, lineNumber);
        items.push({ kind: "pushlabel", label, offset, line: lineNumber, column: 1 });
        offset += 3;
      } else if (name !== ".code") {
        fail(ToolchainErrorCode.INVALID_DIRECTIVE, { line: lineNumber, details: { directive: name ?? "" } });
      }
      continue;
    }

    const tokens = text.split(/\s+/);
    const mnemonic = (tokens[0] ?? "").toUpperCase();
    const definition = instructionForMnemonic(mnemonic);
    if (definition === undefined) fail(ToolchainErrorCode.ASSEMBLY_SYNTAX, { line: lineNumber, details: { mnemonic } });
    const operand = tokens[1];
    const expectsOperand = definition.immediateBytes > 0;
    if ((expectsOperand && (operand === undefined || tokens.length !== 2)) || (!expectsOperand && tokens.length !== 1)) {
      fail(ToolchainErrorCode.ASSEMBLY_SYNTAX, { line: lineNumber, details: { mnemonic } });
    }
    items.push({ kind: "instruction", definition, ...(operand === undefined ? {} : { operand }), offset, line: lineNumber, column: 1 });
    offset += definition.width;
  }

  if (offset > MAX_CODE_BYTES) {
    fail(ToolchainErrorCode.CODE_TOO_LARGE, { details: { length: offset, maximum: MAX_CODE_BYTES } });
  }
  if (offset === 0) fail(ToolchainErrorCode.EMPTY_CODE);
  const code = new Uint8Array(offset);
  const sourceMap: SourceMapEntry[] = [];
  for (const item of items) {
    if (item.kind === "pushlabel") {
      const target = labels.get(item.label);
      if (target === undefined) fail(ToolchainErrorCode.UNDEFINED_LABEL, { line: item.line, details: { label: item.label } });
      if (target > 0xffff) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { line: item.line, details: { label: item.label, width: 2 } });
      code[item.offset] = 0x61;
      code.set(encodeLiteral(BigInt(target), 2, item.line, item.column), item.offset + 1);
      sourceMap.push(Object.freeze({ offset: item.offset, width: 3, line: item.line, column: item.column }));
    } else {
      code[item.offset] = item.definition.opcode;
      if (item.definition.immediateBytes > 0) {
        code.set(encodeLiteral(literal(item.operand ?? "", item.line, item.column), item.definition.immediateBytes, item.line, item.column), item.offset + 1);
      }
      sourceMap.push(Object.freeze({ offset: item.offset, width: item.definition.width, line: item.line, column: item.column }));
    }
  }
  const codeValidation = validateCode(code);
  for (const [label, labelOffset] of labels) {
    if (!codeValidation.boundaries.has(labelOffset)) {
      fail(ToolchainErrorCode.INVALID_ENTRYPOINT, { offset: labelOffset, details: { field: "label", label } });
    }
  }
  const constructorEntry = resolveTarget(constructorTarget ?? "0", labels, constructorLine, "constructorEntry");
  const runtimeEntry = resolveTarget(runtimeTarget ?? "0", labels, runtimeLine, "runtimeEntry");
  const abiHash = declaredAbiHash ?? canonicalAbiHash ?? ("0x" + "00".repeat(32)) as Bytes32;
  if (declaredAbiHash !== undefined && canonicalAbiHash !== undefined && declaredAbiHash !== canonicalAbiHash) {
    fail(ToolchainErrorCode.INVALID_ABI_HASH, { details: { declared: declaredAbiHash, computed: canonicalAbiHash } });
  }
  const packageValue = buildProgramPackage({ constructorEntry, runtimeEntry, abiHash, code });
  const packageBytes = encodeProgramPackage(packageValue);
  const manifest = buildManifest(packageValue, source);
  return Object.freeze({
    code,
    codeHex: bytesToHex(code),
    constructorEntry,
    runtimeEntry,
    abiHash,
    package: packageValue,
    packageBytes,
    codeHash: programPackageCodeHash(packageBytes),
    isaHash: ISA_FILE_KECCAK,
    sourceMap: Object.freeze(sourceMap),
    diagnostics: Object.freeze([]),
    manifest
  });
}
