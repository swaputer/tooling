import { assemble } from "./assembler.js";
import { canonicalJson, eventTopic, functionSelector } from "./abi.js";
import { bytesToHex, type Bytes32 } from "./bytes.js";
import { ToolchainErrorCode, fail } from "./errors.js";
import { buildEventDescriptor, buildStorageLayout, buildTinySolAbi, eventDescriptorHash, sourceHash } from "./compiler-artifacts.js";
import { ISA_FILE_KECCAK } from "./isa.js";
import { lexTinySol } from "./lexer.js";
import { parseTinySol } from "./parser.js";
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
  readonly returns: readonly TinySolScalarType[];
  readonly functionName: string;
  readonly internalRoutines: Set<string>;
  readonly internalEmitted: Set<string>;
  readonly revertLabel: string;
  readonly isInternal: boolean;
  readonly internalDepth: number;
  readonly events: ReadonlyMap<string, TinySolEventDeclaration>;
  readonly interfaces: ReadonlyMap<string, TinySolProgram["interfaces"][number]>;
  callDepth: number;
}

function sourceLocation(span: SourceSpan): { readonly line: number; readonly column: number; readonly offset: number } {
  return { line: span.start.line, column: span.start.column, offset: span.start.byteOffset };
}

function collectLocals(block: TinySolBlock, output: string[]): void {
  for (const statement of block.statements) {
    if (statement.kind === "VariableDeclaration") output.push(statement.name);
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

function storeMemory(emitter: Emitter, offset: number, span?: SourceSpan): void { emitter.push(BigInt(offset), span); emitter.emit("MSTORE", span); }
function loadMemory(emitter: Emitter, offset: number, span?: SourceSpan): void { emitter.push(BigInt(offset), span); emitter.emit("MLOAD", span); }
function revertIfFalse(context: FunctionContext, span: SourceSpan): void { context.emitter.emit("ISZERO", span); context.emitter.jumpIf(context.revertLabel, span); }
function stateItem(context: FunctionContext, name: string) { const item = context.storage.items.find((candidate) => candidate.name === name); if (item === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { details: { name } }); return item; }

function mappingSlot(expression: Extract<TinySolExpression, { readonly kind: "IndexExpression" }>, context: FunctionContext): void {
  const item = stateItem(context, expression.object.name); if (item.namespace === undefined) fail(ToolchainErrorCode.INVALID_OPERATION);
  context.emitter.push(BigInt(item.namespace), expression.span, 32); storeMemory(context.emitter, MAP_SCRATCH, expression.span);
  compileExpression(expression.index, context); storeMemory(context.emitter, MAP_SCRATCH + 32, expression.index.span);
  context.emitter.push(64n, expression.span); context.emitter.push(BigInt(MAP_SCRATCH), expression.span); context.emitter.emit("KECCAK256", expression.span);
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
  const type = context.typed.expressionTypes.get(expression); return type === "int256";
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
  if (expression.kind === "UnaryExpression") {
    if (expression.operator === "-" && expression.operand.kind === "LiteralExpression") { e.push(-BigInt(expression.operand.value), expression.span, 32); return; }
    compileExpression(expression.operand, context); e.emit(expression.operator === "!" ? "ISZERO" : expression.operator === "~" ? "NOT" : "PUSH0", expression.span);
    if (expression.operator === "-") e.emit("SWAP1", expression.span), e.emit("SUB", expression.span);
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
    const mnemonic = op[expression.operator]; if (mnemonic === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { details: { operation: expression.operator } }); e.emit(mnemonic, expression.span); return;
  }
  if (expression.kind === "ExternalCallExpression") {
    const declaration = context.interfaces.get(expression.interfaceName)!; const fn = declaration.functions.find((candidate) => candidate.name === expression.functionName)!;
    const depth = context.callDepth++; const base = CALL_BASE + depth * CALL_STRIDE; const output = base + CALL_OUTPUT_DELTA;
    e.push(BigInt(functionSelector(tinySolSignature(fn.name, fn.parameters.map((item) => item.name))) + "0".repeat(56)), expression.span, 32); storeMemory(e, base, expression.span);
    expression.arguments.forEach((argument, index) => { compileExpression(argument, context); storeMemory(e, base + 4 + index * 32, argument.span); });
    compileExpression(expression.target, context); e.push(BigInt(4 + expression.arguments.length * 32), expression.span); e.push(BigInt(base), expression.span); e.push(32n, expression.span); e.push(BigInt(output), expression.span); e.emit(expression.callKind === "call" ? "CALL" : "STATICCALL", expression.span); e.emit("POP", expression.span);
    e.emit("RETURNDATASIZE", expression.span); e.push(32n, expression.span); e.emit("EQ", expression.span); revertIfFalse(context, expression.span); loadMemory(e, output, expression.span); context.callDepth -= 1; return;
  }
  if (expression.kind === "FunctionCallExpression") {
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
    if (context.isInternal) compileInternalSubroutine(declaration, calleeDepth, context, context.internalRoutines, context.internalEmitted);
    return;
  }
  const declaration = context.interfaces.get(expression.interfaceName)!; const parameters = declaration.constructor?.kind === "InterfaceConstructor" ? declaration.constructor.parameters : [];
  const depth = context.callDepth++; const base = CALL_BASE + depth * CALL_STRIDE;
  expression.arguments.forEach((argument, index) => { compileExpression(argument, context); storeMemory(e, base + index * 32, argument.span); });
  compileExpression(expression.codeHash, context); e.push(BigInt(parameters.length * 32), expression.span); e.push(BigInt(base), expression.span); e.emit("CREATE", expression.span); context.callDepth -= 1;
}

function compileAssignment(statement: Extract<TinySolStatement, { readonly kind: "Assignment" }>, context: FunctionContext): void {
  compileExpression(statement.value, context);
  if (statement.target.kind === "IdentifierExpression") {
    const local = context.locals.get(statement.target.name);
    if (local !== undefined) storeMemory(context.emitter, local, statement.span);
    else { const item = stateItem(context, statement.target.name); context.emitter.push(BigInt(item.slot!), statement.span); context.emitter.emit("SSTORE", statement.span); }
  } else { mappingSlot(statement.target, context); context.emitter.emit("SSTORE", statement.span); }
}

function compileBlock(block: TinySolBlock, context: FunctionContext): void { for (const statement of block.statements) compileStatement(statement, context); }

function compileStatement(statement: TinySolStatement, context: FunctionContext): void {
  const e = context.emitter;
  if (statement.kind === "Block") { compileBlock(statement, context); return; }
  if (statement.kind === "VariableDeclaration") { if (statement.initializer !== undefined) compileExpression(statement.initializer, context); else e.push(0n, statement.span); storeMemory(e, context.locals.get(statement.name)!, statement.span); return; }
  if (statement.kind === "Assignment") { compileAssignment(statement, context); return; }
  if (statement.kind === "IfStatement") {
    const alternate = e.fresh("if_else"); const end = e.fresh("if_end");
    compileExpression(statement.condition, context); e.emit("ISZERO", statement.condition.span); e.jumpIf(statement.alternate === undefined ? end : alternate, statement.span); compileBlock(statement.consequent, context); e.jump(end, statement.span);
    if (statement.alternate !== undefined) { e.namedLabel(alternate, statement.alternate.span); compileBlock(statement.alternate, context); }
    e.namedLabel(end, statement.span); return;
  }
  if (statement.kind === "WhileStatement") {
    const head = e.fresh("while_head"); const end = e.fresh("while_end"); e.namedLabel(head, statement.span); compileExpression(statement.condition, context); e.emit("ISZERO", statement.condition.span); e.jumpIf(end, statement.span); compileBlock(statement.body, context); e.jump(head, statement.span); e.namedLabel(end, statement.span); return;
  }
  if (statement.kind === "ForStatement") {
    if (statement.initializer !== undefined) compileStatement(statement.initializer, context); const head = e.fresh("for_head"); const end = e.fresh("for_end"); e.namedLabel(head, statement.span);
    if (statement.condition !== undefined) { compileExpression(statement.condition, context); e.emit("ISZERO", statement.condition.span); e.jumpIf(end, statement.span); }
    compileBlock(statement.body, context); if (statement.update !== undefined) compileStatement(statement.update, context); e.jump(head, statement.span); e.namedLabel(end, statement.span); return;
  }
  if (statement.kind === "ReturnStatement") {
    if (context.isInternal) {
      if (statement.values.length !== 1 || context.returns.length !== 1) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { details: { feature: "internal-return-arity" }, line: statement.span.start.line, column: statement.span.start.column });
      compileExpression(statement.values[0]!, context);
      const returnSlot = INTERNAL_BASE + context.internalDepth * INTERNAL_STRIDE + INTERNAL_RETURN_SLOT_OFFSET;
      loadMemory(e, returnSlot, statement.span);
      e.emit("JUMP", statement.span);
      return;
    }
    statement.values.forEach((value, index) => { compileExpression(value, context); storeMemory(e, RETURN_BASE + index * 32, value.span); }); e.push(BigInt(statement.values.length * 32), statement.span); e.push(BigInt(RETURN_BASE), statement.span); e.emit("RETURN", statement.span); return;
  }
  if (statement.kind === "RequireStatement") { compileExpression(statement.condition, context); revertIfFalse(context, statement.span); return; }
  if (statement.kind === "RevertStatement") { e.jump(context.revertLabel, statement.span); return; }
  if (statement.kind === "EmitStatement") {
    const event = context.events.get(statement.eventName)!; let dataPosition = 0;
    event.parameters.forEach((field, index) => { if (!field.indexed) { compileExpression(statement.arguments[index]!, context); storeMemory(e, EVENT_BASE + dataPosition++ * 32, statement.arguments[index]!.span); } });
    e.push(BigInt(dataPosition * 32), statement.span); e.push(BigInt(EVENT_BASE), statement.span); e.push(BigInt(eventTopic(tinySolSignature(event.name, event.parameters.map((field) => field.type.name)))), statement.span, 32);
    event.parameters.forEach((field, index) => { if (field.indexed) compileExpression(statement.arguments[index]!, context); }); e.emit(`LOG${1 + event.parameters.filter((field) => field.indexed).length}`, statement.span); return;
  }
  compileExpression(statement.expression, context); e.emit("POP", statement.span);
}

function validateInput(type: TinySolScalarType, context: FunctionContext, span: SourceSpan): void {
  if (type === "bool") { context.emitter.emit("DUP1", span); context.emitter.push(1n, span); context.emitter.emit("GT", span); context.emitter.jumpIf(context.revertLabel, span); }
  if (type === "address") { context.emitter.emit("DUP1", span); context.emitter.push((1n << 160n) - 1n, span, 20); context.emitter.emit("GT", span); context.emitter.jumpIf(context.revertLabel, span); }
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
  parameters: readonly { readonly name: string }[],
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
    returns,
    functionName,
    internalRoutines,
    internalEmitted,
    revertLabel: "__revert",
    events: new Map(typed.program.contract.events.map((event) => [event.name, event])),
    interfaces: new Map(typed.program.interfaces.map((item) => [item.name, item])),
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
    e.namedLabel(`__function_${fn.name}`, fn.span); e.emit("POP", fn.span); const context = functionContext(e, typed, abi, storageLayout, fn.parameters, fn.body, Object.freeze([]), fn.name, 0, 0, false, internalRoutines, internalEmitted);
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
  const normalizedSource = source.replace(/\r\n?/g, "\n"); const tokens = lexTinySol(normalizedSource); const ast = parseTinySol(tokens, options.sourceName === undefined ? {} : { sourceName: options.sourceName }); const typed = typeCheckTinySol(resolveTinySol(ast)); const lowered = lowerTinySol(typed); const assemblyResult = assemble(lowered.assembly);
  const eventDescriptor = buildEventDescriptor(ast, lowered.abi, assemblyResult.codeHash); const descriptorHash = eventDescriptorHash(eventDescriptor);
  const sourceMap: TinySolSourceMapEntry[] = assemblyResult.sourceMap.map((entry) => { const sourceSpan = lowered.assemblyLineSpans.get(entry.line) ?? ast.span; return Object.freeze({ ...entry, sourceSpan }); });
  const manifest: TinySolBuildManifest = Object.freeze({ format: "TinySolBuildManifest", version: 1, compiler: TINYSOL_COMPILER_IDENTITY, sourceHash: sourceHash(normalizedSource), abiHash: lowered.abi.abiHash, storageLayoutHash: lowered.storageLayout.hash, eventDescriptorHash: descriptorHash, packageHash: assemblyResult.codeHash, codeLength: assemblyResult.code.length, optimizationProfile: TINYSOL_OPTIMIZATION_PROFILE });
  return Object.freeze({ ...(options.includeSyntax === true ? { tokens, ast } : {}), abi: lowered.abi, eventDescriptor, descriptorHash, storageLayout: lowered.storageLayout, assembly: lowered.assembly, code: assemblyResult.code, codeHex: bytesToHex(assemblyResult.code), package: assemblyResult.package, packageBytes: assemblyResult.packageBytes, codeHash: assemblyResult.codeHash, sourceMap: Object.freeze(sourceMap), manifest, compilerIdentity: TINYSOL_COMPILER_IDENTITY, assemblyResult });
}

export function checkTinySol(source: string, options: CompileTinySolOptions = {}): TypedTinySol {
  return typeCheckTinySol(resolveTinySol(parseTinySol(lexTinySol(source.replace(/\r\n?/g, "\n")), options.sourceName === undefined ? {} : { sourceName: options.sourceName })));
}

export function encodeCompilerArtifact(value: unknown): string { return `${canonicalJson(value)}\n`; }
