import { assemble } from "./assembler.js";
import { canonicalJson, eventTopic, functionSelector } from "./abi.js";
import { bytesToHex, type Bytes32 } from "./bytes.js";
import { ToolchainErrorCode, fail } from "./errors.js";
import { buildEventDescriptor, buildStorageLayout, buildTinySolAbi, eventDescriptorHash, sourceHash } from "./compiler-artifacts.js";
import { ISA_FILE_KECCAK } from "./isa.js";
import { lexTinySol } from "./lexer.js";
import { parseTinySol } from "./parser.js";
import { lowerCompileTimeExtensions } from "./extensions.js";
import { resolveTinySol, tinySolSignature, typeCheckTinySol } from "./semantic.js";
import {
  TINYSOL_COMPILER_VERSION,
  TINYSOL_LANGUAGE_VERSION,
  TINYSOL_OPTIMIZATION_PROFILE,
  type CompileTinySolOptions,
  type CompileTinySolResult,
  type LoweredTinySol,
  type SourceSpan,
  type TinySolAbi,
  type TinySolBlock,
  type TinySolBuildManifest,
  type TinySolCompilerIdentity,
  type TinySolEventDeclaration,
  type TinySolExpression,
  type TinySolFunctionDeclaration,
  type TinySolProgram,
  type TinySolScalarType,
  type TinySolSourceMapEntry,
  type TinySolStatement,
  type TinySolStorageLayout,
  type TypedTinySol
} from "./compiler-types.js";
import { tinySolIntegerBounds, tinySolIntegerInfo, type TinySolIntegerType } from "./compiler-types.js";
import { COMPILER_DEPENDENCY_LOCK_SHA256, COMPILER_SOURCE_FINGERPRINT } from "./generated-compiler-identity.js";

const UINT256_MODULUS = 1n << 256n;
const MAP_SCRATCH = 0x1000;
const CALL_BASE = 0x2000;
const CALL_STRIDE = 0x400;
const CALL_OUTPUT_DELTA = 0x300;
const EVENT_BASE = 0x4000;
const INTERNAL_BASE = 0x6000;
const INTERNAL_STRIDE = 0x400;
const INTERNAL_RETURN_SLOT_OFFSET = 0x3e0;
const RETURN_BASE = 0x5000;
const ERROR_BASE = 0x5800;
const ARITHMETIC_SCRATCH = 0x5d00;

class Emitter {
  readonly lines: string[] = [];
  readonly spans = new Map<number, SourceSpan>();
  private labelCounter = 0;
  emit(line: string, span?: SourceSpan): void { this.lines.push(line); if (span !== undefined && !line.endsWith(":")) this.spans.set(this.lines.length, span); }
  label(prefix: string, span?: SourceSpan): string { const label = `__${prefix}_${this.labelCounter++}`; this.emit(`${label}:`); this.emit("JUMPDEST", span); return label; }
  fresh(prefix: string): string { return `__${prefix}_${this.labelCounter++}`; }
  namedLabel(name: string, span?: SourceSpan): void { this.emit(`${name}:`); this.emit("JUMPDEST", span); }
  push(value: bigint, span?: SourceSpan, forceWidth?: number): void {
    let normalized = value; if (normalized < 0n) normalized = (normalized % UINT256_MODULUS + UINT256_MODULUS) % UINT256_MODULUS;
    if (normalized >= UINT256_MODULUS) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { details: { width: 32 } });
    if (normalized === 0n && forceWidth === undefined) { this.emit("PUSH0", span); return; }
    const width = forceWidth ?? Math.max(1, Math.ceil(normalized.toString(16).length / 2));
    this.emit(`PUSH${width} 0x${normalized.toString(16).padStart(width * 2, "0")}`, span);
  }
  pushLabel(label: string, span?: SourceSpan): void { this.emit(`.pushlabel ${label}`, span); }
  jump(label: string, span?: SourceSpan): void { this.pushLabel(label, span); this.emit("JUMP", span); }
  jumpIf(label: string, span?: SourceSpan): void { this.pushLabel(label, span); this.emit("JUMPI", span); }
  text(): string { return `${this.lines.join("\n")}\n`; }
}

interface FunctionContext {
  readonly emitter: Emitter;
  readonly typed: TypedTinySol;
  readonly abi: TinySolAbi;
  readonly storage: TinySolStorageLayout;
  readonly locals: ReadonlyMap<string, number>;
  readonly localTypes: ReadonlyMap<string, TinySolScalarType>;
  readonly returns: readonly TinySolScalarType[];
  readonly functionName: string;
  readonly internalRoutines: Set<string>;
  readonly internalEmitted: Set<string>;
  readonly revertLabel: string;
  readonly isInternal: boolean;
  readonly internalDepth: number;
  readonly events: ReadonlyMap<string, TinySolEventDeclaration>;
  readonly interfaces: ReadonlyMap<string, TinySolProgram["interfaces"][number]>;
  readonly loops: { readonly breakLabel: string; readonly continueLabel: string }[];
  callDepth: number;
}

function sourceLocation(span: SourceSpan): { readonly line: number; readonly column: number; readonly offset: number } {
  return { line: span.start.line, column: span.start.column, offset: span.start.byteOffset };
}

function collectLocals(block: TinySolBlock, output: string[]): void {
  for (const statement of block.statements) {
    if (statement.kind === "VariableDeclaration") output.push(statement.name);
    else if (statement.kind === "TupleAssignment") { for (const binding of statement.bindings) if (binding.type !== undefined) output.push(binding.name); }
    else if (statement.kind === "Block") collectLocals(statement, output);
    else if (statement.kind === "IfStatement") { collectLocals(statement.consequent, output); if (statement.alternate !== undefined) collectLocals(statement.alternate, output); }
    else if (statement.kind === "WhileStatement") collectLocals(statement.body, output);
    else if (statement.kind === "ForStatement") { if (statement.initializer?.kind === "VariableDeclaration") output.push(statement.initializer.name); collectLocals(statement.body, output); }
  }
}

function localLayout(parameters: readonly { readonly name: string }[], block: TinySolBlock, base = 0): ReadonlyMap<string, number> {
  const names = parameters.map((item) => item.name); collectLocals(block, names);
  return new Map(names.map((name, index) => [name, base + index * 32]));
}

function collectLocalTypes(block: TinySolBlock, output: Map<string, TinySolScalarType>): void {
  for (const statement of block.statements) {
    if (statement.kind === "VariableDeclaration") output.set(statement.name, statement.type.name);
    else if (statement.kind === "TupleAssignment") { for (const binding of statement.bindings) if (binding.type !== undefined) output.set(binding.name, binding.type.name); }
    else if (statement.kind === "Block") collectLocalTypes(statement, output);
    else if (statement.kind === "IfStatement") { collectLocalTypes(statement.consequent, output); if (statement.alternate !== undefined) collectLocalTypes(statement.alternate, output); }
    else if (statement.kind === "WhileStatement") collectLocalTypes(statement.body, output);
    else if (statement.kind === "ForStatement") { if (statement.initializer?.kind === "VariableDeclaration") output.set(statement.initializer.name, statement.initializer.type.name); collectLocalTypes(statement.body, output); }
  }
}

function localTypeLayout(parameters: readonly { readonly name: string; readonly type: { readonly name: TinySolScalarType } }[], block: TinySolBlock): ReadonlyMap<string, TinySolScalarType> {
  const types = new Map(parameters.map((parameter) => [parameter.name, parameter.type.name] as const)); collectLocalTypes(block, types); return types;
}

function storeMemory(emitter: Emitter, offset: number, span?: SourceSpan): void { emitter.push(BigInt(offset), span); emitter.emit("MSTORE", span); }
function loadMemory(emitter: Emitter, offset: number, span?: SourceSpan): void { emitter.push(BigInt(offset), span); emitter.emit("MLOAD", span); }
function revertIfFalse(context: FunctionContext, span: SourceSpan): void { context.emitter.emit("ISZERO", span); context.emitter.jumpIf(context.revertLabel, span); }
function stateItem(context: FunctionContext, name: string) { const item = context.storage.items.find((candidate) => candidate.name === name); if (item === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { details: { name } }); return item; }

function mappingSlot(expression: Extract<TinySolExpression, { readonly kind: "IndexExpression" }>, context: FunctionContext): void {
  if (expression.object.kind !== "IdentifierExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(expression.span), details: { feature: "unlowered-aggregate-index" } });
  const item = stateItem(context, expression.object.name);
  if (item.length !== undefined && item.slot !== undefined) {
    compileExpression(expression.index, context); context.emitter.emit("DUP1", expression.span); context.emitter.push(BigInt(item.length), expression.span); context.emitter.emit("LT", expression.span); revertIfFalse(context, expression.span); context.emitter.push(BigInt(item.slot), expression.span); context.emitter.emit("ADD", expression.span); return;
  }
  if (item.namespace === undefined) fail(ToolchainErrorCode.INVALID_OPERATION);
  context.emitter.push(BigInt(item.namespace), expression.span, 32); storeMemory(context.emitter, MAP_SCRATCH, expression.span);
  compileExpression(expression.index, context); storeMemory(context.emitter, MAP_SCRATCH + 32, expression.index.span);
  context.emitter.push(64n, expression.span); context.emitter.push(BigInt(MAP_SCRATCH), expression.span); context.emitter.emit("KECCAK256", expression.span);
}

function localArrayAddress(expression: Extract<TinySolExpression, { readonly kind: "LocalArrayIndexExpression" }>, context: FunctionContext): void {
  const base = context.locals.get(expression.baseName); if (base === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...sourceLocation(expression.span), details: { name: expression.baseName } });
  compileExpression(expression.index, context); context.emitter.emit("DUP1", expression.span); context.emitter.push(BigInt(expression.length), expression.span); context.emitter.emit("LT", expression.span); revertIfFalse(context, expression.span);
  context.emitter.push(32n, expression.span); context.emitter.emit("MUL", expression.span); context.emitter.push(BigInt(base), expression.span); context.emitter.emit("ADD", expression.span);
}

function nestedArrayOffset(expression: Extract<TinySolExpression, { readonly kind: "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" }>, context: FunctionContext): void {
  const e = context.emitter; if (expression.indices.length !== expression.dimensions.length || expression.indices.length === 0) fail(ToolchainErrorCode.INVALID_OPERATION);
  expression.indices.forEach((index, position) => {
    if (position > 0) { e.push(BigInt(expression.dimensions[position]!), expression.span); e.emit("MUL", expression.span); }
    compileExpression(index, context); e.emit("DUP1", index.span); e.push(BigInt(expression.dimensions[position]!), index.span); e.emit("LT", index.span); revertIfFalse(context, index.span);
    if (position > 0) e.emit("ADD", expression.span);
  });
}

function nestedStateArraySlot(expression: Extract<TinySolExpression, { readonly kind: "NestedArrayIndexExpression" }>, context: FunctionContext): void {
  const item = stateItem(context, expression.object.name); if (item.slot === undefined || item.length !== expression.dimensions.reduce((product, dimension) => product * dimension, 1)) fail(ToolchainErrorCode.INVALID_OPERATION);
  nestedArrayOffset(expression, context); context.emitter.push(BigInt(item.slot), expression.span); context.emitter.emit("ADD", expression.span);
}

function localNestedArrayAddress(expression: Extract<TinySolExpression, { readonly kind: "LocalNestedArrayIndexExpression" }>, context: FunctionContext): void {
  const base = context.locals.get(expression.baseName); if (base === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...sourceLocation(expression.span), details: { name: expression.baseName } });
  nestedArrayOffset(expression, context); context.emitter.push(32n, expression.span); context.emitter.emit("MUL", expression.span); context.emitter.push(BigInt(base), expression.span); context.emitter.emit("ADD", expression.span);
}

function nestedStorageSlot(expression: Extract<TinySolExpression, { readonly kind: "NestedStorageIndexExpression" }>, context: FunctionContext): void {
  const item = stateItem(context, expression.object.name); if (item.namespace === undefined) fail(ToolchainErrorCode.INVALID_OPERATION);
  const e = context.emitter;
  e.push(BigInt(item.namespace), expression.span, 32); storeMemory(e, MAP_SCRATCH, expression.span);
  compileExpression(expression.key, context); storeMemory(e, MAP_SCRATCH + 32, expression.key.span);
  e.push(64n, expression.span); e.push(BigInt(MAP_SCRATCH), expression.span); e.emit("KECCAK256", expression.span); storeMemory(e, MAP_SCRATCH, expression.span);
  nestedArrayOffset(Object.freeze({ kind: "NestedArrayIndexExpression", object: expression.object, indices: expression.indices, dimensions: expression.dimensions, elementType: expression.elementType, span: expression.span }), context); storeMemory(e, MAP_SCRATCH + 32, expression.span);
  e.push(64n, expression.span); e.push(BigInt(MAP_SCRATCH), expression.span); e.emit("KECCAK256", expression.span);
}

function contextOpcode(path: string): string {
  const values: Readonly<Record<string, string>> = Object.freeze({
    "msg.sender": "CALLER", "this.id": "ADDRESS", "tx.actor": "TXACTOR", "world.id": "WORLDID", "world.executionHeight": "EXECUTIONHEIGHT",
    "tx.router": "TXROUTER", "tx.executor": "TXEXECUTOR", "tx.recipient": "TXRECIPIENT",
    "buy.ethIn": "ETHIN", "buy.grossTokenOut": "TOKENOUT", "buy.tickAfter": "TICK", "block.number": "NUMBER",
    "block.timestamp": "TIMESTAMP", "gas.bytePrice": "BYTEPRICE", "gas.bytesUsed": "BYTESUSED", "gas.bytesRemaining": "BYTESREMAINING"
  });
  const opcode = values[path]; if (opcode === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { details: { name: path } }); return opcode;
}

function signedExpression(expression: TinySolExpression, context: FunctionContext): boolean {
  const type = context.typed.expressionTypes.get(expression); return type !== undefined && tinySolIntegerInfo(type)?.signed === true;
}

function validateWord(type: TinySolScalarType, context: FunctionContext, span: SourceSpan): void {
  if (type === "bool") { context.emitter.emit("DUP1", span); context.emitter.push(1n, span); context.emitter.emit("GT", span); context.emitter.jumpIf(context.revertLabel, span); return; }
  if (type === "address") { context.emitter.emit("DUP1", span); context.emitter.push((1n << 160n) - 1n, span, 20); context.emitter.emit("GT", span); context.emitter.jumpIf(context.revertLabel, span); return; }
  const info = tinySolIntegerInfo(type); if (info === undefined || info.width === 256) return;
  const bounds = tinySolIntegerBounds(type as TinySolIntegerType);
  if (!info.signed) { context.emitter.emit("DUP1", span); context.emitter.push(bounds.maximum, span); context.emitter.emit("GT", span); context.emitter.jumpIf(context.revertLabel, span); return; }
  context.emitter.emit("DUP1", span); context.emitter.push(bounds.minimum, span, 32); context.emitter.emit("SLT", span); context.emitter.jumpIf(context.revertLabel, span);
  context.emitter.emit("DUP1", span); context.emitter.push(bounds.maximum, span); context.emitter.emit("SGT", span); context.emitter.jumpIf(context.revertLabel, span);
}

function validateNarrowInteger(type: TinySolScalarType, context: FunctionContext, span: SourceSpan): void {
  const info = tinySolIntegerInfo(type); if (info !== undefined && info.width < 256) validateWord(type, context, span);
}

function validateNarrowMultiplication(type: TinySolScalarType, signed: boolean, context: FunctionContext, span: SourceSpan): void {
  const info = tinySolIntegerInfo(type); if (info === undefined || info.width === 256) return;
  const e = context.emitter;
  if (info.width <= 128) { e.emit("MUL", span); return; }
  e.emit("DUP1", span); storeMemory(e, ARITHMETIC_SCRATCH + 32, span);
  e.emit("DUP2", span); storeMemory(e, ARITHMETIC_SCRATCH, span);
  e.emit("MUL", span); e.emit("DUP1", span); storeMemory(e, ARITHMETIC_SCRATCH + 64, span);
  loadMemory(e, ARITHMETIC_SCRATCH + 32, span); e.emit("ISZERO", span);
  loadMemory(e, ARITHMETIC_SCRATCH + 64, span); loadMemory(e, ARITHMETIC_SCRATCH + 32, span); e.emit(signed ? "SDIV" : "DIV", span); loadMemory(e, ARITHMETIC_SCRATCH, span); e.emit("EQ", span); e.emit("OR", span); revertIfFalse(context, span);
}

function compileExpression(expression: TinySolExpression, context: FunctionContext): void {
  const e = context.emitter;
  if (expression.kind === "LiteralExpression") {
    if (expression.literalKind === "bool") e.push(expression.value === "true" ? 1n : 0n, expression.span);
    else e.push(BigInt(expression.value), expression.span, expression.literalKind === "bytes32" ? 32 : expression.literalKind === "address" ? 20 : undefined);
    return;
  }
  if (expression.kind === "IdentifierExpression") {
    const local = context.locals.get(expression.name);
    if (local !== undefined) loadMemory(e, local, expression.span);
    else { const item = stateItem(context, expression.name); if (item.slot === undefined) fail(ToolchainErrorCode.INVALID_OPERATION); e.push(BigInt(item.slot), expression.span); e.emit("SLOAD", expression.span); }
    return;
  }
  if (expression.kind === "ContextExpression") { e.emit(contextOpcode(expression.path), expression.span); return; }
  if (expression.kind === "IndexExpression") { mappingSlot(expression, context); e.emit("SLOAD", expression.span); return; }
  if (expression.kind === "LocalArrayIndexExpression") { localArrayAddress(expression, context); e.emit("MLOAD", expression.span); return; }
  if (expression.kind === "NestedArrayIndexExpression") { nestedStateArraySlot(expression, context); e.emit("SLOAD", expression.span); return; }
  if (expression.kind === "LocalNestedArrayIndexExpression") { localNestedArrayAddress(expression, context); e.emit("MLOAD", expression.span); return; }
  if (expression.kind === "NestedStorageIndexExpression") { nestedStorageSlot(expression, context); e.emit("SLOAD", expression.span); return; }
  if (expression.kind === "MemberExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(expression.span), details: { feature: "unlowered-member-expression" } });
  if (expression.kind === "StructLiteralExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(expression.span), details: { feature: "unlowered-struct-literal" } });
  if (expression.kind === "ArrayLiteralExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(expression.span), details: { feature: "unlowered-array-literal" } });
  if (expression.kind === "UnaryExpression") {
    if (expression.operator === "-" && expression.operand.kind === "LiteralExpression") { e.push(-BigInt(expression.operand.value), expression.span, 32); return; }
    compileExpression(expression.operand, context); e.emit(expression.operator === "!" ? "ISZERO" : expression.operator === "~" ? "NOT" : "PUSH0", expression.span);
    if (expression.operator === "-") e.emit("SWAP1", expression.span), e.emit("SUB", expression.span);
    const type = context.typed.expressionTypes.get(expression);
    if (type !== undefined && tinySolIntegerInfo(type) !== undefined) {
      const info = tinySolIntegerInfo(type)!;
      if (expression.operator === "~" && !info.signed && info.width < 256) { e.push((1n << BigInt(info.width)) - 1n, expression.span); e.emit("AND", expression.span); }
      else validateWord(type, context, expression.span);
    }
    return;
  }
  if (expression.kind === "BinaryExpression") {
    if (expression.operator === "&&" || expression.operator === "||") {
      const branch = e.fresh("logical_branch"); const end = e.fresh("logical_end");
      compileExpression(expression.left, context);
      if (expression.operator === "&&") e.emit("ISZERO", expression.left.span);
      e.jumpIf(branch, expression.span); compileExpression(expression.right, context); e.jump(end, expression.span);
      e.namedLabel(branch, expression.span); e.push(expression.operator === "&&" ? 0n : 1n, expression.span); e.namedLabel(end, expression.span); return;
    }
    compileExpression(expression.left, context); compileExpression(expression.right, context);
    const signed = signedExpression(expression.left, context) || signedExpression(expression.right, context);
    const op: Readonly<Record<string, string>> = Object.freeze({
      "+": "ADD", "-": "SUB", "*": "MUL", "/": signed ? "SDIV" : "DIV", "%": signed ? "SMOD" : "MOD",
      "<": signed ? "SLT" : "LT", ">": signed ? "SGT" : "GT", "==": "EQ", "&": "AND", "|": "OR", "^": "XOR",
      "<<": "SHL", ">>": signed ? "SAR" : "SHR"
    });
    if (expression.operator === "!=") { e.emit("EQ", expression.span); e.emit("ISZERO", expression.span); return; }
    if (expression.operator === "<=") { e.emit(signed ? "SGT" : "GT", expression.span); e.emit("ISZERO", expression.span); return; }
    if (expression.operator === ">=") { e.emit(signed ? "SLT" : "LT", expression.span); e.emit("ISZERO", expression.span); return; }
    const mnemonic = op[expression.operator]; if (mnemonic === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { details: { operation: expression.operator } });
    const resultType = context.typed.expressionTypes.get(expression);
    if (expression.operator === "*" && resultType !== undefined && tinySolIntegerInfo(resultType)?.width !== 256) validateNarrowMultiplication(resultType, signed, context, expression.span);
    else e.emit(mnemonic, expression.span);
    if (resultType !== undefined) validateNarrowInteger(resultType, context, expression.span);
    return;
  }
  if (expression.kind === "ConditionalExpression") {
    const alternate = e.fresh("conditional_else"); const end = e.fresh("conditional_end");
    compileExpression(expression.condition, context); e.emit("ISZERO", expression.condition.span); e.jumpIf(alternate, expression.span);
    compileExpression(expression.consequent, context); e.jump(end, expression.span); e.namedLabel(alternate, expression.alternate.span); compileExpression(expression.alternate, context); e.namedLabel(end, expression.span); return;
  }
  if (expression.kind === "CastExpression") { compileExpression(expression.value, context); validateWord(expression.type.name, context, expression.span); return; }
  if (expression.kind === "ExternalCallExpression") {
    const declaration = context.interfaces.get(expression.interfaceName)!; const fn = declaration.functions.find((candidate) => candidate.name === expression.functionName)!;
    const depth = context.callDepth++; const base = CALL_BASE + depth * CALL_STRIDE; const output = base + CALL_OUTPUT_DELTA;
    e.push(BigInt(functionSelector(tinySolSignature(fn.name, fn.parameters.map((item) => item.name))) + "0".repeat(56)), expression.span, 32); storeMemory(e, base, expression.span);
    expression.arguments.forEach((argument, index) => { compileExpression(argument, context); storeMemory(e, base + 4 + index * 32, argument.span); });
    compileExpression(expression.target, context); e.push(BigInt(4 + expression.arguments.length * 32), expression.span); e.push(BigInt(base), expression.span); e.push(32n, expression.span); e.push(BigInt(output), expression.span); e.emit(expression.callKind === "call" ? "CALL" : "STATICCALL", expression.span); e.emit("POP", expression.span);
    e.emit("RETURNDATASIZE", expression.span); e.push(32n, expression.span); e.emit("EQ", expression.span); revertIfFalse(context, expression.span); loadMemory(e, output, expression.span); validateNarrowInteger(fn.returns[0]!.name, context, expression.span); context.callDepth -= 1; return;
  }
  if (expression.kind === "FunctionCallExpression") {
    if (expression.functionName === "keccak256") {
      compileExpression(expression.arguments[0]!, context); storeMemory(e, MAP_SCRATCH, expression.span); e.push(32n, expression.span); e.push(BigInt(MAP_SCRATCH), expression.span); e.emit("KECCAK256", expression.span); return;
    }
    if (expression.functionName === "ecrecover") { expression.arguments.forEach((argument) => compileExpression(argument, context)); e.emit("ECRECOVER", expression.span); return; }
    if (expression.functionName === "toAccount") { compileExpression(expression.arguments[0]!, context); return; }
    if (expression.functionName === "toAddress") { compileExpression(expression.arguments[0]!, context); e.emit("DUP1", expression.span); e.push((1n << 160n) - 1n, expression.span, 20); e.emit("GT", expression.span); e.jumpIf(context.revertLabel, expression.span); return; }
    const declaration = context.typed.program.contract.functions.find((candidate) => candidate.name === expression.functionName);
    if (declaration === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...sourceLocation(expression.span), details: { name: expression.functionName } });
    const calleeDepth = context.internalDepth + 1;
    const calleeBase = INTERNAL_BASE + calleeDepth * INTERNAL_STRIDE;
    const calleeReturnSlot = calleeBase + INTERNAL_RETURN_SLOT_OFFSET;
    const calleeLocals = localLayout(declaration.parameters, declaration.body, calleeBase);
    declaration.parameters.forEach((parameter, index) => {
      compileExpression(expression.arguments[index]!, context);
      const argumentOffset = calleeLocals.get(parameter.name);
      if (argumentOffset === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...sourceLocation(parameter.span), details: { name: parameter.name } });
      storeMemory(e, argumentOffset, expression.span);
    });
    const returnLabel = e.fresh("internal_return");
    if (calleeReturnSlot + 0x20 > calleeBase + INTERNAL_STRIDE) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...sourceLocation(expression.span), details: { feature: "internal-call-stack" } });
    e.pushLabel(returnLabel, expression.span);
    storeMemory(e, calleeReturnSlot, expression.span);
    e.jump(`__internal_${calleeDepth}_${declaration.name}`, expression.span);
    e.namedLabel(returnLabel, expression.span);
    const key = `${calleeDepth}::${declaration.name}`;
    context.internalRoutines.add(key);
    if (context.isInternal) {
      const continuation = e.fresh("internal_routine_end");
      e.jump(continuation, expression.span);
      compileInternalSubroutine(declaration, calleeDepth, context, context.internalRoutines, context.internalEmitted);
      e.namedLabel(continuation, expression.span);
    }
    return;
  }
  if (expression.kind === "StringLiteralExpression" || expression.kind === "MethodCallExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(expression.span), details: { feature: "unlowered-bounded-collection" } });
  const declaration = context.interfaces.get(expression.interfaceName)!; const parameters = declaration.constructor?.kind === "InterfaceConstructor" ? declaration.constructor.parameters : [];
  const depth = context.callDepth++; const base = CALL_BASE + depth * CALL_STRIDE;
  expression.arguments.forEach((argument, index) => { compileExpression(argument, context); storeMemory(e, base + index * 32, argument.span); });
  compileExpression(expression.codeHash, context); e.push(BigInt(parameters.length * 32), expression.span); e.push(BigInt(base), expression.span); e.emit("CREATE", expression.span); context.callDepth -= 1;
}

function compileAssignment(statement: Extract<TinySolStatement, { readonly kind: "Assignment" }>, context: FunctionContext): void {
  const compound = statement.operator;
  const targetType = (() => {
    if (statement.target.kind === "IdentifierExpression") return context.localTypes.get(statement.target.name) ?? stateItem(context, statement.target.name).type as TinySolScalarType;
    if (statement.target.kind === "IndexExpression") { if (statement.target.object.kind !== "IdentifierExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(statement.target.span), details: { feature: "unlowered-aggregate-index" } }); const item = stateItem(context, statement.target.object.name); return (item.elementType ?? item.valueType) as TinySolScalarType; }
    if (statement.target.kind === "LocalArrayIndexExpression") return statement.target.elementType;
    if (statement.target.kind === "NestedArrayIndexExpression" || statement.target.kind === "LocalNestedArrayIndexExpression") return statement.target.elementType;
    if (statement.target.kind === "NestedStorageIndexExpression") return statement.target.elementType;
    fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(statement.target.span), details: { feature: "unlowered-member-assignment" } });
  })();
  const applyCompound = (): void => {
    if (compound === undefined) return;
    const operator = compound.slice(0, -1); const signed = tinySolIntegerInfo(targetType)?.signed === true;
    const op: Readonly<Record<string, string>> = Object.freeze({ "+": "ADD", "-": "SUB", "*": "MUL", "/": signed ? "SDIV" : "DIV", "%": signed ? "SMOD" : "MOD", "&": "AND", "|": "OR", "^": "XOR", "<<": "SHL", ">>": signed ? "SAR" : "SHR" });
    const mnemonic = op[operator]; if (mnemonic === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...sourceLocation(statement.span), details: { operation: compound } });
    if (operator === "*" && tinySolIntegerInfo(targetType)?.width !== 256) validateNarrowMultiplication(targetType, signed, context, statement.span);
    else context.emitter.emit(mnemonic, statement.span);
    validateWord(targetType, context, statement.span);
  };
  if (statement.target.kind === "IdentifierExpression") {
    const local = context.locals.get(statement.target.name);
    if (local !== undefined) { if (compound !== undefined) loadMemory(context.emitter, local, statement.target.span); compileExpression(statement.value, context); applyCompound(); storeMemory(context.emitter, local, statement.span); }
    else { const item = stateItem(context, statement.target.name); if (compound !== undefined) { context.emitter.push(BigInt(item.slot!), statement.target.span); context.emitter.emit("SLOAD", statement.target.span); } compileExpression(statement.value, context); applyCompound(); context.emitter.push(BigInt(item.slot!), statement.span); context.emitter.emit("SSTORE", statement.span); }
  } else if (statement.target.kind === "IndexExpression") {
    if (compound === undefined) { compileExpression(statement.value, context); mappingSlot(statement.target, context); context.emitter.emit("SSTORE", statement.span); }
    else { mappingSlot(statement.target, context); context.emitter.emit("DUP1", statement.target.span); context.emitter.emit("SLOAD", statement.target.span); compileExpression(statement.value, context); applyCompound(); context.emitter.emit("SWAP1", statement.span); context.emitter.emit("SSTORE", statement.span); }
  }
  else if (statement.target.kind === "LocalArrayIndexExpression") {
    if (compound === undefined) { compileExpression(statement.value, context); localArrayAddress(statement.target, context); context.emitter.emit("MSTORE", statement.span); }
    else { localArrayAddress(statement.target, context); context.emitter.emit("DUP1", statement.target.span); context.emitter.emit("MLOAD", statement.target.span); compileExpression(statement.value, context); applyCompound(); context.emitter.emit("SWAP1", statement.span); context.emitter.emit("MSTORE", statement.span); }
  }
  else if (statement.target.kind === "NestedArrayIndexExpression") {
    if (compound === undefined) { compileExpression(statement.value, context); nestedStateArraySlot(statement.target, context); context.emitter.emit("SSTORE", statement.span); }
    else { nestedStateArraySlot(statement.target, context); context.emitter.emit("DUP1", statement.target.span); context.emitter.emit("SLOAD", statement.target.span); compileExpression(statement.value, context); applyCompound(); context.emitter.emit("SWAP1", statement.span); context.emitter.emit("SSTORE", statement.span); }
  }
  else if (statement.target.kind === "LocalNestedArrayIndexExpression") {
    if (compound === undefined) { compileExpression(statement.value, context); localNestedArrayAddress(statement.target, context); context.emitter.emit("MSTORE", statement.span); }
    else { localNestedArrayAddress(statement.target, context); context.emitter.emit("DUP1", statement.target.span); context.emitter.emit("MLOAD", statement.target.span); compileExpression(statement.value, context); applyCompound(); context.emitter.emit("SWAP1", statement.span); context.emitter.emit("MSTORE", statement.span); }
  }
  else if (statement.target.kind === "NestedStorageIndexExpression") {
    if (compound === undefined) { compileExpression(statement.value, context); nestedStorageSlot(statement.target, context); context.emitter.emit("SSTORE", statement.span); }
    else { nestedStorageSlot(statement.target, context); context.emitter.emit("DUP1", statement.target.span); context.emitter.emit("SLOAD", statement.target.span); compileExpression(statement.value, context); applyCompound(); context.emitter.emit("SWAP1", statement.span); context.emitter.emit("SSTORE", statement.span); }
  }
  else fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(statement.span), details: { feature: "unlowered-member-assignment" } });
}

function compileTupleAssignment(statement: Extract<TinySolStatement, { readonly kind: "TupleAssignment" }>, context: FunctionContext): void {
  const e = context.emitter;
  if (statement.value.kind === "FunctionCallExpression") compileExpression(statement.value, context);
  else {
    const expression = statement.value; const declaration = context.interfaces.get(expression.interfaceName)!; const fn = declaration.functions.find((candidate) => candidate.name === expression.functionName)!;
    const depth = context.callDepth++; const base = CALL_BASE + depth * CALL_STRIDE; const output = base + CALL_OUTPUT_DELTA; const outputSize = fn.returns.length * 32;
    e.push(BigInt(functionSelector(tinySolSignature(fn.name, fn.parameters.map((item) => item.name))) + "0".repeat(56)), expression.span, 32); storeMemory(e, base, expression.span);
    expression.arguments.forEach((argument, index) => { compileExpression(argument, context); storeMemory(e, base + 4 + index * 32, argument.span); });
    compileExpression(expression.target, context); e.push(BigInt(4 + expression.arguments.length * 32), expression.span); e.push(BigInt(base), expression.span); e.push(BigInt(outputSize), expression.span); e.push(BigInt(output), expression.span); e.emit(expression.callKind === "call" ? "CALL" : "STATICCALL", expression.span); e.emit("POP", expression.span);
    e.emit("RETURNDATASIZE", expression.span); e.push(BigInt(outputSize), expression.span); e.emit("EQ", expression.span); revertIfFalse(context, expression.span);
    fn.returns.forEach((type, index) => { loadMemory(e, output + index * 32, expression.span); validateInput(type.name, context, expression.span); }); context.callDepth -= 1;
  }
  for (let index = statement.bindings.length - 1; index >= 0; index -= 1) {
    const binding = statement.bindings[index]!; const local = context.locals.get(binding.name);
    if (local !== undefined) storeMemory(e, local, binding.span);
    else { const item = stateItem(context, binding.name); e.push(BigInt(item.slot!), binding.span); e.emit("SSTORE", binding.span); }
  }
}

function compileBlock(block: TinySolBlock, context: FunctionContext): void { for (const statement of block.statements) compileStatement(statement, context); }

function continuesCurrentLoop(block: TinySolBlock): boolean {
  return block.statements.some((statement) => statement.kind === "ContinueStatement"
    || statement.kind === "Block" && continuesCurrentLoop(statement)
    || statement.kind === "IfStatement" && (continuesCurrentLoop(statement.consequent) || statement.alternate !== undefined && continuesCurrentLoop(statement.alternate)));
}

function compileStatement(statement: TinySolStatement, context: FunctionContext): void {
  const e = context.emitter;
  if (statement.kind === "Block") { compileBlock(statement, context); return; }
  if (statement.kind === "VariableDeclaration") { if (statement.initializer !== undefined) compileExpression(statement.initializer, context); else e.push(0n, statement.span); storeMemory(e, context.locals.get(statement.name)!, statement.span); return; }
  if (statement.kind === "Assignment") { compileAssignment(statement, context); return; }
  if (statement.kind === "DeleteStatement") { compileAssignment(Object.freeze({ kind: "Assignment", target: statement.target, value: Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: "0", span: statement.span }), span: statement.span }), context); return; }
  if (statement.kind === "TupleAssignment") { compileTupleAssignment(statement, context); return; }
  if (statement.kind === "IfStatement") {
    const alternate = e.fresh("if_else"); const end = e.fresh("if_end");
    compileExpression(statement.condition, context); e.emit("ISZERO", statement.condition.span); e.jumpIf(statement.alternate === undefined ? end : alternate, statement.span); compileBlock(statement.consequent, context); e.jump(end, statement.span);
    if (statement.alternate !== undefined) { e.namedLabel(alternate, statement.alternate.span); compileBlock(statement.alternate, context); }
    e.namedLabel(end, statement.span); return;
  }
  if (statement.kind === "WhileStatement") {
    const head = e.fresh("while_head"); const end = e.fresh("while_end"); e.namedLabel(head, statement.span); compileExpression(statement.condition, context); e.emit("ISZERO", statement.condition.span); e.jumpIf(end, statement.span); context.loops.push(Object.freeze({ breakLabel: end, continueLabel: head })); compileBlock(statement.body, context); context.loops.pop(); e.jump(head, statement.span); e.namedLabel(end, statement.span); return;
  }
  if (statement.kind === "ForStatement") {
    if (statement.initializer !== undefined) compileStatement(statement.initializer, context); const head = e.fresh("for_head"); const needsUpdateLabel = continuesCurrentLoop(statement.body); const update = needsUpdateLabel ? e.fresh("for_update") : head; const end = e.fresh("for_end"); e.namedLabel(head, statement.span);
    if (statement.condition !== undefined) { compileExpression(statement.condition, context); e.emit("ISZERO", statement.condition.span); e.jumpIf(end, statement.span); }
    context.loops.push(Object.freeze({ breakLabel: end, continueLabel: update })); compileBlock(statement.body, context); context.loops.pop(); if (needsUpdateLabel) e.namedLabel(update, statement.span); if (statement.update !== undefined) compileStatement(statement.update, context); e.jump(head, statement.span); e.namedLabel(end, statement.span); return;
  }
  if (statement.kind === "BreakStatement" || statement.kind === "ContinueStatement") {
    const loop = context.loops.at(-1); if (loop === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...sourceLocation(statement.span), details: { operation: statement.kind === "BreakStatement" ? "break" : "continue", reason: "outside-loop" } });
    e.jump(statement.kind === "BreakStatement" ? loop.breakLabel : loop.continueLabel, statement.span); return;
  }
  if (statement.kind === "ReturnStatement") {
    if (context.isInternal) {
      if (statement.values.length !== context.returns.length) fail(ToolchainErrorCode.RETURN_MISMATCH, { details: { actual: statement.values.length, expected: context.returns.length }, line: statement.span.start.line, column: statement.span.start.column });
      statement.values.forEach((value, index) => { compileExpression(value, context); validateNarrowInteger(context.returns[index]!, context, value.span); });
      const returnSlot = INTERNAL_BASE + context.internalDepth * INTERNAL_STRIDE + INTERNAL_RETURN_SLOT_OFFSET;
      loadMemory(e, returnSlot, statement.span);
      e.emit("JUMP", statement.span);
      return;
    }
    statement.values.forEach((value, index) => { compileExpression(value, context); validateNarrowInteger(context.returns[index]!, context, value.span); storeMemory(e, RETURN_BASE + index * 32, value.span); }); e.push(BigInt(statement.values.length * 32), statement.span); e.push(BigInt(RETURN_BASE), statement.span); e.emit("RETURN", statement.span); return;
  }
  if (statement.kind === "RequireStatement") { compileExpression(statement.condition, context); revertIfFalse(context, statement.span); return; }
  if (statement.kind === "RevertStatement") {
    if (statement.errorName === undefined) { e.jump(context.revertLabel, statement.span); return; }
    const declaration = context.typed.program.contract.errors.find((item) => item.name === statement.errorName)!; const args = statement.arguments ?? [];
    e.push(BigInt(`${functionSelector(tinySolSignature(declaration.name, declaration.parameters.map((parameter) => parameter.type.name)))}${"0".repeat(56)}`), statement.span, 32); storeMemory(e, ERROR_BASE, statement.span);
    args.forEach((argument, index) => { compileExpression(argument, context); storeMemory(e, ERROR_BASE + 4 + index * 32, argument.span); });
    e.push(BigInt(4 + args.length * 32), statement.span); e.push(BigInt(ERROR_BASE), statement.span); e.emit("REVERT", statement.span); return;
  }
  if (statement.kind === "EmitStatement") {
    const event = context.events.get(statement.eventName)!; let dataPosition = 0;
    event.parameters.forEach((field, index) => { if (!field.indexed) { compileExpression(statement.arguments[index]!, context); storeMemory(e, EVENT_BASE + dataPosition++ * 32, statement.arguments[index]!.span); } });
    e.push(BigInt(dataPosition * 32), statement.span); e.push(BigInt(EVENT_BASE), statement.span); e.push(BigInt(eventTopic(tinySolSignature(event.name, event.parameters.map((field) => field.type.name)))), statement.span, 32);
    event.parameters.forEach((field, index) => { if (field.indexed) compileExpression(statement.arguments[index]!, context); }); e.emit(`LOG${1 + event.parameters.filter((field) => field.indexed).length}`, statement.span); return;
  }
  compileExpression(statement.expression, context); e.emit("POP", statement.span);
}

function validateInput(type: TinySolScalarType, context: FunctionContext, span: SourceSpan): void {
  validateWord(type, context, span);
}

function compileBody(parameters: readonly { readonly name: string; readonly type: { readonly name: TinySolScalarType }; readonly span: SourceSpan }[], body: TinySolBlock, calldataBase: number, context: FunctionContext): void {
  parameters.forEach((parameter, index) => { context.emitter.push(BigInt(calldataBase + index * 32), parameter.span); context.emitter.emit("CALLDATALOAD", parameter.span); validateInput(parameter.type.name, context, parameter.span); storeMemory(context.emitter, context.locals.get(parameter.name)!, parameter.span); });
  compileBlock(body, context);
}

function compileInternalSubroutine(fn: TinySolFunctionDeclaration, depth: number, context: FunctionContext, scheduledInternal: Set<string>, emittedInternal: Set<string>): void {
  const key = `${depth}::${fn.name}`;
  if (!scheduledInternal.has(key) || emittedInternal.has(key)) return;
  emittedInternal.add(key);
  const localBase = INTERNAL_BASE + depth * INTERNAL_STRIDE;
  const returns = fn.returns.map((item) => item.name);
  const subContext = functionContext(context.emitter, context.typed, context.abi, context.storage, fn.parameters, fn.body, returns, fn.name, depth, localBase, true, scheduledInternal, emittedInternal);
  context.emitter.namedLabel(`__internal_${depth}_${fn.name}`, fn.span);
  compileBlock(fn.body, subContext);
  if (returns.length === 0) {
    context.emitter.push(0n, fn.span);
    context.emitter.push(0n, fn.span);
    context.emitter.emit("SWAP1", fn.span);
    context.emitter.emit("JUMP", fn.span);
  }
}

function functionContext(
  emitter: Emitter,
  typed: TypedTinySol,
  abi: TinySolAbi,
  storage: TinySolStorageLayout,
  parameters: readonly { readonly name: string; readonly type: { readonly name: TinySolScalarType } }[],
  body: TinySolBlock,
  returns: readonly TinySolScalarType[] = Object.freeze([]),
  functionName = "",
  internalDepth = 0,
  localBase = 0,
  isInternal = false,
  internalRoutines: Set<string> = new Set<string>(),
  internalEmitted: Set<string> = new Set<string>()
): FunctionContext {
  return {
    emitter,
    typed,
    abi,
    storage,
    locals: localLayout(parameters, body, localBase),
    localTypes: localTypeLayout(parameters, body),
    returns,
    functionName,
    internalRoutines,
    internalEmitted,
    revertLabel: "__revert",
    events: new Map(typed.program.contract.events.map((event) => [event.name, event])),
    interfaces: new Map(typed.program.interfaces.map((item) => [item.name, item])),
    loops: [],
    callDepth: 0,
    internalDepth,
    isInternal,
  };
}

export function lowerTinySol(input: TinySolProgram | TypedTinySol): LoweredTinySol {
  const typed = "expressionTypes" in input ? input : typeCheckTinySol(resolveTinySol(input)); const program = typed.program; const abi = buildTinySolAbi(program); const storageLayout = buildStorageLayout(program); const e = new Emitter();
  const internalRoutines = new Set<string>();
  const internalEmitted = new Set<string>();
  e.emit(".constructor __constructor"); e.emit(".runtime __runtime"); e.emit(`.abi-hash ${abi.abiHash}`); e.emit(".code");
  e.namedLabel("__constructor", program.contract.constructor?.kind === "ConstructorDeclaration" ? program.contract.constructor.span : program.contract.span);
  const constructor = program.contract.constructor?.kind === "ConstructorDeclaration" ? program.contract.constructor : undefined;
  if (constructor === undefined) e.emit("STOP", program.contract.span);
  else {
    const context = functionContext(e, typed, abi, storageLayout, constructor.parameters, constructor.body, Object.freeze([]), "constructor", 0, 0, false, internalRoutines, internalEmitted);
    e.emit("CALLDATASIZE", constructor.span); e.push(BigInt(constructor.parameters.length * 32), constructor.span); e.emit("EQ", constructor.span); revertIfFalse(context, constructor.span); compileBody(constructor.parameters, constructor.body, 0, context); e.emit("STOP", constructor.span);
  }
  e.namedLabel("__runtime", program.contract.span); e.emit("CALLDATASIZE", program.contract.span); e.push(4n, program.contract.span); e.emit("LT", program.contract.span); e.jumpIf("__revert", program.contract.span); e.push(0n, program.contract.span); e.emit("CALLDATALOAD", program.contract.span); e.push(224n, program.contract.span); e.emit("SHR", program.contract.span);
  for (const fn of program.contract.functions) {
    if (fn.visibility !== "external") continue;
    const item = abi.functions.find((candidate) => candidate.name === fn.name)!; e.emit("DUP1", fn.span); e.push(BigInt(item.selector), fn.span, 4); e.emit("EQ", fn.span); e.jumpIf(`__function_${fn.name}`, fn.span);
  }
  e.jump("__revert", program.contract.span);
  for (const fn of program.contract.functions) {
    if (fn.visibility !== "external") continue;
    e.namedLabel(`__function_${fn.name}`, fn.span); e.emit("POP", fn.span); const context = functionContext(e, typed, abi, storageLayout, fn.parameters, fn.body, Object.freeze(fn.returns.map((item) => item.name)), fn.name, 0, 0, false, internalRoutines, internalEmitted);
    e.emit("CALLDATASIZE", fn.span); e.push(BigInt(4 + fn.parameters.length * 32), fn.span); e.emit("EQ", fn.span); revertIfFalse(context, fn.span); compileBody(fn.parameters, fn.body, 4, context); e.emit("STOP", fn.span);
  }
  for (const key of [...internalRoutines].sort()) {
    const separator = key.indexOf("::");
    if (separator <= 0) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...sourceLocation(program.contract.span), details: { feature: "invalid-internal-routine-key" } });
    const depth = Number(key.slice(0, separator));
    const name = key.slice(separator + 2);
    const fn = program.contract.functions.find((candidate) => candidate.name === name);
    if (fn === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...sourceLocation(program.contract.span), details: { name } });
    compileInternalSubroutine(fn, depth, functionContext(e, typed, abi, storageLayout, fn.parameters, fn.body, Object.freeze([]), fn.name, 0, 0, true, internalRoutines, internalEmitted), internalRoutines, internalEmitted);
  }
  e.namedLabel("__revert", program.contract.span); e.push(0n, program.contract.span); e.push(0n, program.contract.span); e.emit("REVERT", program.contract.span);
  return Object.freeze({ typed, abi, storageLayout, assembly: e.text(), assemblyLineSpans: e.spans });
}

export const TINYSOL_COMPILER_IDENTITY: TinySolCompilerIdentity = Object.freeze({
  languageVersion: TINYSOL_LANGUAGE_VERSION,
  compilerVersion: TINYSOL_COMPILER_VERSION,
  compilerSourceFingerprint: COMPILER_SOURCE_FINGERPRINT,
  dependencyLockHash: COMPILER_DEPENDENCY_LOCK_SHA256,
  isaHash: ISA_FILE_KECCAK,
  optimizationProfile: TINYSOL_OPTIMIZATION_PROFILE,
  status: "experimental-unaudited"
});

export function compileTinySol(source: string, options: CompileTinySolOptions = {}): CompileTinySolResult {
  const normalizedSource = source.replace(/\r\n?/g, "\n"); const tokens = lexTinySol(normalizedSource); const ast = parseTinySol(tokens, options.sourceName === undefined ? {} : { sourceName: options.sourceName }); const loweredAst = lowerCompileTimeExtensions(ast); const typed = typeCheckTinySol(resolveTinySol(loweredAst)); const lowered = lowerTinySol(typed); const assemblyResult = assemble(lowered.assembly);
  const eventDescriptor = buildEventDescriptor(lowered.typed.program, lowered.abi, assemblyResult.codeHash); const descriptorHash = eventDescriptorHash(eventDescriptor);
  const sourceMap: TinySolSourceMapEntry[] = assemblyResult.sourceMap.map((entry) => { const sourceSpan = lowered.assemblyLineSpans.get(entry.line) ?? ast.span; return Object.freeze({ ...entry, sourceSpan }); });
  const manifest: TinySolBuildManifest = Object.freeze({ format: "TinySolBuildManifest", version: 1, compiler: TINYSOL_COMPILER_IDENTITY, sourceHash: sourceHash(normalizedSource), abiHash: lowered.abi.abiHash, storageLayoutHash: lowered.storageLayout.hash, eventDescriptorHash: descriptorHash, packageHash: assemblyResult.codeHash, codeLength: assemblyResult.code.length, optimizationProfile: TINYSOL_OPTIMIZATION_PROFILE });
  return Object.freeze({ ...(options.includeSyntax === true ? { tokens, ast } : {}), abi: lowered.abi, eventDescriptor, descriptorHash, storageLayout: lowered.storageLayout, assembly: lowered.assembly, code: assemblyResult.code, codeHex: bytesToHex(assemblyResult.code), package: assemblyResult.package, packageBytes: assemblyResult.packageBytes, codeHash: assemblyResult.codeHash, sourceMap: Object.freeze(sourceMap), manifest, compilerIdentity: TINYSOL_COMPILER_IDENTITY, assemblyResult });
}

export function checkTinySol(source: string, options: CompileTinySolOptions = {}): TypedTinySol {
  return typeCheckTinySol(resolveTinySol(lowerCompileTimeExtensions(parseTinySol(lexTinySol(source.replace(/\r\n?/g, "\n")), options.sourceName === undefined ? {} : { sourceName: options.sourceName }))));
}

export function encodeCompilerArtifact(value: unknown): string { return `${canonicalJson(value)}\n`; }
