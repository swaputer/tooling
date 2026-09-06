export const ReceiptErrorCode = {
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_HEX: "INVALID_HEX",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  TRUNCATED_HEADER: "TRUNCATED_HEADER",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  NONZERO_FLAGS: "NONZERO_FLAGS",
  RECORD_COUNT_ZERO: "RECORD_COUNT_ZERO",
  RECORD_COUNT_EXCEEDED: "RECORD_COUNT_EXCEEDED",
  RECORD_COUNT_MISMATCH: "RECORD_COUNT_MISMATCH",
  TRUNCATED_RECORD_LENGTH: "TRUNCATED_RECORD_LENGTH",
  TRUNCATED_EMITTER: "TRUNCATED_EMITTER",
  TRUNCATED_TOPIC_COUNT: "TRUNCATED_TOPIC_COUNT",
  TOPIC_COUNT_EXCEEDED: "TOPIC_COUNT_EXCEEDED",
  TRUNCATED_TOPICS: "TRUNCATED_TOPICS",
  TRUNCATED_DATA_LENGTH: "TRUNCATED_DATA_LENGTH",
  DATA_LENGTH_EXCEEDED: "DATA_LENGTH_EXCEEDED",
  TRUNCATED_DATA: "TRUNCATED_DATA",
  RECORD_LENGTH_MISMATCH: "RECORD_LENGTH_MISMATCH",
  TRAILING_BYTES: "TRAILING_BYTES",
  LENGTH_OVERFLOW: "LENGTH_OVERFLOW",
  INVALID_BYTES32: "INVALID_BYTES32",
  MISSING_WORLD_EXECUTION: "MISSING_WORLD_EXECUTION",
  DUPLICATE_WORLD_EXECUTION: "DUPLICATE_WORLD_EXECUTION",
  WORLD_EXECUTION_NOT_FINAL: "WORLD_EXECUTION_NOT_FINAL",
  KERNEL_RECORD_TOPIC_COUNT: "KERNEL_RECORD_TOPIC_COUNT",
  KERNEL_RECORD_DATA_WIDTH: "KERNEL_RECORD_DATA_WIDTH",
  KERNEL_SELECTOR_EMITTER_MISMATCH: "KERNEL_SELECTOR_EMITTER_MISMATCH",
  UNKNOWN_KERNEL_SELECTOR: "UNKNOWN_KERNEL_SELECTOR",
  NON_CANONICAL_EXECUTED_BYTES: "NON_CANONICAL_EXECUTED_BYTES"
} as const;

export type ReceiptErrorCode = (typeof ReceiptErrorCode)[keyof typeof ReceiptErrorCode];
export type ReceiptErrorDetail = string | number | bigint | boolean;

export class VMReceiptError extends Error {
  readonly code: ReceiptErrorCode;
  readonly offset: number | undefined;
  readonly details: Readonly<Record<string, ReceiptErrorDetail>>;

  constructor(
    code: ReceiptErrorCode,
    options: {
      readonly offset?: number;
      readonly details?: Readonly<Record<string, ReceiptErrorDetail>>;
      readonly cause?: unknown;
    } = {}
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VMReceiptError";
    this.code = code;
    this.offset = options.offset;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function isVMReceiptError(error: unknown): error is VMReceiptError {
  return error instanceof VMReceiptError;
}
