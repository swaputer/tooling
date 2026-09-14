import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { compileTinySol } from "./codegen.js";
import { ToolchainErrorCode, fail } from "./errors.js";
import type { CompileTinySolResult } from "./compiler-types.js";

export interface CompileTinySolProjectOptions {
  readonly projectRoot: string;
  readonly entry: string;
  readonly includeSyntax?: boolean;
}

export interface CompileTinySolProjectResult extends CompileTinySolResult {
  readonly modules: readonly string[];
  readonly moduleHashes: Readonly<Record<string, string>>;
  readonly importLockHash: string;
  readonly bundledSource: string;
}

interface ImportLock { readonly version: 1; readonly imports: Readonly<Record<string, { readonly path: string; readonly sha256: string }>> }

const IMPORT = /\bimport\s+["']([^"']+)["']\s*;/g;
const LIBRARY = /\blibrary\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate); return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function logical(root: string, path: string): string { return relative(root, path).split(sep).join("/"); }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function closingBrace(source: string, open: number): number {
  let depth = 0; let line = false; let block = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]; const next = source[index + 1];
    if (line) { if (char === "\n") line = false; continue; }
    if (block) { if (char === "*" && next === "/") { block = false; index += 1; } continue; }
    if (char === "/" && next === "/") { line = true; index += 1; continue; }
    if (char === "/" && next === "*") { block = true; index += 1; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
  }
  fail(ToolchainErrorCode.PARSE_EXPECTED_TOKEN, { details: { expected: "}", actual: "<eof>" } });
}

function extractLibraries(source: string): { readonly remainder: string; readonly functions: readonly string[]; readonly names: readonly string[] } {
  const functions: string[] = []; const names: string[] = []; let remainder = ""; let cursor = 0; LIBRARY.lastIndex = 0;
  for (let match = LIBRARY.exec(source); match !== null; match = LIBRARY.exec(source)) {
    const open = source.indexOf("{", match.index); const close = closingBrace(source, open); const name = match[1]!; const body = source.slice(open + 1, close);
    remainder += source.slice(cursor, match.index); cursor = close + 1; LIBRARY.lastIndex = cursor;
    if (/\b(?:contract|interface|constructor|event|mapping|struct|enum|const)\b/.test(body)) fail(ToolchainErrorCode.LIBRARY_STATE, { details: { library: name } });
    const declarations = [...body.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)([^\{]*)\{/g)];
    if (declarations.length === 0 || declarations.some((item) => !/\bpure\b/.test(item[2] ?? ""))) fail(ToolchainErrorCode.LIBRARY_STATE, { details: { library: name, requirement: "pure-functions-only" } });
    let linked = body;
    for (const declaration of declarations) linked = linked.replace(new RegExp(`\\bfunction\\s+${declaration[1]}\\b`), `function ${name}_${declaration[1]}`);
    linked = linked.replace(/\bpure\b/g, "internal view"); functions.push(linked.trim()); names.push(name);
  }
  remainder += source.slice(cursor);
  return { remainder, functions: Object.freeze(functions), names: Object.freeze(names) };
}

function inject(entry: string, libraryFunctions: readonly string[]): string {
  if (libraryFunctions.length === 0) return entry;
  const close = entry.lastIndexOf("}"); if (close < 0) fail(ToolchainErrorCode.PARSE_EXPECTED_TOKEN, { details: { expected: "}", actual: "<eof>" } });
  return `${entry.slice(0, close)}\n${libraryFunctions.join("\n")}\n${entry.slice(close)}`;
}

export async function compileTinySolProject(options: CompileTinySolProjectOptions): Promise<CompileTinySolProjectResult> {
  if (isAbsolute(options.entry)) fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: options.entry } });
  const root = await realpath(options.projectRoot); const entryPath = await realpath(resolve(root, options.entry));
  if (!inside(root, entryPath)) fail(ToolchainErrorCode.IMPORT_OUTSIDE_ROOT, { details: { path: options.entry } });
  const modules = new Map<string, string>(); const moduleHashes = new Map<string, string>(); const visiting: string[] = [];
  let lock: ImportLock | undefined; let importLockHash = "none";
  const loadLock = async (): Promise<ImportLock> => {
    if (lock !== undefined) return lock;
    let source: string; try { source = await readFile(resolve(root, "tinysol.lock.json"), "utf8"); } catch { fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: "tinysol.lock.json", reason: "missing-lockfile" } }); }
    let parsed: unknown; try { parsed = JSON.parse(source); } catch { fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: "tinysol.lock.json", reason: "invalid-json" } }); }
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1 || typeof (parsed as { imports?: unknown }).imports !== "object" || (parsed as { imports?: unknown }).imports === null) fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: "tinysol.lock.json", reason: "invalid-schema" } });
    lock = parsed as ImportLock; importLockHash = sha256(source); return lock;
  };
  const visit = async (path: string, expectedHash?: string): Promise<void> => {
    const name = logical(root, path); if (visiting.includes(name)) fail(ToolchainErrorCode.IMPORT_CYCLE, { details: { cycle: [...visiting, name].join(" -> ") } });
    if (modules.has(name)) return; visiting.push(name);
    const raw = await readFile(path); const actualHash = sha256(raw); if (expectedHash !== undefined && actualHash !== expectedHash.toLowerCase()) fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: name, reason: "hash-mismatch", expected: expectedHash.toLowerCase(), actual: actualHash } });
    const source = raw.toString("utf8").replace(/\r\n?/g, "\n"); const imports = [...source.matchAll(IMPORT)]; moduleHashes.set(name, actualHash);
    if (/^\s*import\b/m.test(source.replace(IMPORT, ""))) fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: name } });
    for (const item of imports) {
      const specifier = item[1]!;
      let candidate: string; let pinnedHash: string | undefined;
      if (specifier.startsWith("./") || specifier.startsWith("../")) candidate = resolve(dirname(path), specifier);
      else {
        if (isAbsolute(specifier) || /^\w+:\/\//.test(specifier)) fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: specifier, reason: "non-local-import" } });
        const entry = (await loadLock()).imports[specifier];
        if (entry === undefined || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(entry.sha256) || isAbsolute(entry.path)) fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: specifier, reason: "missing-or-invalid-lock-entry" } });
        candidate = resolve(root, entry.path); pinnedHash = entry.sha256;
      }
      if (!inside(root, candidate)) fail(ToolchainErrorCode.IMPORT_OUTSIDE_ROOT, { details: { path: specifier } });
      let imported: string; try { imported = await realpath(candidate); } catch { fail(ToolchainErrorCode.IMPORT_INVALID, { details: { path: specifier } }); }
      if (!inside(root, imported)) fail(ToolchainErrorCode.IMPORT_OUTSIDE_ROOT, { details: { path: specifier } });
      await visit(imported, pinnedHash);
    }
    visiting.pop(); modules.set(name, source.replace(IMPORT, "").trim());
  };
  await visit(entryPath);
  const entryName = logical(root, entryPath); const libraries: string[] = []; const libraryNames: string[] = []; const prefixes: string[] = []; let entry = "";
  for (const [name, source] of modules) {
    const extracted = extractLibraries(source); libraries.push(...extracted.functions); libraryNames.push(...extracted.names);
    if (name === entryName) entry = extracted.remainder.trim(); else if (extracted.remainder.trim().length > 0) prefixes.push(extracted.remainder.trim());
  }
  let bundledSource = `${prefixes.join("\n")}\n${inject(entry, libraries)}`.trim();
  for (const library of libraryNames) bundledSource = bundledSource.replace(new RegExp(`\\b${library}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, "g"), `${library}_$1(`);
  bundledSource += "\n";
  const compiled = compileTinySol(bundledSource, { sourceName: entryName, ...(options.includeSyntax === undefined ? {} : { includeSyntax: options.includeSyntax }) });
  return Object.freeze({ ...compiled, modules: Object.freeze([...modules.keys()].sort()), moduleHashes: Object.freeze(Object.fromEntries([...moduleHashes].sort(([left], [right]) => left.localeCompare(right)))), importLockHash, bundledSource });
}
