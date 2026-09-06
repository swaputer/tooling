import { ToolchainError, isToolchainError } from "./errors.js";
import type { TinySolDiagnostic } from "./compiler-types.js";

export function formatDiagnostics(input: readonly TinySolDiagnostic[] | TinySolDiagnostic | unknown): string {
  const values = Array.isArray(input) ? input : [input];
  return values.map((item) => {
    if (isToolchainError(item)) {
      const location = item.line === undefined ? "" : `:${item.line}:${item.column ?? 1}`;
      return `${item.code}${location}`;
    }
    const diagnostic = item as TinySolDiagnostic;
    const location = diagnostic.span === undefined ? "" : `:${diagnostic.span.start.line}:${diagnostic.span.start.column}`;
    return `${diagnostic.severity}:${diagnostic.code}${location}`;
  }).join("\n");
}

export function compilerErrorJson(error: unknown): Readonly<Record<string, unknown>> {
  const normalized = isToolchainError(error) ? error : new ToolchainError("COMPILATION_FAILED");
  return Object.freeze({ error: normalized.code, ...(normalized.offset === undefined ? {} : { offset: normalized.offset }), ...(normalized.line === undefined ? {} : { line: normalized.line }), ...(normalized.column === undefined ? {} : { column: normalized.column }), details: normalized.details });
}
