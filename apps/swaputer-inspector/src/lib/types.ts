import type { VMReceiptV1 } from "@swaputer/receipt-codec";
import type { SwaputerDeployment } from "./deployments";

export type Hex = `0x${string}`;

export interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly logIndex: string;
  readonly transactionIndex: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
}

export interface RpcReceipt {
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly transactionIndex: string;
  readonly status: string;
  readonly logs: readonly RpcLog[];
}

export interface SwaputerExecution {
  readonly worldId: Hex;
  readonly executionHeight: bigint;
  readonly payload: Hex;
  readonly logIndex: bigint;
  readonly receipt: VMReceiptV1;
}

export interface InspectionResult {
  readonly kind: "verified";
  readonly deployment: SwaputerDeployment;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
  readonly executions: readonly SwaputerExecution[];
  readonly rpcUrl: string;
}

export const InspectionErrorCode = {
  INVALID_TRANSACTION_HASH: "INVALID_TRANSACTION_HASH",
  RPC_UNAVAILABLE: "RPC_UNAVAILABLE",
  UNSUPPORTED_NETWORK: "UNSUPPORTED_NETWORK",
  TRANSACTION_NOT_FOUND: "TRANSACTION_NOT_FOUND",
  TRANSACTION_REVERTED: "TRANSACTION_REVERTED",
  NOT_SWAPUTER: "NOT_SWAPUTER",
  UNSUPPORTED_DEPLOYMENT: "UNSUPPORTED_DEPLOYMENT",
  KERNEL_CODE_HASH_MISMATCH: "KERNEL_CODE_HASH_MISMATCH",
  MALFORMED_EVENTS: "MALFORMED_EVENTS"
} as const;

export type InspectionErrorCode = (typeof InspectionErrorCode)[keyof typeof InspectionErrorCode];

export class InspectionError extends Error {
  readonly code: InspectionErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: InspectionErrorCode, details: Readonly<Record<string, string>> = {}, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "InspectionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface InspectorSelection {
  readonly transactionHash: Hex;
  readonly sourceUrl?: string;
  readonly selectedAt: number;
}
