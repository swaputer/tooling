export const IndexerErrorCode = {
  INVALID_ADDRESS: "INVALID_ADDRESS",
  INVALID_BYTES32: "INVALID_BYTES32",
  INVALID_QUANTITY: "INVALID_QUANTITY",
  INVALID_RPC_BLOCK: "INVALID_RPC_BLOCK",
  OUTER_ADDRESS_MISMATCH: "OUTER_ADDRESS_MISMATCH",
  OUTER_TOPIC0_MISMATCH: "OUTER_TOPIC0_MISMATCH",
  OUTER_TOPIC_COUNT: "OUTER_TOPIC_COUNT",
  OUTER_WORLD_ID: "OUTER_WORLD_ID",
  OUTER_HEIGHT_WORD: "OUTER_HEIGHT_WORD",
  OUTER_DATA_HEX: "OUTER_DATA_HEX",
  OUTER_DATA_TRUNCATED: "OUTER_DATA_TRUNCATED",
  OUTER_DATA_OFFSET: "OUTER_DATA_OFFSET",
  OUTER_DATA_LENGTH: "OUTER_DATA_LENGTH",
  OUTER_DATA_PADDING: "OUTER_DATA_PADDING",
  OUTER_DATA_TRAILING: "OUTER_DATA_TRAILING",
  RECEIPT_INVALID: "RECEIPT_INVALID",
  RPC_TRANSPORT: "RPC_TRANSPORT",
  RPC_RESPONSE: "RPC_RESPONSE",
  RPC_RANGE_TOO_LARGE: "RPC_RANGE_TOO_LARGE",
  RPC_RETRIES_EXHAUSTED: "RPC_RETRIES_EXHAUSTED",
  CHAIN_ID_MISMATCH: "CHAIN_ID_MISMATCH",
  CHAIN_IDENTITY_MISMATCH: "CHAIN_IDENTITY_MISMATCH",
  KERNEL_CONFIG_MISMATCH: "KERNEL_CONFIG_MISMATCH",
  LOG_BLOCK_MISMATCH: "LOG_BLOCK_MISMATCH",
  LOG_IDENTITY_INVALID: "LOG_IDENTITY_INVALID",
  EXECUTION_HEIGHT_ZERO: "EXECUTION_HEIGHT_ZERO",
  EXECUTION_HEIGHT_GAP: "EXECUTION_HEIGHT_GAP",
  EXECUTION_HEIGHT_DUPLICATE: "EXECUTION_HEIGHT_DUPLICATE",
  DEPLOYMENT_CONFLICT: "DEPLOYMENT_CONFLICT",
  DEPLOYMENT_DUPLICATE: "DEPLOYMENT_DUPLICATE",
  REORG_DETECTED: "REORG_DETECTED",
  REORG_DEPTH_EXCEEDED: "REORG_DEPTH_EXCEEDED",
  CANONICAL_PARENT_MISMATCH: "CANONICAL_PARENT_MISMATCH",
  DATABASE_INTEGRITY: "DATABASE_INTEGRITY",
  MIGRATION_INVALID: "MIGRATION_INVALID",
  CLI_USAGE: "CLI_USAGE"
} as const;

export type IndexerErrorCode = (typeof IndexerErrorCode)[keyof typeof IndexerErrorCode];
export type ErrorCategory = "EVENTS" | "RECEIPT" | "INTEGRITY" | "RPC" | "REORG";
export type ErrorDetail = string | number | bigint | boolean | null;

export class IndexerError extends Error {
  readonly code: IndexerErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly details: Readonly<Record<string, ErrorDetail>>;

  constructor(
    code: IndexerErrorCode,
    category: ErrorCategory,
    options: {
      readonly retryable?: boolean;
      readonly fatal?: boolean;
      readonly details?: Readonly<Record<string, ErrorDetail>>;
    } = {}
  ) {
    super(code);
    this.name = "IndexerError";
    this.code = code;
    this.category = category;
    this.retryable = options.retryable ?? false;
    this.fatal = options.fatal ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export class RpcRangeTooLargeError extends IndexerError {
  constructor() {
    super(IndexerErrorCode.RPC_RANGE_TOO_LARGE, "RPC", { retryable: true });
    this.name = "RpcRangeTooLargeError";
  }
}

export function isIndexerError(error: unknown): error is IndexerError {
  return error instanceof IndexerError;
}
