import { keccak_256 } from "@noble/hashes/sha3";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  inputToBytes,
  normalizeBytes32,
  readU16,
  writeU16,
  type BinaryInput,
  type Bytes32,
  type Hex
} from "./bytes.js";
import { ToolchainErrorCode, fail } from "./errors.js";
import { assertEntrypoint, validateCode, type CodeValidation } from "./validator.js";

export const PROGRAM_PACKAGE_MAGIC = "0x53564d31" as const;
export const PROGRAM_PACKAGE_VERSION = 1 as const;
export const PROGRAM_PACKAGE_HEADER_BYTES = 44 as const;

export interface ProgramPackageV1 {
  readonly magic: typeof PROGRAM_PACKAGE_MAGIC;
  readonly version: typeof PROGRAM_PACKAGE_VERSION;
  readonly constructorEntry: number;
  readonly runtimeEntry: number;
  readonly codeLength: number;
  readonly abiHash: Bytes32;
  readonly code: Uint8Array;
}

export interface ProgramPackageInput {
  readonly constructorEntry: number;
  readonly runtimeEntry: number;
  readonly abiHash: Bytes32 | string;
  readonly code: BinaryInput;
}

export interface PackageValidation {
  readonly package: ProgramPackageV1;
  readonly codeValidation: CodeValidation;
}

export interface ProgramPackageInspection {
  readonly magic: typeof PROGRAM_PACKAGE_MAGIC;
  readonly version: typeof PROGRAM_PACKAGE_VERSION;
  readonly constructorEntry: number;
  readonly runtimeEntry: number;
  readonly codeLength: number;
  readonly abiHash: Bytes32;
  readonly codeHash: Bytes32;
  readonly packageLength: number;
}

function hash(bytes: Uint8Array): Bytes32 {
  return bytesToHex(keccak_256(bytes)) as Bytes32;
}

export function buildProgramPackage(input: ProgramPackageInput): ProgramPackageV1 {
  const code = inputToBytes(input.code);
  const validation = validateCode(code);
  assertEntrypoint(validation, input.constructorEntry, "constructorEntry");
  assertEntrypoint(validation, input.runtimeEntry, "runtimeEntry");
  return Object.freeze({
    magic: PROGRAM_PACKAGE_MAGIC,
    version: PROGRAM_PACKAGE_VERSION,
    constructorEntry: input.constructorEntry,
    runtimeEntry: input.runtimeEntry,
    codeLength: code.length,
    abiHash: normalizeBytes32(input.abiHash),
    code
  });
}

export function encodeProgramPackage(input: ProgramPackageInput | ProgramPackageV1): Uint8Array {
  const packageValue = buildProgramPackage(input);
  return concatBytes(
    hexToBytes(PROGRAM_PACKAGE_MAGIC),
    writeU16(PROGRAM_PACKAGE_VERSION),
    writeU16(packageValue.constructorEntry),
    writeU16(packageValue.runtimeEntry),
    writeU16(packageValue.codeLength),
    hexToBytes(packageValue.abiHash),
    packageValue.code
  );
}

export function encodeProgramPackageHex(input: ProgramPackageInput | ProgramPackageV1): Hex {
  return bytesToHex(encodeProgramPackage(input));
}

export function decodeProgramPackage(input: BinaryInput): ProgramPackageV1 {
  const bytes = inputToBytes(input);
  if (bytes.length < PROGRAM_PACKAGE_HEADER_BYTES) {
    fail(ToolchainErrorCode.PACKAGE_TOO_SHORT, { details: { length: bytes.length, minimum: PROGRAM_PACKAGE_HEADER_BYTES } });
  }
  const magic = bytesToHex(bytes.slice(0, 4));
  if (magic !== PROGRAM_PACKAGE_MAGIC) fail(ToolchainErrorCode.INVALID_PACKAGE_MAGIC, { details: { magic } });
  const version = readU16(bytes, 4);
  if (version !== PROGRAM_PACKAGE_VERSION) {
    fail(ToolchainErrorCode.INVALID_PACKAGE_VERSION, { details: { version } });
  }
  const constructorEntry = readU16(bytes, 6);
  const runtimeEntry = readU16(bytes, 8);
  const codeLength = readU16(bytes, 10);
  const actual = bytes.length - PROGRAM_PACKAGE_HEADER_BYTES;
  if (actual !== codeLength) {
    fail(ToolchainErrorCode.PACKAGE_LENGTH_MISMATCH, { details: { declared: codeLength, actual } });
  }
  return buildProgramPackage({
    constructorEntry,
    runtimeEntry,
    abiHash: bytesToHex(bytes.slice(12, 44)),
    code: bytes.slice(44)
  });
}

export function validateProgramPackage(input: BinaryInput): PackageValidation {
  const packageValue = decodeProgramPackage(input);
  return Object.freeze({ package: packageValue, codeValidation: validateCode(packageValue.code) });
}

export const validatePackage = validateProgramPackage;

export function programPackageCodeHash(input: BinaryInput | ProgramPackageInput | ProgramPackageV1): Bytes32 {
  const bytes = input instanceof Uint8Array || typeof input === "string" ? inputToBytes(input) : encodeProgramPackage(input);
  return hash(bytes);
}

export function inspectProgramPackage(input: BinaryInput): ProgramPackageInspection {
  const bytes = inputToBytes(input);
  const packageValue = decodeProgramPackage(bytes);
  return Object.freeze({
    magic: packageValue.magic,
    version: packageValue.version,
    constructorEntry: packageValue.constructorEntry,
    runtimeEntry: packageValue.runtimeEntry,
    codeLength: packageValue.codeLength,
    abiHash: packageValue.abiHash,
    codeHash: hash(bytes),
    packageLength: bytes.length
  });
}
