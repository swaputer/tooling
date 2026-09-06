import type { Bytes32, Hex } from "./bytes.js";

export const MINIVM_LIMITS = Object.freeze({
  maxByteLimit: 1_000_000,
  maxCodeBytes: 16_384,
  maxMemoryBytes: 65_536,
  maxTotalMemoryBytes: 262_144,
  maxStackWords: 1_024,
  maxCallDepth: 32,
  maxRecords: 64,
  maxRecordDataBytes: 4_096,
  maxReceiptPayloadBytes: 65_536
} as const);

export const MiniVMErrorCode = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_STATE: "INVALID_STATE",
  EMPTY_CODE: "EMPTY_CODE",
  CODE_TOO_LARGE: "CODE_TOO_LARGE",
  UNKNOWN_OPCODE: "UNKNOWN_OPCODE",
  TRUNCATED_IMMEDIATE: "TRUNCATED_IMMEDIATE",
  INVALID_ENTRYPOINT: "INVALID_ENTRYPOINT",
  INVALID_BYTE_LIMIT: "INVALID_BYTE_LIMIT",
  OUT_OF_BYTE_GAS: "OUT_OF_BYTE_GAS",
  STACK_UNDERFLOW: "STACK_UNDERFLOW",
  STACK_OVERFLOW: "STACK_OVERFLOW",
  MEMORY_OUT_OF_BOUNDS: "MEMORY_OUT_OF_BOUNDS",
  TOTAL_MEMORY_OUT_OF_BOUNDS: "TOTAL_MEMORY_OUT_OF_BOUNDS",
  RETURN_DATA_OUT_OF_BOUNDS: "RETURN_DATA_OUT_OF_BOUNDS",
  INVALID_JUMP_DESTINATION: "INVALID_JUMP_DESTINATION",
  STATIC_VIOLATION: "STATIC_VIOLATION",
  EXPLICIT_REVERT: "EXPLICIT_REVERT",
  MISSING_HALT: "MISSING_HALT",
  PROGRAM_NOT_FOUND: "PROGRAM_NOT_FOUND",
  INVALID_CONTRACT_ACCOUNT: "INVALID_CONTRACT_ACCOUNT",
  PACKAGE_NOT_REGISTERED: "PACKAGE_NOT_REGISTERED",
  INVALID_PACKAGE: "INVALID_PACKAGE",
  CALL_DEPTH_EXCEEDED: "CALL_DEPTH_EXCEEDED",
  CREATOR_NONCE_OVERFLOW: "CREATOR_NONCE_OVERFLOW",
  RECORD_DATA_TOO_LARGE: "RECORD_DATA_TOO_LARGE",
  TOO_MANY_RECORDS: "TOO_MANY_RECORDS",
  RECEIPT_PAYLOAD_TOO_LARGE: "RECEIPT_PAYLOAD_TOO_LARGE"
} as const);
export type MiniVMErrorCode = (typeof MiniVMErrorCode)[keyof typeof MiniVMErrorCode];

export interface MiniVMProgramState { readonly codeHash: Bytes32 }
export interface MiniVMWorldState {
  readonly packages: Readonly<Record<string, Hex>>;
  readonly programs: Readonly<Record<string, MiniVMProgramState>>;
  readonly storage: Readonly<Record<string, Readonly<Record<string, Bytes32>>>>;
  readonly creatorNonces: Readonly<Record<string, string>>;
}

export interface MiniVMBuyContext {
  readonly ethAmountIn: string;
  readonly grossTokenOut: string;
  readonly tickAfter: number;
  readonly liquidityAfter: string;
}
export interface MiniVMBlockContext { readonly number: string; readonly timestamp: string }
export interface MiniVMTxContext {
  readonly router?: string;
  readonly executor?: string;
  readonly recipient?: string;
}
export interface MiniVMContextInput {
  readonly worldId: Bytes32;
  readonly executionHeight: string;
  readonly byteGasPrice: string;
  readonly buy: MiniVMBuyContext;
  readonly block: MiniVMBlockContext;
  readonly tx?: MiniVMTxContext;
}
export interface MiniVMRootAction {
  readonly op: "CALL" | "DEPLOY";
  readonly actor: Bytes32;
  readonly targetOrCodeHash: Bytes32;
  readonly payload: Hex;
  readonly byteLimit: number;
  readonly static?: boolean;
}
export interface SimulateMiniVMInput {
  readonly state: MiniVMWorldState;
  readonly action: MiniVMRootAction;
  readonly context: MiniVMContextInput;
}
export interface SimulateMiniVMCodeInput {
  readonly state: MiniVMWorldState;
  readonly code: Hex;
  readonly input: Hex;
  readonly entry: number;
  readonly actor: Bytes32;
  readonly target: Bytes32;
  readonly byteLimit: number;
  readonly static?: boolean;
  readonly context: MiniVMContextInput;
}

export interface MiniVMStorageWrite { readonly target: Bytes32; readonly slot: Bytes32; readonly value: Bytes32 }
export interface MiniVMStorageDiff extends MiniVMStorageWrite { readonly previousValue: Bytes32 }
export interface MiniVMDeployment {
  readonly contractId: Bytes32;
  readonly creator: Bytes32;
  readonly codeHash: Bytes32;
  readonly nonceBefore: string;
  readonly nonceAfter: string;
  readonly root: boolean;
}
export interface MiniVMRecord { readonly emitter: Bytes32; readonly topics: readonly Bytes32[]; readonly data: Hex }
export interface MiniVMFailure {
  readonly code: MiniVMErrorCode;
  readonly pc: number | null;
  readonly opcode: number | null;
  readonly depth: number;
  readonly data: Hex;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

interface MiniVMSimulationBase {
  readonly executedBytes: number;
  readonly output: Hex;
  readonly revertData: Hex;
  readonly storageJournal: readonly MiniVMStorageWrite[];
  readonly storageDiff: readonly MiniVMStorageDiff[];
  readonly deploymentDiff: readonly MiniVMDeployment[];
  readonly virtualRecords: readonly MiniVMRecord[];
  readonly encodedRecords: Hex;
  readonly state: MiniVMWorldState;
  readonly rootTarget: Bytes32;
}
export interface MiniVMSimulationSuccess extends MiniVMSimulationBase { readonly success: true; readonly error: null }
export interface MiniVMSimulationFailure extends MiniVMSimulationBase { readonly success: false; readonly error: MiniVMFailure }
export type MiniVMSimulationResult = MiniVMSimulationSuccess | MiniVMSimulationFailure;

export interface EstimateMiniVMInput extends SimulateMiniVMInput {
  readonly minNetTokenOut: string;
}
export interface MiniVMFeeEstimate {
  readonly mode: "exact" | "conservative" | "unavailable";
  readonly estimatedExecutedBytes: number | null;
  readonly byteGasPrice: string;
  readonly estimatedActualBurn: string | null;
  readonly byteGasLimit: number;
  readonly maximumTokenExposure: string;
  readonly grossTokenOutput: string;
  readonly estimatedNetTokenOutput: string | null;
  readonly minNetTokenOut: string;
  readonly coversMaximumExposureAndMinNet: boolean;
  readonly signable: boolean;
  readonly simulation: MiniVMSimulationResult;
}

export function emptyMiniVMWorldState(): MiniVMWorldState {
  return Object.freeze({ packages: Object.freeze({}), programs: Object.freeze({}), storage: Object.freeze({}), creatorNonces: Object.freeze({}) });
}
