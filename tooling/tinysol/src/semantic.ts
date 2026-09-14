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
import { tinySolIntegerBounds, tinySolIntegerInfo, type TinySolIntegerType } from "./compiler-types.js";

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
  unique([...contract.stateVariables, ...contract.events, ...contract.errors, ...contract.functions], "contract");
  for (const item of program.interfaces) unique(item.functions, `interface:${item.name}`);
  for (const fn of contract.functions) unique(fn.parameters, `function:${fn.name}`);
  if (contract.constructor?.kind === "ConstructorDeclaration") unique(contract.constructor.parameters, "constructor");
  for (const event of contract.events) {
    unique(event.parameters, `event:${event.name}`);
    if (event.parameters.filter((field) => field.indexed).length > 3) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...location(event), details: { resource: "indexed-event-fields", maximum: 3 } });
  }
  for (const error of contract.errors) unique(error.parameters, `error:${error.name}`);

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
  readonly states: ReadonlyMap<string, TinySolScalarType | { readonly key: TinySolScalarType; readonly value: TinySolScalarType } | { readonly element: TinySolScalarType; readonly length: number }>;
  readonly events: ReadonlyMap<string, { readonly types: readonly TinySolScalarType[] }>;
  readonly errors: ReadonlyMap<string, { readonly types: readonly TinySolScalarType[] }>;
  readonly interfaces: ReadonlyMap<string, TinySolInterfaceDeclaration>;
  readonly functions: ReadonlyMap<string, TinySolFunctionDeclaration>;
  readonly internalCalls: Map<string, Set<string>>;
  readonly expressionTypes: Map<TinySolExpression, TinySolScalarType>;
  readonly returns: readonly TinySolScalarType[];
  readonly view: boolean;
  readonly functionName: string;
}

function integerLiteralValue(expression: TinySolExpression): bigint | undefined {
  if (expression.kind === "LiteralExpression" && expression.literalKind === "integer") return BigInt(expression.value);
  if (expression.kind === "UnaryExpression" && expression.operator === "-" && expression.operand.kind === "LiteralExpression" && expression.operand.literalKind === "integer") return -BigInt(expression.operand.value);
  return undefined;
}

function integerWidening(actual: TinySolScalarType, expected: TinySolScalarType): boolean {
  const from = tinySolIntegerInfo(actual); const to = tinySolIntegerInfo(expected);
  return from !== undefined && to !== undefined && from.signed === to.signed && from.width <= to.width;
}

function compatible(actual: TinySolScalarType, expected: TinySolScalarType, expression: TinySolExpression): boolean {
  if (actual === expected) return true;
  const value = integerLiteralValue(expression); const expectedInfo = tinySolIntegerInfo(expected);
  if (value !== undefined && expectedInfo !== undefined) {
    const bounds = tinySolIntegerBounds(expected as TinySolIntegerType);
    return value >= bounds.minimum && value <= bounds.maximum;
  }
  return integerWidening(actual, expected);
}

function commonIntegerType(left: TinySolScalarType, right: TinySolScalarType, leftExpression: TinySolExpression, rightExpression: TinySolExpression): TinySolScalarType | undefined {
  const leftInfo = tinySolIntegerInfo(left); const rightInfo = tinySolIntegerInfo(right);
  if (leftInfo === undefined || rightInfo === undefined) return undefined;
  if (compatible(right, left, rightExpression)) return left;
  if (compatible(left, right, leftExpression)) return right;
  if (leftInfo.signed !== rightInfo.signed) return undefined;
  return leftInfo.width >= rightInfo.width ? left : right;
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

function dimensionProduct(dimensions: readonly number[]): number { return dimensions.reduce((product, dimension) => product * dimension, 1); }

function checkArrayIndices(indices: readonly TinySolExpression[], dimensions: readonly number[], environment: Environment, node: TinySolExpression): void {
  if (indices.length !== dimensions.length || indices.length === 0) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(node), details: { operation: "nested-array-index" } });
  indices.forEach((index, position) => {
    requireType(expressionType(index, environment), "uint256", index); const length = dimensions[position]!;
    if (index.kind === "LiteralExpression" && BigInt(index.value) >= BigInt(length)) fail(ToolchainErrorCode.ARRAY_BOUNDS, { ...location(index), details: { index: index.value, length } });
  });
}

function expressionType(expression: TinySolExpression, environment: Environment): TinySolScalarType {
  let result: TinySolScalarType;
  if (expression.kind === "LiteralExpression") {
    if (expression.literalKind === "bool") result = "bool";
    else if (expression.literalKind === "bytes32") result = "bytes32";
    else if (expression.literalKind === "address") result = "address";
    else if (expression.literalKind === "account") result = "account";
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
    if (expression.object.kind !== "IdentifierExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "unlowered-aggregate-index" } });
    const state = environment.states.get(expression.object.name);
    if (state === undefined || typeof state === "string") fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: "index-non-mapping" } });
    const indexType = expressionType(expression.index, environment);
    if ("element" in state) {
      requireType(indexType, "uint256", expression.index);
      if (expression.index.kind === "LiteralExpression" && BigInt(expression.index.value) >= BigInt(state.length)) fail(ToolchainErrorCode.ARRAY_BOUNDS, { ...location(expression.index), details: { index: expression.index.value, length: state.length } });
      result = state.element;
    } else { requireType(indexType, state.key, expression.index); result = state.value; }
  } else if (expression.kind === "LocalArrayIndexExpression") {
    const base = environment.locals.get(expression.baseName);
    if (base === undefined || base !== expression.elementType) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(expression), details: { name: expression.baseName } });
    requireType(expressionType(expression.index, environment), "uint256", expression.index);
    if (expression.index.kind === "LiteralExpression" && BigInt(expression.index.value) >= BigInt(expression.length)) fail(ToolchainErrorCode.ARRAY_BOUNDS, { ...location(expression.index), details: { index: expression.index.value, length: expression.length } });
    result = expression.elementType;
  } else if (expression.kind === "NestedArrayIndexExpression") {
    const state = environment.states.get(expression.object.name);
    if (state === undefined || typeof state === "string" || !("element" in state) || state.element !== expression.elementType || state.length !== dimensionProduct(expression.dimensions)) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: "nested-array-index" } });
    checkArrayIndices(expression.indices, expression.dimensions, environment, expression);
    result = expression.elementType;
  } else if (expression.kind === "LocalNestedArrayIndexExpression") {
    const base = environment.locals.get(expression.baseName);
    if (base === undefined || base !== expression.elementType) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(expression), details: { name: expression.baseName } });
    checkArrayIndices(expression.indices, expression.dimensions, environment, expression);
    result = expression.elementType;
  } else if (expression.kind === "NestedStorageIndexExpression") {
    const state = environment.states.get(expression.object.name);
    if (state === undefined || typeof state === "string" || "element" in state || state.value !== expression.elementType) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: "nested-storage-index" } });
    requireType(expressionType(expression.key, environment), state.key, expression.key);
    checkArrayIndices(expression.indices, expression.dimensions, environment, expression);
    result = expression.elementType;
  } else if (expression.kind === "MemberExpression") {
    fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "unlowered-member-expression" } });
  } else if (expression.kind === "StructLiteralExpression") {
    fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "unlowered-struct-literal" } });
  } else if (expression.kind === "ArrayLiteralExpression") {
    fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "unlowered-array-literal" } });
  } else if (expression.kind === "UnaryExpression") {
    const operand = expressionType(expression.operand, environment);
    if (expression.operator === "!") { requireType(operand, "bool", expression.operand); result = "bool"; }
    else if (expression.operator === "~") { if (tinySolIntegerInfo(operand) === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: "~" } }); result = operand; }
    else {
      const info = tinySolIntegerInfo(operand);
      if (expression.operand.kind !== "LiteralExpression" || expression.operand.literalKind !== "integer") {
        if (info === undefined || !info.signed) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: "-", type: operand } });
      }
      const magnitude = expression.operand.kind === "LiteralExpression" ? BigInt(expression.operand.value) : 0n;
      if (magnitude > 1n << 255n) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { ...location(expression), details: { width: 32 } }); result = info?.signed ? operand : "int256";
    }
  } else if (expression.kind === "BinaryExpression") {
    const left = expressionType(expression.left, environment); const right = expressionType(expression.right, environment);
    const numericType = commonIntegerType(left, right, expression.left, expression.right);
    if (["&&", "||"].includes(expression.operator)) { requireType(left, "bool", expression.left); requireType(right, "bool", expression.right); result = "bool"; }
    else if (["==", "!="].includes(expression.operator)) { if (left !== right && numericType === undefined) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: right, expected: left } }); result = "bool"; }
    else if (["<", ">", "<=", ">="].includes(expression.operator)) { if (numericType === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: expression.operator } }); result = "bool"; }
    else if (["<<", ">>"].includes(expression.operator)) {
      const leftInfo = tinySolIntegerInfo(left); const rightInfo = tinySolIntegerInfo(right);
      if (leftInfo === undefined || rightInfo === undefined || rightInfo.signed) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: expression.operator } });
      result = left;
    }
    else {
      if (numericType === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(expression), details: { operation: expression.operator } });
      result = numericType;
    }
  } else if (expression.kind === "ConditionalExpression") {
    requireType(expressionType(expression.condition, environment), "bool", expression.condition);
    const consequent = expressionType(expression.consequent, environment); const alternate = expressionType(expression.alternate, environment);
    if (!compatible(alternate, consequent, expression.alternate) && !compatible(consequent, alternate, expression.consequent)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: alternate, expected: consequent } });
    result = compatible(alternate, consequent, expression.alternate) ? consequent : alternate;
  } else if (expression.kind === "CastExpression") {
    const source = expressionType(expression.value, environment);
    if (tinySolIntegerInfo(source) === undefined || tinySolIntegerInfo(expression.type.name) === undefined) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: source, expected: expression.type.name } });
    const value = integerLiteralValue(expression.value);
    if (value !== undefined) {
      const bounds = tinySolIntegerBounds(expression.type.name as TinySolIntegerType);
      if (value < bounds.minimum || value > bounds.maximum) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { ...location(expression), details: { width: tinySolIntegerInfo(expression.type.name)!.width / 8 } });
    }
    result = expression.type.name;
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
    const intrinsic = expression.functionName === "keccak256" ? { parameters: ["bytes32"] as const, returns: "bytes32" as const }
      : expression.functionName === "ecrecover" ? { parameters: ["bytes32", "uint256", "bytes32", "bytes32"] as const, returns: "account" as const }
      : expression.functionName === "toAccount" ? { parameters: ["address"] as const, returns: "account" as const }
      : expression.functionName === "toAddress" ? { parameters: ["account"] as const, returns: "address" as const }
      : undefined;
    if (intrinsic !== undefined) {
      if (expression.arguments.length !== intrinsic.parameters.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: expression.arguments.length, expected: intrinsic.parameters.length } });
      expression.arguments.forEach((argument, index) => requireType(expressionType(argument, environment), intrinsic.parameters[index]!, argument));
      result = intrinsic.returns; environment.expressionTypes.set(expression, result); return result;
    }
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
  } else if (expression.kind === "StringLiteralExpression" || expression.kind === "MethodCallExpression") {
    fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "unlowered-bounded-collection" } });
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

function tupleCallReturns(expression: Extract<TinySolStatement, { readonly kind: "TupleAssignment" }>["value"], environment: Environment): readonly TinySolScalarType[] {
  if (expression.kind === "ExternalCallExpression") {
    const fn = interfaceFunction(environment, expression.interfaceName, expression.functionName, expression);
    requireType(expressionType(expression.target, environment), "account", expression.target);
    if (expression.arguments.length !== fn.parameters.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: expression.arguments.length, expected: fn.parameters.length } });
    expression.arguments.forEach((argument, index) => requireType(expressionType(argument, environment), fn.parameters[index]!.name, argument));
    if (expression.callKind === "staticcall" && !fn.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(expression), details: { operation: "staticcall-non-view" } });
    if (environment.view && expression.callKind !== "staticcall") fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(expression), details: { operation: "call" } });
    return fn.returns.map((item) => item.name);
  }
  const declaration = environment.functions.get(expression.functionName);
  if (declaration === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(expression), details: { name: expression.functionName } });
  if (declaration.visibility !== "internal") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(expression), details: { feature: "internal-call-to-non-internal" } });
  if (expression.arguments.length !== declaration.parameters.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(expression), details: { actual: expression.arguments.length, expected: declaration.parameters.length } });
  expression.arguments.forEach((argument, index) => requireType(expressionType(argument, environment), declaration.parameters[index]!.type.name, argument));
  let calls = environment.internalCalls.get(environment.functionName); if (calls === undefined) { calls = new Set(); environment.internalCalls.set(environment.functionName, calls); } calls.add(declaration.name);
  if (environment.view && !declaration.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(expression), details: { operation: "internal-call" } });
  return declaration.returns.map((item) => item.name);
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
    let targetType: TinySolScalarType;
    if (statement.target.kind === "IdentifierExpression") {
      const target = environment.locals.get(statement.target.name) ?? environment.states.get(statement.target.name);
      if (target === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(statement.target), details: { name: statement.target.name } });
      if (typeof target !== "string") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(statement.target) });
      targetType = target; requireType(value, targetType, statement.value);
      if (environment.view && !environment.locals.has(statement.target.name)) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "storage-write" } });
    } else if (statement.target.kind === "IndexExpression") {
      if (statement.target.object.kind !== "IdentifierExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(statement.target), details: { feature: "unlowered-aggregate-index" } });
      const mapping = environment.states.get(statement.target.object.name);
      if (mapping === undefined || typeof mapping === "string") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(statement.target) });
      if ("element" in mapping) { requireType(expressionType(statement.target.index, environment), "uint256", statement.target.index); if (statement.target.index.kind === "LiteralExpression" && BigInt(statement.target.index.value) >= BigInt(mapping.length)) fail(ToolchainErrorCode.ARRAY_BOUNDS, { ...location(statement.target.index), details: { index: statement.target.index.value, length: mapping.length } }); targetType = mapping.element; requireType(value, targetType, statement.value); }
      else { requireType(expressionType(statement.target.index, environment), mapping.key, statement.target.index); targetType = mapping.value; requireType(value, targetType, statement.value); }
      if (environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "mapping-write" } });
    } else if (statement.target.kind === "LocalArrayIndexExpression") {
      const base = environment.locals.get(statement.target.baseName);
      if (base === undefined || base !== statement.target.elementType) fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(statement.target) });
      requireType(expressionType(statement.target.index, environment), "uint256", statement.target.index);
      if (statement.target.index.kind === "LiteralExpression" && BigInt(statement.target.index.value) >= BigInt(statement.target.length)) fail(ToolchainErrorCode.ARRAY_BOUNDS, { ...location(statement.target.index), details: { index: statement.target.index.value, length: statement.target.length } });
      targetType = statement.target.elementType; requireType(value, targetType, statement.value);
    } else if (statement.target.kind === "NestedArrayIndexExpression" || statement.target.kind === "LocalNestedArrayIndexExpression") {
      targetType = expressionType(statement.target, environment); requireType(value, targetType, statement.value);
      if (statement.target.kind === "NestedArrayIndexExpression" && environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "storage-write" } });
    } else if (statement.target.kind === "NestedStorageIndexExpression") {
      targetType = expressionType(statement.target, environment); requireType(value, targetType, statement.value);
      if (environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "mapping-write" } });
    } else fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(statement.target), details: { feature: "unlowered-member-assignment" } });
    if (statement.operator !== undefined && tinySolIntegerInfo(targetType) === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...location(statement), details: { operation: statement.operator, type: targetType } });
    return;
  }
  if (statement.kind === "DeleteStatement") {
    if (statement.target.kind === "IdentifierExpression") {
      const target = environment.locals.get(statement.target.name) ?? environment.states.get(statement.target.name);
      if (target === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(statement.target), details: { name: statement.target.name } });
      if (typeof target !== "string") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(statement.target) });
      if (environment.view && !environment.locals.has(statement.target.name)) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "storage-write" } });
    } else if (statement.target.kind === "IndexExpression") {
      if (statement.target.object.kind !== "IdentifierExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(statement.target), details: { feature: "unlowered-aggregate-index" } });
      const mapping = environment.states.get(statement.target.object.name);
      if (mapping === undefined || typeof mapping === "string") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(statement.target) });
      if ("element" in mapping) { requireType(expressionType(statement.target.index, environment), "uint256", statement.target.index); if (statement.target.index.kind === "LiteralExpression" && BigInt(statement.target.index.value) >= BigInt(mapping.length)) fail(ToolchainErrorCode.ARRAY_BOUNDS, { ...location(statement.target.index), details: { index: statement.target.index.value, length: mapping.length } }); }
      else requireType(expressionType(statement.target.index, environment), mapping.key, statement.target.index);
      if (environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "mapping-write" } });
    } else if (statement.target.kind === "LocalArrayIndexExpression") {
      const base = environment.locals.get(statement.target.baseName);
      if (base === undefined || base !== statement.target.elementType) fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(statement.target) });
      requireType(expressionType(statement.target.index, environment), "uint256", statement.target.index);
      if (statement.target.index.kind === "LiteralExpression" && BigInt(statement.target.index.value) >= BigInt(statement.target.length)) fail(ToolchainErrorCode.ARRAY_BOUNDS, { ...location(statement.target.index), details: { index: statement.target.index.value, length: statement.target.length } });
    } else if (statement.target.kind === "NestedArrayIndexExpression" || statement.target.kind === "LocalNestedArrayIndexExpression") {
      expressionType(statement.target, environment);
      if (statement.target.kind === "NestedArrayIndexExpression" && environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "storage-write" } });
    } else if (statement.target.kind === "NestedStorageIndexExpression") {
      expressionType(statement.target, environment);
      if (environment.view) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(statement), details: { operation: "mapping-write" } });
    } else fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...location(statement.target), details: { feature: "unlowered-member-delete" } });
    return;
  }
  if (statement.kind === "TupleAssignment") {
    const names = statement.bindings.map((binding) => binding.name);
    if (new Set(names).size !== names.length) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...location(statement), details: { scope: environment.functionName } });
    const returns = tupleCallReturns(statement.value, environment);
    if (returns.length !== statement.bindings.length) fail(ToolchainErrorCode.RETURN_MISMATCH, { ...location(statement), details: { actual: returns.length, expected: statement.bindings.length } });
    statement.bindings.forEach((binding, index) => {
      const returned = returns[index]!;
      if (binding.type !== undefined) {
        if (environment.declaredLocals.has(binding.name) || environment.states.has(binding.name)) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...location(binding), details: { name: binding.name, scope: environment.functionName } });
        if (binding.type.name !== returned && !integerWidening(returned, binding.type.name)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(binding), details: { actual: returned, expected: binding.type.name } });
        environment.declaredLocals.add(binding.name); environment.locals.set(binding.name, binding.type.name);
      } else {
        const target = environment.locals.get(binding.name) ?? environment.states.get(binding.name);
        if (target === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(binding), details: { name: binding.name } });
        if (typeof target !== "string") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...location(binding) });
        if (target !== returned && !integerWidening(returned, target)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(binding), details: { actual: returned, expected: target } });
        if (environment.view && !environment.locals.has(binding.name)) fail(ToolchainErrorCode.STATIC_VIOLATION, { ...location(binding), details: { operation: "storage-write" } });
      }
    });
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
  if (statement.kind === "BreakStatement" || statement.kind === "ContinueStatement") return;
  if (statement.kind === "ReturnStatement") {
    if (statement.values.length !== environment.returns.length) fail(ToolchainErrorCode.RETURN_MISMATCH, { ...location(statement), details: { actual: statement.values.length, expected: environment.returns.length } });
    statement.values.forEach((value, index) => requireType(expressionType(value, environment), environment.returns[index]!, value)); return;
  }
  if (statement.kind === "RequireStatement") { requireType(expressionType(statement.condition, environment), "bool", statement.condition); return; }
  if (statement.kind === "RevertStatement") {
    if (statement.errorName === undefined) return;
    const error = environment.errors.get(statement.errorName); if (error === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...location(statement), details: { name: statement.errorName } });
    const args = statement.arguments ?? []; if (args.length !== error.types.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...location(statement), details: { actual: args.length, expected: error.types.length } });
    args.forEach((argument, index) => requireType(expressionType(argument, environment), error.types[index]!, argument)); return;
  }
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
  const states = new Map<string, TinySolScalarType | { readonly key: TinySolScalarType; readonly value: TinySolScalarType } | { readonly element: TinySolScalarType; readonly length: number }>();
  for (const state of program.contract.stateVariables) states.set(state.name, state.type.kind === "ScalarType" ? state.type.arrayLength === undefined ? state.type.name : Object.freeze({ element: state.type.name, length: state.type.arrayLength }) : Object.freeze({ key: state.type.keyType.name, value: state.type.valueType.name }));
  const events = new Map(program.contract.events.map((event) => [event.name, Object.freeze({ types: Object.freeze(event.parameters.map((parameter) => parameter.type.name)) })]));
  const errors = new Map(program.contract.errors.map((error) => [error.name, Object.freeze({ types: Object.freeze(error.parameters.map((parameter) => parameter.type.name)) })]));
  const interfaces = new Map(program.interfaces.map((item) => [item.name, item]));
  const functions = new Map(program.contract.functions.map((fn) => [fn.name, fn]));
  const internalCalls = new Map<string, Set<string>>();
  const base = { states, events, errors, interfaces, functions, internalCalls, expressionTypes };
  if (program.contract.constructor?.kind === "ConstructorDeclaration") checkFunction({ ...program.contract.constructor, name: "constructor", returns: Object.freeze([]), view: false }, base);
  for (const fn of program.contract.functions) checkFunction(fn, base);
  checkInternalCallCycles(program.contract.functions, internalCalls);
  return Object.freeze({ ...resolved, expressionTypes, staticFunctions: new Set(program.contract.functions.filter((fn) => fn.view).map((fn) => fn.name)) });
}

export function tinySolAbiType(type: TinySolScalarType): string { return abiType(type); }
export function tinySolSignature(name: string, types: readonly TinySolScalarType[]): string { return signature(name, types); }
