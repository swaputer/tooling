export const ToolchainErrorCode = {
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_HEX: "INVALID_HEX",
  ISA_SCHEMA_INVALID: "ISA_SCHEMA_INVALID",
  ISA_HASH_MISMATCH: "ISA_HASH_MISMATCH",
  ISA_DUPLICATE_OPCODE: "ISA_DUPLICATE_OPCODE",
  ISA_DUPLICATE_MNEMONIC: "ISA_DUPLICATE_MNEMONIC",
  ISA_RANGE_OVERLAP: "ISA_RANGE_OVERLAP",
  ISA_SOLIDITY_DRIFT: "ISA_SOLIDITY_DRIFT",
  ISA_STATIC_DRIFT: "ISA_STATIC_DRIFT",
  EMPTY_CODE: "EMPTY_CODE",
  CODE_TOO_LARGE: "CODE_TOO_LARGE",
  UNKNOWN_OPCODE: "UNKNOWN_OPCODE",
  TRUNCATED_IMMEDIATE: "TRUNCATED_IMMEDIATE",
  INVALID_ENTRYPOINT: "INVALID_ENTRYPOINT",
  PACKAGE_TOO_SHORT: "PACKAGE_TOO_SHORT",
  INVALID_PACKAGE_MAGIC: "INVALID_PACKAGE_MAGIC",
  INVALID_PACKAGE_VERSION: "INVALID_PACKAGE_VERSION",
  PACKAGE_LENGTH_MISMATCH: "PACKAGE_LENGTH_MISMATCH",
  INVALID_ABI_HASH: "INVALID_ABI_HASH",
  ASSEMBLY_SYNTAX: "ASSEMBLY_SYNTAX",
  INVALID_DIRECTIVE: "INVALID_DIRECTIVE",
  DUPLICATE_LABEL: "DUPLICATE_LABEL",
  UNDEFINED_LABEL: "UNDEFINED_LABEL",
  LITERAL_OVERFLOW: "LITERAL_OVERFLOW",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  INPUT_OUTPUT_COLLISION: "INPUT_OUTPUT_COLLISION",
  OUTPUT_EXISTS: "OUTPUT_EXISTS",
  CLI_USAGE: "CLI_USAGE"
  ,SOURCE_LIMIT: "SOURCE_LIMIT"
  ,TOKEN_LIMIT: "TOKEN_LIMIT"
  ,AST_LIMIT: "AST_LIMIT"
  ,NESTING_LIMIT: "NESTING_LIMIT"
  ,EXPRESSION_LIMIT: "EXPRESSION_LIMIT"
  ,INVALID_SOURCE_CHARACTER: "INVALID_SOURCE_CHARACTER"
  ,NON_ASCII_IDENTIFIER: "NON_ASCII_IDENTIFIER"
  ,UNTERMINATED_COMMENT: "UNTERMINATED_COMMENT"
  ,INVALID_LITERAL: "INVALID_LITERAL"
  ,PARSE_EXPECTED_TOKEN: "PARSE_EXPECTED_TOKEN"
  ,DUPLICATE_DECLARATION: "DUPLICATE_DECLARATION"
  ,UNDEFINED_SYMBOL: "UNDEFINED_SYMBOL"
  ,TYPE_MISMATCH: "TYPE_MISMATCH"
  ,INVALID_OPERATION: "INVALID_OPERATION"
  ,INVALID_ASSIGNMENT: "INVALID_ASSIGNMENT"
  ,RETURN_MISMATCH: "RETURN_MISMATCH"
  ,MISSING_RETURN: "MISSING_RETURN"
  ,SELECTOR_COLLISION: "SELECTOR_COLLISION"
  ,EVENT_TOPIC_COLLISION: "EVENT_TOPIC_COLLISION"
  ,STATIC_VIOLATION: "STATIC_VIOLATION"
  ,UNSUPPORTED_FEATURE: "UNSUPPORTED_FEATURE"
  ,FUNCTION_CALL_CYCLE: "FUNCTION_CALL_CYCLE"
  ,RESOURCE_LIMIT: "RESOURCE_LIMIT"
  ,COMPILATION_FAILED: "COMPILATION_FAILED"
  ,CONSTANT_CYCLE: "CONSTANT_CYCLE"
  ,CONST_EVAL_DIV_ZERO: "CONST_EVAL_DIV_ZERO"
  ,CONST_EVAL_INVALID_SHIFT: "CONST_EVAL_INVALID_SHIFT"
  ,UNKNOWN_TYPE: "UNKNOWN_TYPE"
  ,DUPLICATE_FIELD: "DUPLICATE_FIELD"
  ,STRUCT_CYCLE: "STRUCT_CYCLE"
  ,IMPORT_INVALID: "IMPORT_INVALID"
  ,IMPORT_OUTSIDE_ROOT: "IMPORT_OUTSIDE_ROOT"
  ,IMPORT_CYCLE: "IMPORT_CYCLE"
  ,LIBRARY_STATE: "LIBRARY_STATE"
  ,ARRAY_LENGTH_INVALID: "ARRAY_LENGTH_INVALID"
  ,ARRAY_BOUNDS: "ARRAY_BOUNDS"
  ,SIMULATION_INPUT_INVALID: "SIMULATION_INPUT_INVALID"
  ,SIMULATION_STATE_INVALID: "SIMULATION_STATE_INVALID"
  ,SIMULATION_UNAVAILABLE: "SIMULATION_UNAVAILABLE"
} as const;

export type ToolchainErrorCode = (typeof ToolchainErrorCode)[keyof typeof ToolchainErrorCode];
export type ErrorDetail = string | number | bigint | boolean;

export const SOLIDITY_ERROR_BY_TOOLCHAIN_CODE: Readonly<Partial<Record<ToolchainErrorCode, string>>> = Object.freeze({
  [ToolchainErrorCode.EMPTY_CODE]: "EmptyCode",
  [ToolchainErrorCode.CODE_TOO_LARGE]: "CodeTooLarge",
  [ToolchainErrorCode.UNKNOWN_OPCODE]: "UnknownOpcode",
  [ToolchainErrorCode.TRUNCATED_IMMEDIATE]: "TruncatedImmediate",
  [ToolchainErrorCode.PACKAGE_TOO_SHORT]: "InvalidPackageLength",
  [ToolchainErrorCode.INVALID_PACKAGE_MAGIC]: "InvalidPackageMagic",
  [ToolchainErrorCode.INVALID_PACKAGE_VERSION]: "InvalidPackageVersion",
  [ToolchainErrorCode.PACKAGE_LENGTH_MISMATCH]: "InvalidPackageCodeLength",
  [ToolchainErrorCode.INVALID_ENTRYPOINT]: "InvalidPackageEntry"
});

export class ToolchainError extends Error {
  readonly code: ToolchainErrorCode;
  readonly offset?: number;
  readonly line?: number;
  readonly column?: number;
  readonly solidityError?: string;
  readonly details: Readonly<Record<string, ErrorDetail>>;

  constructor(
    code: ToolchainErrorCode,
    options: {
      readonly offset?: number;
      readonly line?: number;
      readonly column?: number;
      readonly details?: Readonly<Record<string, ErrorDetail>>;
    } = {}
  ) {
    super(code);
    this.name = "ToolchainError";
    this.code = code;
    const solidityError = SOLIDITY_ERROR_BY_TOOLCHAIN_CODE[code];
    if (solidityError !== undefined) this.solidityError = solidityError;
    if (options.offset !== undefined) this.offset = options.offset;
    if (options.line !== undefined) this.line = options.line;
    if (options.column !== undefined) this.column = options.column;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function isToolchainError(error: unknown): error is ToolchainError {
  return error instanceof ToolchainError;
}

export function fail(
  code: ToolchainErrorCode,
  options: {
    readonly offset?: number;
    readonly line?: number;
    readonly column?: number;
    readonly details?: Readonly<Record<string, ErrorDetail>>;
  } = {}
): never {
  throw new ToolchainError(code, options);
}
