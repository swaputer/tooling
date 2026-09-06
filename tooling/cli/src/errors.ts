export const InspectionErrorCode = {
  CLI_USAGE: "CLI_USAGE",
  INVALID_TRANSACTION_HASH: "INVALID_TRANSACTION_HASH",
  INVALID_RECEIPT_PAYLOAD: "INVALID_RECEIPT_PAYLOAD",
  INVALID_DEPLOYMENT: "INVALID_DEPLOYMENT",
  RPC_ENV_MISSING: "RPC_ENV_MISSING",
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

export function isInspectionError(error: unknown): error is InspectionError {
  return error instanceof InspectionError;
}

export function inspectionExitCode(code: InspectionErrorCode): number {
  if (code === InspectionErrorCode.CLI_USAGE || code === InspectionErrorCode.INVALID_TRANSACTION_HASH || code === InspectionErrorCode.INVALID_RECEIPT_PAYLOAD) return 2;
  if (code === InspectionErrorCode.RPC_ENV_MISSING || code === InspectionErrorCode.RPC_UNAVAILABLE) return 3;
  if (code === InspectionErrorCode.TRANSACTION_NOT_FOUND) return 4;
  if (code === InspectionErrorCode.TRANSACTION_REVERTED) return 5;
  if (code === InspectionErrorCode.NOT_SWAPUTER) return 6;
  return 7;
}
