import { eventTopic, functionSelector } from "./abi.js";
import { ToolchainErrorCode, fail } from "./errors.js";
import type {
  ResolvedTinySol,
  TinySolBlock,
  TinySolExpression,
  TinySolFunctionDeclaration,
  TinySolInterfaceDeclaration,
  TinySolProgram,
  TinySolScalarType,
  TinySolStatement,
  TypedTinySol
} from "./compiler-types.js";

const CONTEXT_TYPES: Readonly<Record<string, TinySolScalarType>> = Object.freeze({
  "msg.sender": "account", "this.id": "account", "tx.actor": "account", "world.id": "bytes32", "world.executionHeight": "uint256",
  "tx.router": "address", "tx.executor": "address", "tx.recipient": "address",
  "buy.ethIn": "uint256", "buy.grossTokenOut": "uint256", "buy.tickAfter": "int256", "block.number": "uint256",
  "block.timestamp": "uint256", "gas.bytePrice": "uint256", "gas.bytesUsed": "uint256", "gas.bytesRemaining": "uint256"
});

function abiType(type: TinySolScalarType): string { return type === "account" ? "bytes32" : type; }
function signature(name: string, types: readonly TinySolScalarType[]): string { return `${name}(${types.map(abiType).join(",")})`; }
function location(node: { readonly span: { readonly start: { readonly line: number; readonly column: number; readonly byteOffset: number } } }): { line: number; column: number; offset: number } {
  return { line: node.span.start.line, column: node.span.start.column, offset: node.span.start.byteOffset };
}

function unique(names: readonly { readonly name: string; readonly span: { readonly start: { readonly line: number; readonly column: number; readonly byteOffset: number } } }[], scope: string): void {
  const seen = new Set<string>();
  for (const item of names) {
    if (seen.has(item.name)) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...location(item), details: { name: item.name, scope } });
    seen.add(item.name);
  }
}

export function resolveTinySol(program: TinySolProgram): ResolvedTinySol {
  unique(program.interfaces, "program");
  const contract = program.contract;
  unique([...contract.stateVariables, ...contract.events, ...contract.functions], "contract");
  for (const item of program.interfaces) unique(item.functions, `interface:${item.name}`);
  for (const fn of contract.functions) unique(fn.parameters, `function:${fn.name}`);
  if (contract.constructor?.kind === "ConstructorDeclaration") unique(contract.constructor.parameters, "constructor");
  for (const event of contract.events) {
    unique(event.parameters, `event:${event.name}`);
    if (event.parameters.filter((field) => field.indexed).length > 3) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...location(event), details: { resource: "indexed-event-fields", maximum: 3 } });
  }

  const selectors = new Map<string, string>();
  for (const fn of contract.functions) {
    const canonical = signature(fn.name, fn.parameters.map((parameter) => parameter.type.name));
    const selector = functionSelector(canonical);
    const prior = selectors.get(selector);
    if (prior !== undefined) fail(ToolchainErrorCode.SELECTOR_COLLISION, { ...location(fn), details: { first: prior, second: canonical, selector } });
    selectors.set(selector, canonical);
  }
  const topics = new Map<string, string>();
  for (const event of contract.events) {
    const canonical = signature(event.name, event.parameters.map((parameter) => parameter.type.name));
    const topic = eventTopic(canonical); const prior = topics.get(topic);
    if (prior !== undefined) fail(ToolchainErrorCode.EVENT_TOPIC_COLLISION, { ...location(event), details: { first: prior, second: canonical } });
    topics.set(topic, canonical);
  }
  return Object.freeze({ program, diagnostics: Object.freeze([]) });
}

  interface Environment {
  readonly locals: Map<string, TinySolScalarType>;
  readonly declaredLocals: Set<string>;
  readonly states: ReadonlyMap<string, TinySolScalarType | { readonly key: TinySolScalarType; readonly value: TinySolScalarType }>;
  readonly events: ReadonlyMap<string, { readonly types: readonly TinySolScalarType[] }>;
  readonly interfaces: ReadonlyMap<string, TinySolInterfaceDeclaration>;
  readonly functions: ReadonlyMap<string, TinySolFunctionDeclaration>;
  readonly internalCalls: Map<string, Set<string>>;
  readonly expressionTypes: Map<TinySolExpression, TinySolScalarType>;
  readonly returns: readonly TinySolScalarType[];
  readonly view: boolean;
  readonly functionName: string;
}

function compatible(actual: TinySolScalarType, expected: TinySolScalarType, expression: TinySolExpression): boolean {
  if (actual === expected) return true;
  if (expression.kind === "LiteralExpression" && expression.literalKind === "integer" && expected === "int256") {
    const value = BigInt(expression.value);
    return value <= (1n << 255n) - 1n;
  }
  return false;
}

function requireType(actual: TinySolScalarType, expected: TinySolScalarType, expression: TinySolExpression): void {
  if (!compatible(actual, expected, expression)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual, expected } });
}

function interfaceFunction(environment: Environment, interfaceName: string, functionName: string, node: TinySolExpression) {
  const declaration = environment.interfaces.get(interfaceName);
  if (declaration === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(node), details: { name: interfaceName } });
  const fn = declaration.functions.find((candidate) => candidate.name === functionName);
  if (fn === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(node), details: { name: `${interfaceName}.${functionName}` } });
  return fn;
}

function expressionType(expression: TinySolExpression, environment: Environment): TinySolScalarType {
  let result: TinySolScalarType;
  if (expression.kind === "LiteralExpression") {
    if (expression.literalKind === "bool") result = "bool";
    else if (expression.literalKind === "bytes32") result = "bytes32";
    else if (expression.literalKind === "address") result = "address";
    else {
      const value = BigInt(expression.value);
      if (value < 0n || value >= 1n << 256n) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { ...location(expression), details: { width: 32 } });
      result = "uint256";
    }
  } else if (expression.kind === "IdentifierExpression") {
    const local = environment.locals.get(expression.name); const state = environment.states.get(expression.name);
    if (local !== undefined) result = local;
    else if (typeof state === "string") result = state;
    else if (state !== undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: "mapping-value" } });
    else fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(expression), details: { name: expression.name } });
  } else if (expression.kind === "ContextExpression") {
    const type = CONTEXT_TYPES[expression.path]; if (type === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(expression), details: { name: expression.path } }); result = type;
  } else if (expression.kind === "IndexExpression") {
    const state = environment.states.get(expression.object.name);
    if (state === undefined || typeof state === "string") fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: "index-non-mapping" } });
    const key = expressionType(expression.index, environment); requireType(key, state.key, expression.index); result = state.value;
  } else if (expression.kind === "UnaryExpression") {
    const operand = expressionType(expression.operand, environment);
    if (expression.operator === "!") { requireType(operand, "bool", expression.operand); result = "bool"; }
    else if (expression.operator === "~") { if (operand !== "uint256" && operand !== "int256") fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: "~" } }); result = operand; }
    else {
      if (expression.operand.kind !== "LiteralExpression" || expression.operand.literalKind !== "integer") requireType(operand, "int256", expression.operand);
      const magnitude = expression.operand.kind === "LiteralExpression" ? BigInt(expression.operand.value) : 0n;
      if (magnitude > 1n << 255n) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { ...location(expression), details: { width: 32 } }); result = "int256";
    }
  } else if (expression.kind === "BinaryExpression") {
    const left = expressionType(expression.left, environment); const right = expressionType(expression.right, environment);
    const rightMatches = compatible(right, left, expression.right); const leftMatches = compatible(left, right, expression.left);
    const numericType = rightMatches ? left : leftMatches ? right : undefined;
    if (["&&", "||"].includes(expression.operator)) { requireType(left, "bool", expression.left); requireType(right, "bool", expression.right); result = "bool"; }
    else if (["==", "!="].includes(expression.operator)) { if (numericType === undefined) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: right, expected: left } }); result = "bool"; }
    else if (["<", ">", "<=", ">="].includes(expression.operator)) { if (numericType !== "uint256" && numericType !== "int256") fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: expression.operator } }); result = "bool"; }
    else {
      if (numericType !== "uint256" && numericType !== "int256") fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: expression.operator } });
      if (["&", "|", "^", "<<", ">>"].includes(expression.operator) && numericType !== "uint256" && numericType !== "int256") fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression) });
      result = numericType;
    }
  } else if (expression.kind === "ExternalCallExpression") {
    const fn = interfaceFunction(environment, expression.interfaceName, expression.functionName, expression);
    const target = expressionType(expression.target, environment); requireType(target, "account", expression.target);
    if (expression.arguments.length !== fn.parameters.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: expression.arguments.length, expected: fn.parameters.length } });
    expression.arguments.forEach((argument, index) => requireType(expressionType(argument, environment), fn.parameters[index]!.name, argument));
    if (expression.callKind === "staticcall" && !fn.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(expression), details: { operation: "staticcall-non-view" } });
    if (environment.view && expression.callKind !== "staticcall") fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(expression), details: { operation: "call" } });
    if (fn.returns.length !== 1) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "call-return-arity" } });
    result = fn.returns[0]!.name;
  } else if (expression.kind === "FunctionCallExpression") {
    const declaration = environment.functions.get(expression.functionName);
    if (declaration === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(expression), details: { name: expression.functionName } });
    if (declaration.visibility !== "internal") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "internal-call-to-non-internal" } });
    if (expression.arguments.length !== declaration.parameters.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: expression.arguments.length, expected: declaration.parameters.length } });
    expression.arguments.forEach((argument, index) => requireType(expressionType(argument, environment), declaration.parameters[index]!.type.name, argument));
    let calls = environment.internalCalls.get(environment.functionName);
    if (calls === undefined) { calls = new Set(); environment.internalCalls.set(environment.functionName, calls); }
    calls.add(declaration.name);
    if (declaration.returns.length !== 1) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "internal-call-return-arity" } });
    if (environment.view && !declaration.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(expression), details: { operation: "internal-call" } });
    result = declaration.returns[0]!.name;
  } else {
    const declaration = environment.interfaces.get(expression.interfaceName);
    if (declaration === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(expression), details: { name: expression.interfaceName } });
    const parameters = declaration.constructor?.kind === "InterfaceConstructor" ? declaration.constructor.parameters : [];
    if (expression.arguments.length !== parameters.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: expression.arguments.length, expected: parameters.length } });
    requireType(expressionType(expression.codeHash, environment), "bytes32", expression.codeHash);
    expression.arguments.forEach((argument, index) => requireType(expressionType(argument, environment), parameters[index]!.name, argument));
    if (environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(expression), details: { operation: "create" } });
    result = "account";
  }
  environment.expressionTypes.set(expression, result); return result;
}

function definitelyReturns(statement: TinySolStatement): boolean {
  if (statement.kind === "ReturnStatement" || statement.kind === "RevertStatement") return true;
  if (statement.kind === "Block") return statement.statements.some(definitelyReturns);
  if (statement.kind === "IfStatement") return statement.alternate !== undefined && definitelyReturns(statement.consequent) && definitelyReturns(statement.alternate);
  return false;
}

function checkBlock(block: TinySolBlock, environment: Environment, scoped = true): void {
  const active = scoped ? { ...environment, locals: new Map(environment.locals) } : environment;
  for (const statement of block.statements) checkStatement(statement, active);
}

function checkStatement(statement: TinySolStatement, environment: Environment): void {
  if (statement.kind === "Block") { checkBlock(statement, environment); return; }
  if (statement.kind === "VariableDeclaration") {
    if (environment.declaredLocals.has(statement.name) || environment.states.has(statement.name)) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...location(statement), details: { name: statement.name, scope: environment.functionName } });
    if (statement.initializer !== undefined) requireType(expressionType(statement.initializer, environment), statement.type.name, statement.initializer);
    environment.declaredLocals.add(statement.name); environment.locals.set(statement.name, statement.type.name); return;
  }
  if (statement.kind === "Assignment") {
    const value = expressionType(statement.value, environment);
    if (statement.target.kind === "IdentifierExpression") {
      const target = environment.locals.get(statement.target.name) ?? environment.states.get(statement.target.name);
      if (target === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(statement.target), details: { name: statement.target.name } });
      if (typeof target !== "string") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(statement.target) });
      requireType(value, target, statement.value);
      if (environment.view && !environment.locals.has(statement.target.name)) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "storage-write" } });
    } else {
      const mapping = environment.states.get(statement.target.object.name);
      if (mapping === undefined || typeof mapping === "string") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(statement.target) });
      requireType(expressionType(statement.target.index, environment), mapping.key, statement.target.index); requireType(value, mapping.value, statement.value);
      if (environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "mapping-write" } });
    }
    return;
  }
  if (statement.kind === "IfStatement") { requireType(expressionType(statement.condition, environment), "bool", statement.condition); checkBlock(statement.consequent, environment); if (statement.alternate !== undefined) checkBlock(statement.alternate, environment); return; }
  if (statement.kind === "WhileStatement") { requireType(expressionType(statement.condition, environment), "bool", statement.condition); checkBlock(statement.body, environment); return; }
  if (statement.kind === "ForStatement") {
    const loopEnvironment = { ...environment, locals: new Map(environment.locals) };
    if (statement.initializer !== undefined) checkStatement(statement.initializer, loopEnvironment);
    if (statement.condition !== undefined) requireType(expressionType(statement.condition, loopEnvironment), "bool", statement.condition);
    if (statement.update !== undefined) checkStatement(statement.update, loopEnvironment); checkBlock(statement.body, loopEnvironment); return;
  }
  if (statement.kind === "ReturnStatement") {
    if (statement.values.length !== environment.returns.length) fail(ToolchainErrorCode.RETURN_MISMATCH, { ...location(statement), details: { actual: statement.values.length, expected: environment.returns.length } });
    statement.values.forEach((value, index) => requireType(expressionType(value, environment), environment.returns[index]!, value)); return;
  }
  if (statement.kind === "RequireStatement") { requireType(expressionType(statement.condition, environment), "bool", statement.condition); return; }
  if (statement.kind === "EmitStatement") {
    const event = environment.events.get(statement.eventName); if (event === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(statement), details: { name: statement.eventName } });
    if (environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "emit" } });
    if (statement.arguments.length !== event.types.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(statement), details: { actual: statement.arguments.length, expected: event.types.length } });
    statement.arguments.forEach((argument, index) => requireType(expressionType(argument, environment), event.types[index]!, argument)); return;
  }
  if (statement.kind === "ExpressionStatement") { expressionType(statement.expression, environment); return; }
}

function checkFunction(fn: TinySolFunctionDeclaration | { readonly name: string; readonly parameters: readonly { readonly name: string; readonly type: { readonly name: TinySolScalarType }; readonly span: TinySolBlock["span"] }[]; readonly returns: readonly { readonly name: TinySolScalarType }[]; readonly body: TinySolBlock; readonly view: boolean; readonly span: TinySolBlock["span"] }, base: Omit<Environment, "locals" | "declaredLocals" | "returns" | "view" | "functionName">): void {
  const locals = new Map<string, TinySolScalarType>();
  for (const parameter of fn.parameters) {
    if (base.states.has(parameter.name)) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...location(parameter), details: { name: parameter.name, scope: fn.name } });
    locals.set(parameter.name, parameter.type.name);
  }
  const environment: Environment = { ...base, locals, declaredLocals: new Set(locals.keys()), returns: fn.returns.map((item) => item.name), view: fn.view, functionName: fn.name };
  checkBlock(fn.body, environment, false);
  if (fn.returns.length > 0 && !definitelyReturns(fn.body)) fail(ToolchainErrorCode.MISSING_RETURN, { ...location(fn), details: { function: fn.name } });
}

function checkInternalCallCycles(functions: readonly TinySolFunctionDeclaration[], internalCalls: ReadonlyMap<string, Set<string>>): void {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(name: string): void {
    const fn = byName.get(name);
    if (fn === undefined) return;
    if (visited.has(name)) return;
    if (visiting.has(name)) fail(ToolchainErrorCode.FUNCTION_CALL_CYCLE, { ...location(fn), details: { cycle: `${path.join(" -> ")} -> ${name}` } });
    visiting.add(name); path.push(name);
    const edges = internalCalls.get(name);
    if (edges !== undefined) for (const edge of edges) visit(edge);
    path.pop(); visiting.delete(name); visited.add(name);
  }
  for (const fn of functions) visit(fn.name);
}

export function typeCheckTinySol(input: TinySolProgram | ResolvedTinySol): TypedTinySol {
  const resolved = "program" in input ? input : resolveTinySol(input);
  const program = resolved.program; const expressionTypes = new Map<TinySolExpression, TinySolScalarType>();
  const states = new Map<string, TinySolScalarType | { readonly key: TinySolScalarType; readonly value: TinySolScalarType }>();
  for (const state of program.contract.stateVariables) states.set(state.name, state.type.kind === "ScalarType" ? state.type.name : Object.freeze({ key: state.type.keyType.name, value: state.type.valueType.name }));
  const events = new Map(program.contract.events.map((event) => [event.name, Object.freeze({ types: Object.freeze(event.parameters.map((parameter) => parameter.type.name)) })]));
  const interfaces = new Map(program.interfaces.map((item) => [item.name, item]));
  const functions = new Map(program.contract.functions.map((fn) => [fn.name, fn]));
  const internalCalls = new Map<string, Set<string>>();
  const base = { states, events, interfaces, functions, internalCalls, expressionTypes };
  if (program.contract.constructor?.kind === "ConstructorDeclaration") checkFunction({ ...program.contract.constructor, name: "constructor", returns: Object.freeze([]), view: false }, base);
  for (const fn of program.contract.functions) checkFunction(fn, base);
  checkInternalCallCycles(program.contract.functions, internalCalls);
  return Object.freeze({ ...resolved, expressionTypes, staticFunctions: new Set(program.contract.functions.filter((fn) => fn.view).map((fn) => fn.name)) });
}

export function tinySolAbiType(type: TinySolScalarType): string { return abiType(type); }
export function tinySolSignature(name: string, types: readonly TinySolScalarType[]): string { return signature(name, types); }
