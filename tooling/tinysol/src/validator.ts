import { inputToBytes, type BinaryInput } from "./bytes.js";
import { ToolchainErrorCode, fail } from "./errors.js";
import { instructionForOpcode, type InstructionDefinition } from "./isa.js";

export const MAX_CODE_BYTES = 16_384 as const;

export interface ValidatedInstruction {
  readonly offset: number;
  readonly definition: InstructionDefinition;
  readonly width: number;
}

export interface CodeValidation {
  readonly codeLength: number;
  readonly instructions: readonly ValidatedInstruction[];
  readonly boundaries: ReadonlySet<number>;
  readonly jumpdestBitmap: Uint8Array;
}

export interface AdvisoryDiagnostic {
  readonly code: "NO_HALT";
  readonly severity: "warning";
  readonly message: string;
}

export interface CodeAnalysis {
  readonly consensus: CodeValidation;
  readonly advisory: readonly AdvisoryDiagnostic[];
}

export function validateCode(input: BinaryInput): CodeValidation {
  const code = inputToBytes(input);
  if (code.length === 0) fail(ToolchainErrorCode.EMPTY_CODE, { details: { length: 0 } });
  if (code.length > MAX_CODE_BYTES) {
    fail(ToolchainErrorCode.CODE_TOO_LARGE, { details: { length: code.length, maximum: MAX_CODE_BYTES } });
  }
  const instructions: ValidatedInstruction[] = [];
  const boundaries = new Set<number>();
  const bitmap = new Uint8Array(code.length);
  let offset = 0;
  while (offset < code.length) {
    const opcode = code[offset];
    if (opcode === undefined) fail(ToolchainErrorCode.INVALID_INPUT);
    const definition = instructionForOpcode(opcode);
    if (definition === undefined) fail(ToolchainErrorCode.UNKNOWN_OPCODE, { offset, details: { opcode } });
    if (offset + definition.width > code.length) {
      fail(ToolchainErrorCode.TRUNCATED_IMMEDIATE, {
        offset,
        details: { opcode, immediateBytes: definition.immediateBytes, available: code.length - offset - 1 }
      });
    }
    boundaries.add(offset);
    if (opcode === 0x5b) bitmap[offset] = 1;
    instructions.push(Object.freeze({ offset, definition, width: definition.width }));
    offset += definition.width;
  }
  return Object.freeze({
    codeLength: code.length,
    instructions: Object.freeze(instructions),
    boundaries,
    jumpdestBitmap: bitmap
  });
}

export function instructionBoundaries(input: BinaryInput): ReadonlySet<number> {
  return validateCode(input).boundaries;
}

export function jumpdestBitmap(input: BinaryInput): Uint8Array {
  return new Uint8Array(validateCode(input).jumpdestBitmap);
}

export function assertEntrypoint(validation: CodeValidation, entrypoint: number, field: string): void {
  if (!Number.isInteger(entrypoint) || entrypoint < 0 || entrypoint >= validation.codeLength || !validation.boundaries.has(entrypoint)) {
    fail(ToolchainErrorCode.INVALID_ENTRYPOINT, { offset: entrypoint, details: { field, entrypoint } });
  }
}

export function analyzeCode(input: BinaryInput): CodeAnalysis {
  const consensus = validateCode(input);
  const hasHalt = consensus.instructions.some(({ definition }) =>
    definition.opcode === 0x00 || definition.opcode === 0xf3 || definition.opcode === 0xfd
  );
  const advisory: AdvisoryDiagnostic[] = [];
  if (!hasHalt) {
    advisory.push(Object.freeze({
      code: "NO_HALT",
      severity: "warning",
      message: "No explicit halt opcode was found; this is advisory and is not a consensus validation failure."
    }));
  }
  return Object.freeze({ consensus, advisory: Object.freeze(advisory) });
}
