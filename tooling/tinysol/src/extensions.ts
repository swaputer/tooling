import { ToolchainErrorCode, fail } from "./errors.js";
import { lowerStructs } from "./struct-lowering.js";
import { lowerFixedArrays } from "./array-lowering.js";
import { lowerBoundedCollections } from "./bounded-lowering.js";
import { lowerStructMappingFields } from "./mapping-field-lowering.js";
import { tinySolIntegerBounds, tinySolIntegerInfo } from "./compiler-types.js";
import type {
  SourceSpan,
  TinySolBlock,
  TinySolExpression,
  TinySolIdentifierExpression,
  TinySolProgram,
  TinySolIntegerType,
  TinySolScalarType,
  TinySolScalarTypeNode,
  TinySolStatement,
  TinySolStructDeclaration
} from "./compiler-types.js";

const UINT256_MODULUS = 1n << 256n;

function at(span: SourceSpan) { return { line: span.start.line, column: span.start.column, offset: span.start.byteOffset }; }

type ConstantValue = { readonly type: TinySolScalarType; readonly value: bigint; readonly span: SourceSpan };

function evaluate(expression: TinySolExpression, resolve: (name: string, span: SourceSpan) => ConstantValue): bigint {
  if (expression.kind === "LiteralExpression") return expression.literalKind === "bool" ? (expression.value === "true" ? 1n : 0n) : BigInt(expression.value);
  if (expression.kind === "IdentifierExpression") return resolve(expression.name, expression.span).value;
  if (expression.kind === "UnaryExpression") {
    const operand = evaluate(expression.operand, resolve);
    if (expression.operator === "!") return operand === 0n ? 1n : 0n;
    if (expression.operator === "~") return UINT256_MODULUS - 1n - operand;
    return -operand;
  }
  if (expression.kind === "CastExpression") {
    const value = evaluate(expression.value, resolve); const bounds = tinySolIntegerBounds(expression.type.name as TinySolIntegerType);
    if (value < bounds.minimum || value > bounds.maximum) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { ...at(expression.span), details: { width: tinySolIntegerInfo(expression.type.name)!.width / 8 } });
    return value;
  }
  if (expression.kind === "ConditionalExpression") return evaluate(expression.condition, resolve) !== 0n ? evaluate(expression.consequent, resolve) : evaluate(expression.alternate, resolve);
  if (expression.kind !== "BinaryExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "constant-expression" } });
  const left = evaluate(expression.left, resolve); const right = evaluate(expression.right, resolve);
  switch (expression.operator) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": if (right === 0n) fail(ToolchainErrorCode.CONST_EVAL_DIV_ZERO, at(expression.span)); return left / right;
    case "%": if (right === 0n) fail(ToolchainErrorCode.CONST_EVAL_DIV_ZERO, at(expression.span)); return left % right;
    case "<<": case ">>":
      if (right < 0n || right >= 256n) fail(ToolchainErrorCode.CONST_EVAL_INVALID_SHIFT, { ...at(expression.span), details: { shift: right } });
      return expression.operator === "<<" ? left << right : left >> right;
    case "&": return left & right;
    case "|": return left | right;
    case "^": return left ^ right;
    case "==": return left === right ? 1n : 0n;
    case "!=": return left !== right ? 1n : 0n;
    case "<": return left < right ? 1n : 0n;
    case ">": return left > right ? 1n : 0n;
    case "<=": return left <= right ? 1n : 0n;
    case ">=": return left >= right ? 1n : 0n;
    case "&&": return left !== 0n && right !== 0n ? 1n : 0n;
    case "||": return left !== 0n || right !== 0n ? 1n : 0n;
    default: fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: `constant-operator:${expression.operator}` } });
  }
}

function constantType(expression: TinySolExpression, resolve: (name: string, span: SourceSpan) => ConstantValue): TinySolScalarType {
  if (expression.kind === "LiteralExpression") return expression.literalKind === "integer" ? "uint256" : expression.literalKind;
  if (expression.kind === "IdentifierExpression") return resolve(expression.name, expression.span).type;
  if (expression.kind === "UnaryExpression") return expression.operator === "!" ? "bool" : expression.operator === "-" ? "int256" : constantType(expression.operand, resolve);
  if (expression.kind === "CastExpression") {
    const source = constantType(expression.value, resolve);
    if (tinySolIntegerInfo(source) === undefined || tinySolIntegerInfo(expression.type.name) === undefined) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: source, expected: expression.type.name } });
    return expression.type.name;
  }
  if (expression.kind === "BinaryExpression") return ["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(expression.operator) ? "bool" : constantType(expression.left, resolve);
  if (expression.kind === "ConditionalExpression") {
    const condition = constantType(expression.condition, resolve); const consequent = constantType(expression.consequent, resolve); const alternate = constantType(expression.alternate, resolve);
    if (condition !== "bool") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.condition.span), details: { actual: condition, expected: "bool" } });
    if (consequent !== alternate) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: alternate, expected: consequent } });
    return consequent;
  }
  fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "constant-expression" } });
}

function literal(value: ConstantValue, span: SourceSpan): TinySolExpression {
  const normalized = value.value < 0n ? value.value : value.value;
  if (value.type === "bool") return Object.freeze({ kind: "LiteralExpression", literalKind: "bool", value: normalized === 0n ? "false" : "true", span });
  if (value.type === "bytes32") return Object.freeze({ kind: "LiteralExpression", literalKind: "bytes32", value: `0x${normalized.toString(16).padStart(64, "0")}`, span });
  if (value.type === "address") return Object.freeze({ kind: "LiteralExpression", literalKind: "address", value: `0x${normalized.toString(16).padStart(40, "0")}`, span });
  if (value.type === "account") return Object.freeze({ kind: "LiteralExpression", literalKind: "account", value: `0x${normalized.toString(16).padStart(64, "0")}`, span });
  if (normalized < 0n) return Object.freeze({ kind: "UnaryExpression", operator: "-", operand: Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: (-normalized).toString(), span }), span });
  return Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: normalized.toString(), span });
}

function mapExpression(expression: TinySolExpression, constants: ReadonlyMap<string, ConstantValue>): TinySolExpression {
  if (expression.kind === "IdentifierExpression") return constants.has(expression.name) ? literal(constants.get(expression.name)!, expression.span) : expression;
  if (expression.kind === "UnaryExpression") return Object.freeze({ ...expression, operand: mapExpression(expression.operand, constants) });
  if (expression.kind === "CastExpression") return Object.freeze({ ...expression, value: mapExpression(expression.value, constants) });
  if (expression.kind === "ArrayLiteralExpression") return Object.freeze({ ...expression, elements: Object.freeze(expression.elements.map((item) => mapExpression(item, constants))) });
  if (expression.kind === "BinaryExpression") return Object.freeze({ ...expression, left: mapExpression(expression.left, constants), right: mapExpression(expression.right, constants) });
  if (expression.kind === "ConditionalExpression") return Object.freeze({ ...expression, condition: mapExpression(expression.condition, constants), consequent: mapExpression(expression.consequent, constants), alternate: mapExpression(expression.alternate, constants) });
  if (expression.kind === "IndexExpression") return Object.freeze({ ...expression, object: mapExpression(expression.object, constants) as typeof expression.object, index: mapExpression(expression.index, constants) });
  if (expression.kind === "NestedArrayIndexExpression" || expression.kind === "LocalNestedArrayIndexExpression") return Object.freeze({ ...expression, indices: Object.freeze(expression.indices.map((index) => mapExpression(index, constants))) });
  if (expression.kind === "NestedStorageIndexExpression") return Object.freeze({ ...expression, key: mapExpression(expression.key, constants), indices: Object.freeze(expression.indices.map((index) => mapExpression(index, constants))) });
  if (expression.kind === "MemberExpression") return Object.freeze({ ...expression, object: mapExpression(expression.object, constants) as typeof expression.object });
  if (expression.kind === "StructLiteralExpression") return Object.freeze({ ...expression, fields: Object.freeze(expression.fields.map((field) => Object.freeze({ ...field, value: mapExpression(field.value, constants) }))) });
  if (expression.kind === "ExternalCallExpression") return Object.freeze({ ...expression, target: mapExpression(expression.target, constants), arguments: Object.freeze(expression.arguments.map((item) => mapExpression(item, constants))) });
  if (expression.kind === "FunctionCallExpression") return Object.freeze({ ...expression, arguments: Object.freeze(expression.arguments.map((item) => mapExpression(item, constants))) });
  if (expression.kind === "CreateExpression") return Object.freeze({ ...expression, codeHash: mapExpression(expression.codeHash, constants), arguments: Object.freeze(expression.arguments.map((item) => mapExpression(item, constants))) });
  return expression;
}

function mapStatement(statement: TinySolStatement, constants: ReadonlyMap<string, ConstantValue>): TinySolStatement {
  if (statement.kind === "Block") return mapBlock(statement, constants);
  if (statement.kind === "VariableDeclaration") return Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: mapExpression(statement.initializer, constants) }) });
  if (statement.kind === "Assignment") return Object.freeze({ ...statement, target: mapExpression(statement.target, constants) as typeof statement.target, value: mapExpression(statement.value, constants) });
  if (statement.kind === "DeleteStatement") return Object.freeze({ ...statement, target: mapExpression(statement.target, constants) as typeof statement.target });
  if (statement.kind === "TupleAssignment") return Object.freeze({ ...statement, value: mapExpression(statement.value, constants) as typeof statement.value });
  if (statement.kind === "IfStatement") return Object.freeze({ ...statement, condition: mapExpression(statement.condition, constants), consequent: mapBlock(statement.consequent, constants), ...(statement.alternate === undefined ? {} : { alternate: mapBlock(statement.alternate, constants) }) });
  if (statement.kind === "WhileStatement") return Object.freeze({ ...statement, condition: mapExpression(statement.condition, constants), body: mapBlock(statement.body, constants) });
  if (statement.kind === "ForStatement") return Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: mapStatement(statement.initializer, constants) as typeof statement.initializer }), ...(statement.condition === undefined ? {} : { condition: mapExpression(statement.condition, constants) }), ...(statement.update === undefined ? {} : { update: mapStatement(statement.update, constants) as typeof statement.update }), body: mapBlock(statement.body, constants) });
  if (statement.kind === "ReturnStatement") return Object.freeze({ ...statement, values: Object.freeze(statement.values.map((item) => mapExpression(item, constants))) });
  if (statement.kind === "RequireStatement") return Object.freeze({ ...statement, condition: mapExpression(statement.condition, constants) });
  if (statement.kind === "RevertStatement" && statement.arguments !== undefined) return Object.freeze({ ...statement, arguments: Object.freeze(statement.arguments.map((item) => mapExpression(item, constants))) });
  if (statement.kind === "EmitStatement") return Object.freeze({ ...statement, arguments: Object.freeze(statement.arguments.map((item) => mapExpression(item, constants))) });
  if (statement.kind === "ExpressionStatement") return Object.freeze({ ...statement, expression: mapExpression(statement.expression, constants) });
  return statement;
}

function mapBlock(block: TinySolBlock, constants: ReadonlyMap<string, ConstantValue>): TinySolBlock {
  return Object.freeze({ ...block, statements: Object.freeze(block.statements.map((item) => mapStatement(item, constants))) });
}

function rejectAggregateLocalArrays(block: TinySolBlock, aggregates: ReadonlySet<string>): void {
  for (const statement of block.statements) {
    if (statement.kind === "VariableDeclaration" && statement.type.arrayLength !== undefined && statement.type.userType !== undefined && !aggregates.has(statement.type.userType)) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(statement.type.span), details: { feature: "aggregate-fixed-array" } });
    if (statement.kind === "Block") rejectAggregateLocalArrays(statement, aggregates);
    if (statement.kind === "IfStatement") { rejectAggregateLocalArrays(statement.consequent, aggregates); if (statement.alternate !== undefined) rejectAggregateLocalArrays(statement.alternate, aggregates); }
    if (statement.kind === "WhileStatement") rejectAggregateLocalArrays(statement.body, aggregates);
    if (statement.kind === "ForStatement") { if (statement.initializer?.kind === "VariableDeclaration" && statement.initializer.type.arrayLength !== undefined && statement.initializer.type.userType !== undefined && !aggregates.has(statement.initializer.type.userType)) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(statement.initializer.type.span), details: { feature: "aggregate-fixed-array" } }); rejectAggregateLocalArrays(statement.body, aggregates); }
  }
}

type EnumTable = ReadonlyMap<string, readonly string[]>;
interface EnumBinding { readonly enumName: string; readonly length?: number; readonly dimensions?: readonly number[] }
interface NominalBinding { readonly userType: string; readonly indexed?: boolean; readonly length?: number; readonly dimensions?: readonly number[] }
interface EnumCallableShape { readonly parameters: readonly TinySolScalarTypeNode[]; readonly returns: readonly TinySolScalarTypeNode[] }
interface EnumLoweringContext {
  readonly structs: ReadonlyMap<string, TinySolStructDeclaration>;
  readonly functions: ReadonlyMap<string, EnumCallableShape>;
  readonly interfaces: ReadonlyMap<string, ReadonlyMap<string, EnumCallableShape>>;
  readonly constructors: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly events: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly errors: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  temporary: number;
}

function typeDimensions(type: TinySolScalarTypeNode | undefined): readonly number[] {
  return type?.arrayDimensions ?? (type?.arrayLength === undefined ? Object.freeze([]) : Object.freeze([type.arrayLength]));
}

function shapeLength(dimensions: readonly number[]): number { return dimensions.reduce((product, dimension) => product * dimension, 1); }

function sameShape(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
  const a = left ?? []; const b = right ?? [];
  return a.length === b.length && a.every((dimension, index) => dimension === b[index]);
}

function enumLiteral(expression: Extract<TinySolExpression, { readonly kind: "MemberExpression" }>, enums: EnumTable): TinySolExpression | undefined {
  if (expression.object.kind !== "IdentifierExpression") return undefined;
  const members = enums.get(expression.object.name); if (members === undefined) return undefined;
  const index = members.indexOf(expression.member);
  if (index < 0) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...at(expression.span), details: { name: `${expression.object.name}.${expression.member}` } });
  return Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span: expression.span });
}

function lowerEnumExpression(expression: TinySolExpression, enums: EnumTable): TinySolExpression {
  if (expression.kind === "MemberExpression") return enumLiteral(expression, enums) ?? Object.freeze({ ...expression, object: lowerEnumExpression(expression.object, enums) as typeof expression.object });
  if (expression.kind === "StructLiteralExpression") return Object.freeze({ ...expression, fields: Object.freeze(expression.fields.map((field) => Object.freeze({ ...field, value: lowerEnumExpression(field.value, enums) }))) });
  if (expression.kind === "UnaryExpression") return Object.freeze({ ...expression, operand: lowerEnumExpression(expression.operand, enums) });
  if (expression.kind === "CastExpression") return Object.freeze({ ...expression, value: lowerEnumExpression(expression.value, enums) });
  if (expression.kind === "ArrayLiteralExpression") return Object.freeze({ ...expression, elements: Object.freeze(expression.elements.map((item) => lowerEnumExpression(item, enums))) });
  if (expression.kind === "BinaryExpression") return Object.freeze({ ...expression, left: lowerEnumExpression(expression.left, enums), right: lowerEnumExpression(expression.right, enums) });
  if (expression.kind === "ConditionalExpression") return Object.freeze({ ...expression, condition: lowerEnumExpression(expression.condition, enums), consequent: lowerEnumExpression(expression.consequent, enums), alternate: lowerEnumExpression(expression.alternate, enums) });
  if (expression.kind === "IndexExpression") return Object.freeze({ ...expression, object: lowerEnumExpression(expression.object, enums) as typeof expression.object, index: lowerEnumExpression(expression.index, enums) });
  if (expression.kind === "NestedArrayIndexExpression" || expression.kind === "LocalNestedArrayIndexExpression") return Object.freeze({ ...expression, indices: Object.freeze(expression.indices.map((index) => lowerEnumExpression(index, enums))) });
  if (expression.kind === "NestedStorageIndexExpression") return Object.freeze({ ...expression, key: lowerEnumExpression(expression.key, enums), indices: Object.freeze(expression.indices.map((index) => lowerEnumExpression(index, enums))) });
  if (expression.kind === "ExternalCallExpression") return Object.freeze({ ...expression, target: lowerEnumExpression(expression.target, enums), arguments: Object.freeze(expression.arguments.map((item) => lowerEnumExpression(item, enums))) });
  if (expression.kind === "FunctionCallExpression") return Object.freeze({ ...expression, arguments: Object.freeze(expression.arguments.map((item) => lowerEnumExpression(item, enums))) });
  if (expression.kind === "CreateExpression") return Object.freeze({ ...expression, codeHash: lowerEnumExpression(expression.codeHash, enums), arguments: Object.freeze(expression.arguments.map((item) => lowerEnumExpression(item, enums))) });
  return expression;
}

function enumBinding(type: TinySolScalarTypeNode | undefined, enums: EnumTable): EnumBinding | undefined {
  if (type?.userType === undefined || !enums.has(type.userType)) return undefined;
  const dimensions = typeDimensions(type);
  return Object.freeze({ enumName: type.userType, ...(type.arrayLength === undefined ? {} : { length: type.arrayLength, dimensions }) });
}

function nominalBinding(type: TinySolScalarTypeNode | undefined): NominalBinding | undefined {
  if (type?.userType === undefined) return undefined;
  const dimensions = typeDimensions(type);
  return Object.freeze({ userType: type.userType, ...(type.arrayLength === undefined ? {} : { length: type.arrayLength, dimensions }) });
}

function enumFromNominal(binding: NominalBinding | undefined, enums: EnumTable): EnumBinding | undefined {
  if (binding === undefined || !enums.has(binding.userType)) return undefined;
  return Object.freeze({ enumName: binding.userType, ...(binding.length === undefined ? {} : { length: binding.length, dimensions: binding.dimensions }) });
}

function enumTypeName(binding: EnumBinding | undefined): string {
  return binding === undefined ? "uint256" : `${binding.enumName}${binding.dimensions === undefined ? "" : [...binding.dimensions].reverse().map((length) => `[${length}]`).join("")}`;
}

function callableReturns(expression: TinySolExpression, context: EnumLoweringContext): readonly TinySolScalarTypeNode[] | undefined {
  if (expression.kind === "FunctionCallExpression") return context.functions.get(expression.functionName)?.returns;
  if (expression.kind === "ExternalCallExpression") return context.interfaces.get(expression.interfaceName)?.get(expression.functionName)?.returns;
  return undefined;
}

interface ResolvedNominal { readonly userType: string; readonly dimensions?: readonly number[]; readonly needsIndex?: boolean }

function nominalTypeOf(expression: TinySolExpression, types: ReadonlyMap<string, NominalBinding>, context: EnumLoweringContext): ResolvedNominal | undefined {
  if (expression.kind === "IdentifierExpression") {
    const binding = types.get(expression.name); if (binding === undefined) return undefined;
    return Object.freeze({ userType: binding.userType, ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }), ...(binding.indexed === true ? { needsIndex: true } : {}) });
  }
  if (expression.kind === "IndexExpression") {
    const binding = nominalTypeOf(expression.object, types, context); if (binding === undefined) return undefined;
    if (binding.needsIndex === true) return Object.freeze({ userType: binding.userType, ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }) });
    if (binding.dimensions !== undefined && binding.dimensions.length > 0) {
      const remaining = Object.freeze(binding.dimensions.slice(1));
      return Object.freeze({ userType: binding.userType, ...(remaining.length === 0 ? {} : { dimensions: remaining }) });
    }
    return undefined;
  }
  if (expression.kind === "MemberExpression") {
    const owner = nominalTypeOf(expression.object, types, context);
    if (owner === undefined || owner.needsIndex === true || owner.dimensions !== undefined) return undefined;
    const field = context.structs.get(owner.userType)?.fields.find((candidate) => candidate.name === expression.member);
    if (field?.type.userType === undefined) return undefined;
    const dimensions = typeDimensions(field.type);
    return Object.freeze({ userType: field.type.userType, ...(dimensions.length === 0 ? {} : { dimensions }) });
  }
  return undefined;
}

function enumTypeOf(expression: TinySolExpression, types: ReadonlyMap<string, NominalBinding>, enums: EnumTable, context: EnumLoweringContext): EnumBinding | undefined {
  if (expression.kind === "IdentifierExpression") return enumFromNominal(types.get(expression.name), enums);
  const nominal = nominalTypeOf(expression, types, context);
  if (nominal !== undefined && nominal.needsIndex !== true && enums.has(nominal.userType)) return Object.freeze({ enumName: nominal.userType, ...(nominal.dimensions === undefined ? {} : { length: shapeLength(nominal.dimensions), dimensions: nominal.dimensions }) });
  if (expression.kind === "MemberExpression" && expression.object.kind === "IdentifierExpression" && enums.has(expression.object.name)) return Object.freeze({ enumName: expression.object.name });
  if (expression.kind === "ConditionalExpression") {
    const consequent = enumTypeOf(expression.consequent, types, enums, context); const alternate = enumTypeOf(expression.alternate, types, enums, context);
    return enumTypeName(consequent) === enumTypeName(alternate) ? consequent : undefined;
  }
  const returns = callableReturns(expression, context);
  return returns?.length === 1 ? enumBinding(returns[0], enums) : undefined;
}

function requireEnum(expected: EnumBinding | undefined, expression: TinySolExpression, types: ReadonlyMap<string, NominalBinding>, enums: EnumTable, context: EnumLoweringContext): void {
  if (expected === undefined) return;
  if (expected.dimensions !== undefined && expression.kind === "ArrayLiteralExpression") {
    const validate = (value: TinySolExpression, depth: number): void => {
      if (depth === expected.dimensions!.length) { requireEnum(Object.freeze({ enumName: expected.enumName }), value, types, enums, context); return; }
      if (value.kind !== "ArrayLiteralExpression" || value.elements.length !== expected.dimensions![depth]) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: value.kind === "ArrayLiteralExpression" ? value.elements.length : "scalar", expected: expected.dimensions![depth]! } });
      value.elements.forEach((item) => validate(item, depth + 1));
    };
    validate(expression, 0); return;
  }
  const actual = enumTypeOf(expression, types, enums, context);
  if (actual?.enumName !== expected.enumName || !sameShape(actual.dimensions, expected.dimensions)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: enumTypeName(actual), expected: enumTypeName(expected) } });
}

function validateEnumCalls(expression: TinySolExpression, types: ReadonlyMap<string, NominalBinding>, enums: EnumTable, context: EnumLoweringContext): void {
  const validate = (arguments_: readonly TinySolExpression[], parameters: readonly TinySolScalarTypeNode[] | undefined) => arguments_.forEach((argument, index) => { requireEnum(enumBinding(parameters?.[index], enums), argument, types, enums, context); validateEnumCalls(argument, types, enums, context); });
  if (expression.kind === "FunctionCallExpression") { validate(expression.arguments, context.functions.get(expression.functionName)?.parameters); return; }
  if (expression.kind === "ExternalCallExpression") { validateEnumCalls(expression.target, types, enums, context); validate(expression.arguments, context.interfaces.get(expression.interfaceName)?.get(expression.functionName)?.parameters); return; }
  if (expression.kind === "CreateExpression") { validateEnumCalls(expression.codeHash, types, enums, context); validate(expression.arguments, context.constructors.get(expression.interfaceName)); return; }
  if (expression.kind === "StructLiteralExpression") {
    const declaration = context.structs.get(expression.structName);
    expression.fields.forEach((field) => {
      const expected = declaration?.fields.find((candidate) => candidate.name === field.name)?.type;
      requireEnum(enumBinding(expected, enums), field.value, types, enums, context);
      validateEnumCalls(field.value, types, enums, context);
    });
    return;
  }
  if (expression.kind === "ArrayLiteralExpression") { expression.elements.forEach((item) => validateEnumCalls(item, types, enums, context)); return; }
  if (expression.kind === "IndexExpression") { validateEnumCalls(expression.object, types, enums, context); validateEnumCalls(expression.index, types, enums, context); return; }
  if (expression.kind === "NestedStorageIndexExpression") { validateEnumCalls(expression.key, types, enums, context); expression.indices.forEach((index) => validateEnumCalls(index, types, enums, context)); return; }
  if (expression.kind === "NestedArrayIndexExpression" || expression.kind === "LocalNestedArrayIndexExpression") { expression.indices.forEach((index) => validateEnumCalls(index, types, enums, context)); return; }
  if (expression.kind === "LocalArrayIndexExpression") { validateEnumCalls(expression.index, types, enums, context); return; }
  if (expression.kind === "MemberExpression") { validateEnumCalls(expression.object, types, enums, context); return; }
  if (expression.kind === "UnaryExpression" || expression.kind === "CastExpression") { validateEnumCalls(expression.kind === "UnaryExpression" ? expression.operand : expression.value, types, enums, context); return; }
  if (expression.kind === "BinaryExpression") { validateEnumCalls(expression.left, types, enums, context); validateEnumCalls(expression.right, types, enums, context); return; }
  if (expression.kind === "ConditionalExpression") { validateEnumCalls(expression.condition, types, enums, context); validateEnumCalls(expression.consequent, types, enums, context); validateEnumCalls(expression.alternate, types, enums, context); }
}

function loweredType<T extends { readonly name: TinySolScalarType; readonly userType?: string; readonly arrayLength?: number; readonly arrayDimensions?: readonly number[]; readonly span: SourceSpan; readonly kind: "ScalarType" }>(type: T, enums: EnumTable): T {
  if (type.userType === undefined || !enums.has(type.userType)) return type;
  return Object.freeze({ kind: "ScalarType", name: "uint256", ...(type.arrayLength === undefined ? {} : { arrayLength: type.arrayLength }), ...(type.arrayDimensions === undefined ? {} : { arrayDimensions: type.arrayDimensions }), span: type.span }) as T;
}

function abiEnumGuard(name: string, maximum: number, span: SourceSpan): TinySolStatement {
  const identifier = Object.freeze({ kind: "IdentifierExpression", name, span }) as TinySolExpression;
  const limit = Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(maximum), span }) as TinySolExpression;
  const condition = Object.freeze({ kind: "BinaryExpression", operator: "<", left: identifier, right: limit, span }) as TinySolExpression;
  return Object.freeze({ kind: "RequireStatement", condition, span });
}

function enumGuards(name: string, binding: EnumBinding, maximum: number, span: SourceSpan): readonly TinySolStatement[] {
  if (binding.length === undefined) return Object.freeze([abiEnumGuard(name, maximum, span)]);
  let coordinates: readonly (readonly number[])[] = Object.freeze([Object.freeze([])]);
  for (const dimension of binding.dimensions ?? [binding.length]) coordinates = Object.freeze(coordinates.flatMap((prefix) => Array.from({ length: dimension }, (_, index) => Object.freeze([...prefix, index]))));
  return Object.freeze(coordinates.map((coordinate) => {
    let item = Object.freeze({ kind: "IdentifierExpression", name, span }) as TinySolExpression;
    for (const index of coordinate) item = Object.freeze({ kind: "IndexExpression", object: item as TinySolIdentifierExpression | Extract<TinySolExpression, { readonly kind: "IndexExpression" }>, index: Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span }), span });
    const limit = Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(maximum), span }) as TinySolExpression;
    return Object.freeze({ kind: "RequireStatement", condition: Object.freeze({ kind: "BinaryExpression", operator: "<", left: item, right: limit, span }), span }) as TinySolStatement;
  }));
}

function loweredEnumType(binding: EnumBinding, span: SourceSpan): TinySolScalarTypeNode {
  return Object.freeze({ kind: "ScalarType", name: "uint256", ...(binding.length === undefined ? {} : { arrayLength: binding.length }), ...(binding.dimensions !== undefined && binding.dimensions.length > 1 ? { arrayDimensions: binding.dimensions } : {}), span });
}

function lowerEnumBlock(block: TinySolBlock, enums: EnumTable, inherited: ReadonlyMap<string, NominalBinding>, returns: readonly TinySolScalarTypeNode[], context: EnumLoweringContext): TinySolBlock {
  const types = new Map(inherited);
  const statements: TinySolStatement[] = [];
  const expression = (value: TinySolExpression): TinySolExpression => { validateEnumCalls(value, types, enums, context); return lowerEnumExpression(value, enums); };
  for (const statement of block.statements) {
    if (statement.kind === "Block") { statements.push(lowerEnumBlock(statement, enums, types, returns, context)); continue; }
    if (statement.kind === "VariableDeclaration") {
      const nominal = nominalBinding(statement.type); const binding = enumFromNominal(nominal, enums);
      if (statement.initializer !== undefined) requireEnum(binding, statement.initializer, types, enums, context);
      if (nominal !== undefined) types.set(statement.name, nominal);
      statements.push(Object.freeze({ ...statement, type: loweredType(statement.type, enums), ...(statement.initializer === undefined ? {} : { initializer: expression(statement.initializer) }) }));
      if (binding !== undefined) statements.push(...enumGuards(statement.name, binding, enums.get(binding.enumName)!.length, statement.span));
      continue;
    }
    if (statement.kind === "Assignment") {
      const target = enumTypeOf(statement.target, types, enums, context);
      requireEnum(target, statement.value, types, enums, context);
      if (statement.target.kind === "MemberExpression" && statement.target.object.kind === "IdentifierExpression" && enums.has(statement.target.object.name)) fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...at(statement.target.span), details: { name: `${statement.target.object.name}.${statement.target.member}` } });
      if (target !== undefined && callableReturns(statement.value, context)?.length === 1) {
        const name = `$enumValue${context.temporary++}`; statements.push(Object.freeze({ kind: "VariableDeclaration", name, type: loweredEnumType(target, statement.value.span), initializer: expression(statement.value), span: statement.span }), ...enumGuards(name, target, enums.get(target.enumName)!.length, statement.span));
        statements.push(Object.freeze({ ...statement, target: expression(statement.target) as typeof statement.target, value: Object.freeze({ kind: "IdentifierExpression", name, span: statement.value.span }) }));
      } else {
        statements.push(Object.freeze({ ...statement, target: expression(statement.target) as typeof statement.target, value: expression(statement.value) }));
        if (target !== undefined && statement.target.kind === "IdentifierExpression") statements.push(...enumGuards(statement.target.name, target, enums.get(target.enumName)!.length, statement.span));
      }
      continue;
    }
    if (statement.kind === "DeleteStatement") { statements.push(Object.freeze({ ...statement, target: expression(statement.target) as typeof statement.target })); continue; }
    if (statement.kind === "TupleAssignment") {
      const returned = callableReturns(statement.value, context);
      const guards: TinySolStatement[] = [];
      statement.bindings.forEach((binding, index) => {
        const declared = nominalBinding(binding.type); const expected = binding.type === undefined ? enumFromNominal(types.get(binding.name), enums) : enumFromNominal(declared, enums); const actual = enumBinding(returned?.[index], enums);
        if (expected !== undefined && enumTypeName(actual) !== enumTypeName(expected)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(binding.span), details: { actual: enumTypeName(actual), expected: enumTypeName(expected) } });
        if (expected === undefined && actual !== undefined) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(binding.span), details: { actual: enumTypeName(actual), expected: binding.type?.name ?? "scalar" } });
        if (binding.type !== undefined && declared !== undefined) types.set(binding.name, declared);
        if (expected !== undefined) guards.push(...enumGuards(binding.name, expected, enums.get(expected.enumName)!.length, binding.span));
      });
      statements.push(Object.freeze({ ...statement, bindings: Object.freeze(statement.bindings.map((binding) => binding.type === undefined ? binding : Object.freeze({ ...binding, type: loweredType(binding.type, enums) }))), value: expression(statement.value) as typeof statement.value }), ...guards);
      continue;
    }
    if (statement.kind === "IfStatement") { statements.push(Object.freeze({ ...statement, condition: expression(statement.condition), consequent: lowerEnumBlock(statement.consequent, enums, types, returns, context), ...(statement.alternate === undefined ? {} : { alternate: lowerEnumBlock(statement.alternate, enums, types, returns, context) }) })); continue; }
    if (statement.kind === "WhileStatement") { statements.push(Object.freeze({ ...statement, condition: expression(statement.condition), body: lowerEnumBlock(statement.body, enums, types, returns, context) })); continue; }
    if (statement.kind === "ForStatement") {
      const one = (item: TinySolStatement | undefined, bindings: ReadonlyMap<string, NominalBinding>) => item === undefined ? Object.freeze([]) : lowerEnumBlock(Object.freeze({ kind: "Block", statements: Object.freeze([item]), span: item.span }), enums, bindings, returns, context).statements;
      const initializer = one(statement.initializer, types); const loopTypes = new Map(types);
      if (statement.initializer?.kind === "VariableDeclaration") { const binding = nominalBinding(statement.initializer.type); if (binding !== undefined) loopTypes.set(statement.initializer.name, binding); }
      const update = one(statement.update, loopTypes); const body = lowerEnumBlock(statement.body, enums, loopTypes, returns, context);
      const condition = statement.condition === undefined ? undefined : (() => { validateEnumCalls(statement.condition!, loopTypes, enums, context); return lowerEnumExpression(statement.condition!, enums); })();
      if (initializer.length <= 1 && update.length <= 1) {
        statements.push(Object.freeze({ ...statement, ...(initializer.length === 0 ? {} : { initializer: initializer[0] as typeof statement.initializer }), ...(condition === undefined ? {} : { condition }), ...(update.length === 0 ? {} : { update: update[0] as typeof statement.update }), body })); continue;
      }
      const loopCondition = condition ?? Object.freeze({ kind: "LiteralExpression", literalKind: "bool", value: "true", span: statement.span }) as TinySolExpression;
      const loopBody = Object.freeze({ ...body, statements: Object.freeze([...body.statements, ...update]) });
      const loop = Object.freeze({ kind: "WhileStatement", condition: loopCondition, body: loopBody, span: statement.span }) as TinySolStatement;
      statements.push(Object.freeze({ kind: "Block", statements: Object.freeze([...initializer, loop]), span: statement.span })); continue;
    }
    if (statement.kind === "ReturnStatement") {
      const values: TinySolExpression[] = [];
      statement.values.forEach((value, index) => {
        const expected = enumBinding(returns[index], enums);
        requireEnum(expected, value, types, enums, context);
        if (expected === undefined) { values.push(expression(value)); return; }
        const name = `$enumReturn${context.temporary++}`;
        statements.push(Object.freeze({ kind: "VariableDeclaration", name, type: loweredEnumType(expected, value.span), initializer: expression(value), span: value.span }), ...enumGuards(name, expected, enums.get(expected.enumName)!.length, value.span));
        values.push(Object.freeze({ kind: "IdentifierExpression", name, span: value.span }));
      });
      statements.push(Object.freeze({ ...statement, values: Object.freeze(values) })); continue;
    }
    if (statement.kind === "RequireStatement") { statements.push(Object.freeze({ ...statement, condition: expression(statement.condition) })); continue; }
    if (statement.kind === "RevertStatement" && statement.arguments !== undefined) {
      const parameters = statement.errorName === undefined ? undefined : context.errors.get(statement.errorName);
      statement.arguments.forEach((argument, index) => requireEnum(enumBinding(parameters?.[index], enums), argument, types, enums, context));
      statements.push(Object.freeze({ ...statement, arguments: Object.freeze(statement.arguments.map(expression)) })); continue;
    }
    if (statement.kind === "EmitStatement") {
      const parameters = context.events.get(statement.eventName); statement.arguments.forEach((argument, index) => requireEnum(enumBinding(parameters?.[index], enums), argument, types, enums, context));
      statements.push(Object.freeze({ ...statement, arguments: Object.freeze(statement.arguments.map(expression)) })); continue;
    }
    if (statement.kind === "ExpressionStatement") { statements.push(Object.freeze({ ...statement, expression: expression(statement.expression) })); continue; }
    statements.push(statement);
  }
  return Object.freeze({ ...block, statements: Object.freeze(statements) });
}

export function lowerCompileTimeExtensions(program: TinySolProgram): TinySolProgram {
  program = lowerBoundedCollections(lowerStructMappingFields(program));
  for (const state of program.contract.stateVariables) if (state.type.kind === "MappingType" && state.type.keyType.arrayLength !== undefined) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(state.type.span), details: { feature: "array-mapping-key" } });
  const structs = new Set(program.contract.structs.map((item) => item.name));
  const enums = new Map<string, readonly string[]>();
  for (const declaration of program.contract.enums) {
    if (enums.has(declaration.name) || declaration.members.length === 0) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...at(declaration.span), details: { name: declaration.name, scope: "enum" } });
    const members = declaration.members.map((item) => item.name);
    if (new Set(members).size !== members.length) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...at(declaration.span), details: { name: declaration.name, scope: "enum-members" } });
    enums.set(declaration.name, Object.freeze(members));
  }
  const callables = [...program.contract.functions, ...(program.contract.constructor?.kind === "ConstructorDeclaration" ? [program.contract.constructor] : [])];
  const aggregates = new Set([...structs, ...enums.keys()]);
  const unsupportedAggregate = (type: { readonly arrayLength?: number; readonly userType?: string }) => type.arrayLength !== undefined && type.userType !== undefined && !aggregates.has(type.userType);
  for (const callable of callables) {
    if (callable.parameters.some((parameter) => unsupportedAggregate(parameter.type)) || ("returns" in callable && callable.returns.some(unsupportedAggregate))) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(callable.span), details: { feature: "aggregate-array-abi" } });
    rejectAggregateLocalArrays(callable.body, aggregates);
  }
  for (const item of program.interfaces) {
    if (item.constructor?.kind === "InterfaceConstructor" && item.constructor.parameters.some(unsupportedAggregate)) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(item.constructor.span), details: { feature: "aggregate-array-abi" } });
    if (item.functions.some((fn) => fn.parameters.some(unsupportedAggregate) || fn.returns.some(unsupportedAggregate))) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(item.span), details: { feature: "aggregate-array-abi" } });
  }
  if (program.contract.events.some((event) => event.parameters.some((parameter) => unsupportedAggregate(parameter.type))) || program.contract.errors.some((error) => error.parameters.some((parameter) => unsupportedAggregate(parameter.type)))) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(program.contract.span), details: { feature: "aggregate-array-abi" } });
  const declarations = new Map<string, TinySolProgram["contract"]["constants"][number]>();
  for (const declaration of program.contract.constants) {
    if (declarations.has(declaration.name) || program.contract.stateVariables.some((item) => item.name === declaration.name) || program.contract.functions.some((item) => item.name === declaration.name) || program.contract.events.some((item) => item.name === declaration.name) || program.contract.errors.some((item) => item.name === declaration.name) || program.contract.enums.some((item) => item.name === declaration.name) || program.contract.structs.some((item) => item.name === declaration.name)) {
      fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...at(declaration.span), details: { name: declaration.name, scope: "contract" } });
    }
    declarations.set(declaration.name, declaration);
  }
  const constants = new Map<string, ConstantValue>(); const visiting = new Set<string>();
  const resolve = (name: string, span: SourceSpan): ConstantValue => {
    const existing = constants.get(name); if (existing !== undefined) return existing;
    const declaration = declarations.get(name); if (declaration === undefined) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...at(span), details: { name } });
    if (visiting.has(name)) fail(ToolchainErrorCode.CONSTANT_CYCLE, { ...at(declaration.span), details: { name } });
    visiting.add(name); const value = evaluate(declaration.value, resolve); const actualType = constantType(declaration.value, resolve); visiting.delete(name);
    const type = declaration.type.name;
    const actualInteger = tinySolIntegerInfo(actualType); const expectedInteger = tinySolIntegerInfo(type);
    const literalExpression = declaration.value.kind === "LiteralExpression" && declaration.value.literalKind === "integer"
      || declaration.value.kind === "UnaryExpression" && declaration.value.operator === "-" && declaration.value.operand.kind === "LiteralExpression" && declaration.value.operand.literalKind === "integer";
    const integerCompatible = actualInteger !== undefined && expectedInteger !== undefined && (literalExpression || actualInteger.signed === expectedInteger.signed && actualInteger.width <= expectedInteger.width);
    if (actualType !== type && !integerCompatible && !(type === "account" && actualType === "bytes32")) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(declaration.span), details: { actual: actualType, expected: type } });
    if (type === "bool" && value !== 0n && value !== 1n) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(declaration.span), details: { actual: "uint256", expected: "bool" } });
    if (expectedInteger !== undefined) { const bounds = tinySolIntegerBounds(type as TinySolIntegerType); if (value < bounds.minimum || value > bounds.maximum) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { ...at(declaration.span), details: { width: expectedInteger.width / 8 } }); }
    if (type === "address" && (value < 0n || value >= 1n << 160n)) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { ...at(declaration.span), details: { width: 20 } });
    if ((type === "bytes32" || type === "account") && (value < 0n || value >= UINT256_MODULUS)) fail(ToolchainErrorCode.LITERAL_OVERFLOW, { ...at(declaration.span), details: { width: 32 } });
    const result = Object.freeze({ type, value, span: declaration.span }); constants.set(name, result); return result;
  };
  for (const name of declarations.keys()) resolve(name, declarations.get(name)!.span);
  const contract = program.contract;
  const enumContext: EnumLoweringContext = {
    structs: new Map(contract.structs.map((item) => [item.name, item])),
    functions: new Map(contract.functions.map((fn) => [fn.name, Object.freeze({ parameters: Object.freeze(fn.parameters.map((parameter) => parameter.type)), returns: fn.returns })])),
    interfaces: new Map(program.interfaces.map((item) => [item.name, new Map(item.functions.map((fn) => [fn.name, Object.freeze({ parameters: fn.parameters, returns: fn.returns })]))])),
    constructors: new Map(program.interfaces.flatMap((item) => item.constructor?.kind === "InterfaceConstructor" ? [[item.name, item.constructor.parameters] as const] : [])),
    events: new Map(contract.events.map((event) => [event.name, event.parameters.map((parameter) => parameter.type)])),
    errors: new Map(contract.errors.map((error) => [error.name, error.parameters.map((parameter) => parameter.type)])),
    temporary: 0
  };
  const stateTypes = new Map<string, NominalBinding>(contract.stateVariables.flatMap((state) => {
    if (state.type.kind === "ScalarType") { const binding = nominalBinding(state.type); return binding === undefined ? [] : [[state.name, binding] as const]; }
    const binding = nominalBinding(state.type.valueType); return binding === undefined ? [] : [[state.name, Object.freeze({ ...binding, indexed: true })] as const];
  }));
  const lowerParameters = (parameters: readonly { readonly kind: "Parameter"; readonly name: string; readonly type: { readonly kind: "ScalarType"; readonly name: TinySolScalarType; readonly userType?: string; readonly arrayLength?: number; readonly arrayDimensions?: readonly number[]; readonly span: SourceSpan }; readonly span: SourceSpan }[]) => Object.freeze(parameters.map((parameter) => Object.freeze({ ...parameter, type: loweredType(parameter.type, enums) })));
  const lowerFunction = (fn: TinySolProgram["contract"]["functions"][number]) => {
    const types = new Map(stateTypes); fn.parameters.forEach((parameter) => { const binding = nominalBinding(parameter.type); if (binding !== undefined) types.set(parameter.name, binding); });
    const mapped = mapBlock(fn.body, constants); const body = lowerEnumBlock(mapped, enums, types, fn.returns, enumContext);
    const guards = fn.visibility === "external" ? fn.parameters.flatMap((parameter) => { const binding = enumBinding(parameter.type, enums); return binding === undefined ? [] : enumGuards(parameter.name, binding, enums.get(binding.enumName)!.length, parameter.span); }) : [];
    return Object.freeze({ ...fn, parameters: lowerParameters(fn.parameters), returns: Object.freeze(fn.returns.map((item) => loweredType(item, enums))), body: Object.freeze({ ...body, statements: Object.freeze([...guards, ...body.statements]) }) });
  };
  const loweredContract = Object.freeze({
    ...contract,
    constants: Object.freeze([]),
    enums: Object.freeze([]),
    stateVariables: Object.freeze(contract.stateVariables.map((state) => Object.freeze({ ...state, type: state.type.kind === "ScalarType" ? loweredType(state.type, enums) : Object.freeze({ ...state.type, keyType: loweredType(state.type.keyType, enums), valueType: loweredType(state.type.valueType, enums) }) }))),
    events: Object.freeze(contract.events.map((event) => Object.freeze({ ...event, parameters: Object.freeze(event.parameters.map((parameter) => Object.freeze({ ...parameter, type: loweredType(parameter.type, enums) }))) }))),
    errors: Object.freeze(contract.errors.map((error) => Object.freeze({ ...error, parameters: Object.freeze(error.parameters.map((parameter) => Object.freeze({ ...parameter, type: loweredType(parameter.type, enums) }))) }))),
    ...(contract.constructor?.kind !== "ConstructorDeclaration" ? {} : { constructor: (() => {
      const declaration = contract.constructor; const types = new Map(stateTypes); declaration.parameters.forEach((parameter) => { const binding = nominalBinding(parameter.type); if (binding !== undefined) types.set(parameter.name, binding); });
      const body = lowerEnumBlock(mapBlock(declaration.body, constants), enums, types, [], enumContext); const guards = declaration.parameters.flatMap((parameter) => { const binding = enumBinding(parameter.type, enums); return binding === undefined ? [] : enumGuards(parameter.name, binding, enums.get(binding.enumName)!.length, parameter.span); });
      return Object.freeze({ ...declaration, parameters: lowerParameters(declaration.parameters), body: Object.freeze({ ...body, statements: Object.freeze([...guards, ...body.statements]) }) });
    })() }),
    functions: Object.freeze(contract.functions.map(lowerFunction))
  });
  const interfaces = Object.freeze(program.interfaces.map((item) => Object.freeze({ ...item, ...(item.constructor?.kind !== "InterfaceConstructor" ? {} : { constructor: Object.freeze({ ...item.constructor, parameters: Object.freeze(item.constructor.parameters.map((type) => loweredType(type, enums))) }) }), functions: Object.freeze(item.functions.map((fn) => Object.freeze({ ...fn, parameters: Object.freeze(fn.parameters.map((type) => loweredType(type, enums))), returns: Object.freeze(fn.returns.map((type) => loweredType(type, enums))) }))) })));
  return lowerFixedArrays(lowerStructs(Object.freeze({ ...program, interfaces, contract: loweredContract }), enums));
}
