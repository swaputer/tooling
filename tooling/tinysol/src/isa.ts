import {
  GENERATED_INSTRUCTIONS,
  ISA_BYTE_ORDER,
  ISA_FILE_KECCAK,
  ISA_FILE_SHA256,
  ISA_VERSION,
  ISA_WORD_BITS
} from "./generated-isa.js";

export { ISA_BYTE_ORDER, ISA_FILE_KECCAK, ISA_FILE_SHA256, ISA_VERSION, ISA_WORD_BITS };

export interface InstructionDefinition {
  readonly opcode: number;
  readonly mnemonic: string;
  readonly immediateBytes: number;
  readonly pops: number;
  readonly pushes: number;
  readonly staticAllowed: boolean;
  readonly stackSignature: string;
  readonly semantics: string;
  readonly width: number;
}

export const INSTRUCTIONS: readonly InstructionDefinition[] = Object.freeze(
  GENERATED_INSTRUCTIONS.map((item) => Object.freeze({ ...item }))
);

export const OPCODE_TO_INSTRUCTION: ReadonlyMap<number, InstructionDefinition> = new Map(
  INSTRUCTIONS.map((definition) => [definition.opcode, definition])
);

export const MNEMONIC_TO_INSTRUCTION: ReadonlyMap<string, InstructionDefinition> = new Map(
  INSTRUCTIONS.map((definition) => [definition.mnemonic, definition])
);

export function instructionForOpcode(opcode: number): InstructionDefinition | undefined {
  return OPCODE_TO_INSTRUCTION.get(opcode);
}

export function instructionForMnemonic(mnemonic: string): InstructionDefinition | undefined {
  return MNEMONIC_TO_INSTRUCTION.get(mnemonic.toUpperCase());
}
