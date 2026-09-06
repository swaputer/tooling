import { bytesToHex, inputToBytes, type BinaryInput, type Hex } from "./bytes.js";
import { decodeProgramPackage, PROGRAM_PACKAGE_MAGIC, type ProgramPackageV1 } from "./package.js";
import { validateCode } from "./validator.js";
import type { InstructionDefinition } from "./isa.js";

export interface DisassembledInstruction {
  readonly offset: number;
  readonly opcode: number;
  readonly mnemonic: string;
  readonly immediate: Uint8Array;
  readonly immediateHex: Hex;
  readonly literal?: bigint;
  readonly width: number;
  readonly pops: number;
  readonly pushes: number;
  readonly stackSignature: string;
  readonly staticAllowed: boolean;
  readonly definition: InstructionDefinition;
}

export interface DisassemblyResult {
  readonly kind: "code" | "package";
  readonly code: Uint8Array;
  readonly package?: ProgramPackageV1;
  readonly instructions: readonly DisassembledInstruction[];
  readonly canonicalText: string;
}

export interface DisassembleOptions {
  readonly kind?: "auto" | "code" | "package";
}

function decodeLiteral(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

export function disassembleCode(input: BinaryInput): readonly DisassembledInstruction[] {
  const code = inputToBytes(input);
  const validation = validateCode(code);
  return Object.freeze(validation.instructions.map(({ offset, definition }) => {
    const immediate = code.slice(offset + 1, offset + definition.width);
    const base = {
      offset,
      opcode: definition.opcode,
      mnemonic: definition.mnemonic,
      immediate,
      immediateHex: bytesToHex(immediate),
      width: definition.width,
      pops: definition.pops,
      pushes: definition.pushes,
      stackSignature: definition.stackSignature,
      staticAllowed: definition.staticAllowed,
      definition
    };
    return Object.freeze(definition.immediateBytes === 0 ? base : { ...base, literal: decodeLiteral(immediate) });
  }));
}

function instructionText(instruction: DisassembledInstruction): string {
  return instruction.immediate.length === 0 ? instruction.mnemonic : `${instruction.mnemonic} ${instruction.immediateHex}`;
}

export function disassemble(input: BinaryInput, options: DisassembleOptions = {}): DisassemblyResult {
  const bytes = inputToBytes(input);
  const requested = options.kind ?? "auto";
  const looksLikePackage = bytes.length >= 4 && bytesToHex(bytes.slice(0, 4)) === PROGRAM_PACKAGE_MAGIC;
  const kind = requested === "auto" ? (looksLikePackage ? "package" : "code") : requested;
  const packageValue = kind === "package" ? decodeProgramPackage(bytes) : undefined;
  const code = packageValue?.code ?? bytes;
  const instructions = disassembleCode(code);
  const lines: string[] = [];
  if (packageValue !== undefined) {
    lines.push(".constructor __constructor", ".runtime __runtime", `.abi-hash ${packageValue.abiHash}`, ".code");
  }
  for (const instruction of instructions) {
    if (packageValue?.constructorEntry === instruction.offset) lines.push("__constructor:");
    if (packageValue?.runtimeEntry === instruction.offset) lines.push("__runtime:");
    lines.push(instructionText(instruction));
  }
  return Object.freeze({
    kind,
    code,
    ...(packageValue === undefined ? {} : { package: packageValue }),
    instructions,
    canonicalText: `${lines.join("\n")}\n`
  });
}
