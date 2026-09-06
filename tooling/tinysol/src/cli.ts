#!/usr/bin/env node
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./abi.js";
import { assemble } from "./assembler.js";
import { bytesToHex } from "./bytes.js";
import { disassemble } from "./disassembler.js";
import { isToolchainError, ToolchainError, ToolchainErrorCode } from "./errors.js";
import { INSTRUCTIONS, ISA_FILE_KECCAK, ISA_FILE_SHA256, ISA_VERSION } from "./isa.js";
import { encodeBuildManifest } from "./manifest.js";
import { inspectProgramPackage, programPackageCodeHash, PROGRAM_PACKAGE_MAGIC, validateProgramPackage } from "./package.js";
import { analyzeCode } from "./validator.js";
import { checkTinySol, compileTinySol, encodeCompilerArtifact } from "./codegen.js";
import { lexTinySol } from "./lexer.js";
import { parseTinySol } from "./parser.js";
import { simulateMiniVM } from "./simulator.js";
import { estimateMiniVMFee } from "./estimator.js";
import type { EstimateMiniVMInput, SimulateMiniVMInput } from "./simulator-types.js";

type Options = Readonly<Record<string, string | boolean>>;

const USAGE = `TinySol toolchain

Usage:
  tinysol isa check
  tinysol asm --input <file> --output <file> [--manifest <file>] [--force]
  tinysol disasm --input <file> --output <file> [--force]
  tinysol validate --input <file>
  tinysol inspect --input <file> [--json]
  tinysol hash --input <file>
  tinysol check --input <file>
  tinysol ast --input <file> --json
  tinysol compile --input <file> --output <file> --abi <file> --events <file> --storage-layout <file> --manifest <file> --assembly <file> --source-map <file> [--force]
  tinysol simulate --input <file>
  tinysol estimate --input <file>`;

function parseOptions(args: readonly string[]): Options {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("--")) throw new ToolchainError(ToolchainErrorCode.CLI_USAGE);
    const name = token.slice(2);
    if (name === "json" || name === "force") {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new ToolchainError(ToolchainErrorCode.CLI_USAGE);
    options[name] = value;
    index += 1;
  }
  return options;
}

function required(options: Options, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) throw new ToolchainError(ToolchainErrorCode.CLI_USAGE);
  return value;
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false);
}

async function safeWrite(input: string, output: string, data: string | Uint8Array, force: boolean): Promise<void> {
  if (resolve(input) === resolve(output)) throw new ToolchainError(ToolchainErrorCode.INPUT_OUTPUT_COLLISION);
  if (!force && await exists(output)) throw new ToolchainError(ToolchainErrorCode.OUTPUT_EXISTS);
  await writeFile(output, data);
}

async function atomicWriteSet(
  input: string,
  outputs: readonly Readonly<{ path: string; data: string | Uint8Array }>[],
  force: boolean
): Promise<void> {
  const resolvedInput = resolve(input);
  const targets = outputs.map((item) => resolve(item.path));
  if (new Set(targets).size !== targets.length || targets.includes(resolvedInput)) throw new ToolchainError(ToolchainErrorCode.INPUT_OUTPUT_COLLISION);
  if (!force) for (const target of targets) if (await exists(target)) throw new ToolchainError(ToolchainErrorCode.OUTPUT_EXISTS);
  const temporaries = outputs.map((item, index) => `${item.path}.tinysol-tmp-${process.pid}-${index}`);
  const committed: string[] = [];
  try {
    for (let index = 0; index < outputs.length; index += 1) await writeFile(temporaries[index]!, outputs[index]!.data);
    for (let index = 0; index < outputs.length; index += 1) { await rename(temporaries[index]!, outputs[index]!.path); committed.push(outputs[index]!.path); }
  } catch (error) {
    await Promise.all(temporaries.map((path) => unlink(path).catch(() => undefined)));
    await Promise.all(committed.map((path) => unlink(path).catch(() => undefined)));
    throw error;
  }
}

function json(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function isPackage(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytesToHex(bytes.slice(0, 4)) === PROGRAM_PACKAGE_MAGIC;
}

async function main(args: readonly string[]): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if ((command === "--help" || command === "help") && subcommand === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "isa" && subcommand === "check" && rest.length === 0) {
    process.stdout.write(json({ version: ISA_VERSION, opcodeCount: INSTRUCTIONS.length, keccak256: ISA_FILE_KECCAK, sha256: ISA_FILE_SHA256, status: "verified" }));
    return;
  }
  if (command === "asm") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    const input = required(options, "input");
    const output = required(options, "output");
    const source = await readFile(input, "utf8");
    const result = assemble(source);
    const manifestPath = options.manifest;
    if (typeof manifestPath === "string" && resolve(manifestPath) === resolve(output)) {
      throw new ToolchainError(ToolchainErrorCode.INPUT_OUTPUT_COLLISION);
    }
    await safeWrite(input, output, result.packageBytes, options.force === true);
    if (typeof manifestPath === "string") await safeWrite(input, manifestPath, encodeBuildManifest(result.manifest), options.force === true);
    process.stdout.write(json({ codeHash: result.codeHash, codeLength: result.code.length, output: "written" }));
    return;
  }
  if (command === "disasm") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    const input = required(options, "input");
    const output = required(options, "output");
    const result = disassemble(await readFile(input));
    await safeWrite(input, output, result.canonicalText, options.force === true);
    process.stdout.write(json({ instructionCount: result.instructions.length, kind: result.kind, output: "written" }));
    return;
  }
  if (command === "validate") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    const bytes = new Uint8Array(await readFile(required(options, "input")));
    const result = isPackage(bytes) ? validateProgramPackage(bytes).codeValidation : analyzeCode(bytes).consensus;
    process.stdout.write(json({ valid: true, codeLength: result.codeLength, instructionCount: result.instructions.length }));
    return;
  }
  if (command === "inspect") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    const result = inspectProgramPackage(new Uint8Array(await readFile(required(options, "input"))));
    process.stdout.write(json(result));
    return;
  }
  if (command === "hash") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    const bytes = new Uint8Array(await readFile(required(options, "input")));
    process.stdout.write(json({ hash: programPackageCodeHash(bytes), length: bytes.length }));
    return;
  }
  if (command === "check") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    const input = required(options, "input");
    const source = await readFile(input, "utf8");
    const checked = checkTinySol(source, { sourceName: input.split(/[\\/]/).pop() ?? "input.tiny.sol" });
    process.stdout.write(json({ valid: true, contract: checked.program.contract.name, diagnostics: checked.diagnostics }));
    return;
  }
  if (command === "ast") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    if (options.json !== true) throw new ToolchainError(ToolchainErrorCode.CLI_USAGE);
    const input = required(options, "input");
    const source = await readFile(input, "utf8");
    process.stdout.write(json(parseTinySol(lexTinySol(source), { sourceName: input.split(/[\\/]/).pop() ?? "input.tiny.sol" })));
    return;
  }
  if (command === "compile") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    const input = required(options, "input");
    const paths = {
      output: required(options, "output"), abi: required(options, "abi"), events: required(options, "events"),
      storage: required(options, "storage-layout"), manifest: required(options, "manifest"), assembly: required(options, "assembly"), map: required(options, "source-map")
    };
    const source = await readFile(input, "utf8");
    const result = compileTinySol(source, { sourceName: input.split(/[\\/]/).pop() ?? "input.tiny.sol" });
    await atomicWriteSet(input, [
      { path: paths.output, data: result.packageBytes },
      { path: paths.abi, data: encodeCompilerArtifact(result.abi) },
      { path: paths.events, data: encodeCompilerArtifact(result.eventDescriptor) },
      { path: paths.storage, data: encodeCompilerArtifact(result.storageLayout) },
      { path: paths.manifest, data: encodeCompilerArtifact(result.manifest) },
      { path: paths.assembly, data: result.assembly },
      { path: paths.map, data: encodeCompilerArtifact(result.sourceMap) }
    ], options.force === true);
    process.stdout.write(json({ codeHash: result.codeHash, codeLength: result.code.length, outputs: 7 }));
    return;
  }
  if (command === "simulate" || command === "estimate") {
    const options = parseOptions([subcommand, ...rest].filter((item): item is string => item !== undefined));
    const input = required(options, "input");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(input, "utf8")); }
    catch { throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID, { details: { field: "input-json" } }); }
    const result = command === "simulate"
      ? simulateMiniVM(parsed as SimulateMiniVMInput)
      : estimateMiniVMFee(parsed as EstimateMiniVMInput);
    process.stdout.write(json(result));
    if (("success" in result && !result.success) || ("signable" in result && !result.signable)) process.exitCode = 1;
    return;
  }
  throw new ToolchainError(ToolchainErrorCode.CLI_USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const normalized = isToolchainError(error) ? error : new ToolchainError(ToolchainErrorCode.INVALID_INPUT);
  process.stderr.write(json({
    error: normalized.code,
    ...(normalized.offset === undefined ? {} : { offset: normalized.offset }),
    ...(normalized.line === undefined ? {} : { line: normalized.line }),
    ...(normalized.column === undefined ? {} : { column: normalized.column }),
    ...(normalized.solidityError === undefined ? {} : { solidityError: normalized.solidityError }),
    details: normalized.details
  }));
  process.exitCode = normalized.code === ToolchainErrorCode.CLI_USAGE ? 2 : 1;
});
