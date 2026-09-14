import { ToolchainErrorCode, fail } from "./errors.js";
import { TINYSOL_LIMITS } from "./compiler-types.js";
import type {
  SourceSpan,
  TinySolBlock,
  TinySolExpression,
  TinySolIdentifierExpression,
  TinySolMappingTypeNode,
  TinySolParameter,
  TinySolProgram,
  TinySolScalarTypeNode,
  TinySolStatement,
  TinySolStructDeclaration
} from "./compiler-types.js";

interface FlatField { readonly path: string; readonly type: TinySolScalarTypeNode; readonly enumMaximum?: number }
interface Binding { readonly structName: string; readonly mode: "local" | "localArray" | "storage" | "mapping" | "array"; readonly indexType?: TinySolScalarTypeNode; readonly length?: number; readonly dimensions?: readonly number[] }
interface CallableShape { readonly parameters: readonly TinySolScalarTypeNode[]; readonly returns: readonly TinySolScalarTypeNode[] }
interface StructReference { readonly root: string; readonly prefix: string; readonly binding: Binding; readonly structName: string; readonly indices: readonly TinySolExpression[]; readonly key?: TinySolExpression }
interface PartialStructArrayReference { readonly reference: StructReference; readonly dimensions: readonly number[] }
interface IndexedAccess { readonly path: string; readonly index: TinySolExpression }
interface StructAccess { readonly root: string; readonly path: string; readonly rootIndices: readonly TinySolExpression[]; readonly memberIndices: readonly IndexedAccess[] }
type StructTable = ReadonlyMap<string, TinySolStructDeclaration>;
type EnumTable = ReadonlyMap<string, readonly string[]>;
interface LoweringContext {
  readonly structs: StructTable;
  readonly enums: EnumTable;
  readonly functions: ReadonlyMap<string, CallableShape>;
  readonly interfaces: ReadonlyMap<string, ReadonlyMap<string, CallableShape>>;
  readonly constructors: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly events: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly errors: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  temporary: number;
}

function at(span: SourceSpan) { return { line: span.start.line, column: span.start.column, offset: span.start.byteOffset }; }
function dimensions(type: TinySolScalarTypeNode): readonly number[] { return type.arrayDimensions ?? (type.arrayLength === undefined ? Object.freeze([]) : Object.freeze([type.arrayLength])); }
function dimensionProduct(items: readonly number[], span?: SourceSpan): number {
  let product = 1;
  for (const item of items) {
    if (!Number.isSafeInteger(item) || item <= 0 || product > Math.floor(TINYSOL_LIMITS.flattenedArrayWords / item)) {
      fail(ToolchainErrorCode.RESOURCE_LIMIT, {
        ...(span === undefined ? {} : at(span)),
        details: { resource: "flattened-array-words", maximum: TINYSOL_LIMITS.flattenedArrayWords }
      });
    }
    product *= item;
  }
  return product;
}
function dimensioned(type: TinySolScalarTypeNode, items: readonly number[]): TinySolScalarTypeNode {
  const base = { kind: "ScalarType" as const, name: type.name, span: type.span };
  if (items.length === 0) return Object.freeze(base);
  if (items.length === 1) return Object.freeze({ ...base, arrayLength: items[0]! });
  return Object.freeze({ ...base, arrayLength: dimensionProduct(items, type.span), arrayDimensions: Object.freeze([...items]) });
}
function sameDimensions(left: readonly number[], right: readonly number[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function typeLabel(name: string, items: readonly number[]): string { return `${name}${items.map((item) => `[${item}]`).join("")}`; }
function scalar(type: TinySolScalarTypeNode): TinySolScalarTypeNode { return dimensioned(type, dimensions(type)); }
function uint256(span: SourceSpan): TinySolScalarTypeNode { return Object.freeze({ kind: "ScalarType", name: "uint256", span }); }
function fieldName(root: string, path: string, mode: Binding["mode"]): string { return mode === "local" || mode === "localArray" ? `${root}$${path}` : `${root}.${path}`; }
function identifier(name: string, span: SourceSpan): TinySolIdentifierExpression { return Object.freeze({ kind: "IdentifierExpression", name, span }); }
function nestedStorage(name: string, key: TinySolExpression, indices: readonly TinySolExpression[], items: readonly number[], field: FlatField, span: SourceSpan): TinySolExpression {
  return Object.freeze({ kind: "NestedStorageIndexExpression", object: identifier(name, span), key, indices: Object.freeze([...indices]), dimensions: Object.freeze([...items]), elementType: field.type.name, span });
}
function nestedArray(name: string, indices: readonly TinySolExpression[], items: readonly number[], field: FlatField, span: SourceSpan): TinySolExpression {
  return Object.freeze({ kind: "NestedArrayIndexExpression", object: identifier(name, span), indices: Object.freeze([...indices]), dimensions: Object.freeze([...items]), elementType: field.type.name, span });
}
function integer(index: number, span: SourceSpan): TinySolExpression {
  return Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span });
}

function flattenFields(name: string, structs: StructTable, enums: EnumTable, visiting: readonly string[] = []): readonly FlatField[] {
  if (visiting.includes(name)) fail(ToolchainErrorCode.STRUCT_CYCLE, { details: { cycle: [...visiting, name].join(" -> ") } });
  const declaration = structs.get(name); if (declaration === undefined) fail(ToolchainErrorCode.UNKNOWN_TYPE, { details: { name } });
  const output: FlatField[] = [];
  for (const field of declaration.fields) {
    const userType = field.type.userType;
    if (userType === undefined) output.push({ path: field.name, type: scalar(field.type) });
    else if (enums.has(userType)) output.push({ path: field.name, type: dimensioned(uint256(field.type.span), dimensions(field.type)), enumMaximum: enums.get(userType)!.length });
    else if (structs.has(userType)) for (const nested of flattenFields(userType, structs, enums, [...visiting, name])) {
      output.push({ ...nested, path: `${field.name}.${nested.path}`, type: field.type.arrayLength === undefined ? nested.type : dimensioned(nested.type, [...dimensions(field.type), ...dimensions(nested.type)]) });
    }
    else fail(ToolchainErrorCode.UNKNOWN_TYPE, { ...at(field.type.span), details: { name: userType } });
  }
  return Object.freeze(output);
}

function validateDeclarations(program: TinySolProgram, enums: EnumTable): StructTable {
  const structs = new Map<string, TinySolStructDeclaration>();
  for (const declaration of program.contract.structs) {
    if (structs.has(declaration.name) || enums.has(declaration.name)) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { ...at(declaration.span), details: { name: declaration.name, scope: "type" } });
    const names = declaration.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) fail(ToolchainErrorCode.DUPLICATE_FIELD, { ...at(declaration.span), details: { struct: declaration.name } });
    structs.set(declaration.name, declaration);
  }
  for (const name of structs.keys()) flattenFields(name, structs, enums);
  return structs;
}

function access(expression: TinySolExpression): StructAccess | undefined {
  const parts: string[] = []; const rootIndices: TinySolExpression[] = []; const memberIndices: IndexedAccess[] = []; let root: string | undefined;
  const visit = (item: TinySolExpression): boolean => {
    if (item.kind === "IdentifierExpression") { if (root !== undefined) return false; root = item.name; return true; }
    if (item.kind === "MemberExpression") { if (!visit(item.object)) return false; parts.push(item.member); return true; }
    if (item.kind === "IndexExpression") {
      if (!visit(item.object)) return false;
      if (parts.length === 0) rootIndices.push(item.index);
      else memberIndices.push(Object.freeze({ path: parts.join("."), index: item.index }));
      return true;
    }
    return false;
  };
  if (!visit(expression) || root === undefined) return undefined;
  return { root, path: parts.join("."), rootIndices: Object.freeze(rootIndices), memberIndices: Object.freeze(memberIndices) };
}

function indexedPathCounts(items: readonly IndexedAccess[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.path, (counts.get(item.path) ?? 0) + 1);
  return counts;
}

function nestedStruct(name: string, path: string, structs: StructTable, indexedPaths: ReadonlyMap<string, number> = new Map()): string | undefined {
  let current = name; let currentPath = "";
  if (path.length === 0) return current;
  for (const part of path.split(".")) {
    currentPath = currentPath.length === 0 ? part : `${currentPath}.${part}`;
    const field = structs.get(current)?.fields.find((candidate) => candidate.name === part);
    if (field?.type.userType === undefined || !structs.has(field.type.userType)) return undefined;
    if ((indexedPaths.get(currentPath) ?? 0) !== dimensions(field.type).length) return undefined;
    current = field.type.userType;
  }
  return current;
}

function structReference(expression: TinySolExpression, bindings: ReadonlyMap<string, Binding>, context: LoweringContext): StructReference | undefined {
  if (expression.kind === "IdentifierExpression") {
    const binding = bindings.get(expression.name); return binding === undefined || binding.mode === "mapping" || binding.mode === "array" || binding.mode === "localArray" ? undefined : { root: expression.name, prefix: "", binding, structName: binding.structName, indices: Object.freeze([]) };
  }
  if (expression.kind === "MemberExpression" || expression.kind === "IndexExpression") {
    const item = access(expression); const binding = item === undefined ? undefined : bindings.get(item.root);
    if (item === undefined || binding === undefined) return undefined;
    const structName = nestedStruct(binding.structName, item.path, context.structs, indexedPathCounts(item.memberIndices));
    if (structName === undefined) return undefined;
    const indices: TinySolExpression[] = [];
    const rootDimensions = binding.dimensions ?? Object.freeze([]);
    let key: TinySolExpression | undefined;
    if (binding.mode === "mapping") {
      if (item.rootIndices.length !== rootDimensions.length + 1) return undefined;
      key = item.rootIndices[0]; indices.push(...item.rootIndices.slice(1));
    }
    else if (binding.mode === "array" || binding.mode === "localArray") { if (item.rootIndices.length !== rootDimensions.length) return undefined; indices.push(...item.rootIndices); }
    else if (item.rootIndices.length !== 0) return undefined;
    indices.push(...item.memberIndices.map((indexed) => indexed.index));
    return { root: item.root, prefix: item.path, binding, structName, indices: Object.freeze(indices), ...(key === undefined ? {} : { key }) };
  }
  return undefined;
}

function partialStructArrayReference(expression: TinySolExpression, bindings: ReadonlyMap<string, Binding>): PartialStructArrayReference | undefined {
  if (expression.kind !== "IndexExpression") return undefined;
  const item = access(expression); const binding = item === undefined ? undefined : bindings.get(item.root);
  if (item === undefined || binding?.dimensions === undefined || item.path.length !== 0 || item.memberIndices.length !== 0) return undefined;
  if (binding.mode === "array" || binding.mode === "localArray") {
    if (item.rootIndices.length === 0 || item.rootIndices.length >= binding.dimensions.length) return undefined;
    return Object.freeze({ reference: Object.freeze({ root: item.root, prefix: "", binding, structName: binding.structName, indices: item.rootIndices }), dimensions: Object.freeze(binding.dimensions.slice(item.rootIndices.length)) });
  }
  if (binding.mode === "mapping") {
    const consumed = item.rootIndices.length - 1;
    if (consumed <= 0 || consumed >= binding.dimensions.length) return undefined;
    return Object.freeze({ reference: Object.freeze({ root: item.root, prefix: "", binding, structName: binding.structName, key: item.rootIndices[0]!, indices: Object.freeze(item.rootIndices.slice(1)) }), dimensions: Object.freeze(binding.dimensions.slice(consumed)) });
  }
  return undefined;
}

function structArrayType(structName: string, items: readonly number[], span: SourceSpan): TinySolScalarTypeNode {
  return Object.freeze({ kind: "ScalarType", name: "uint256", userType: structName, arrayLength: dimensionProduct(items, span), ...(items.length < 2 ? {} : { arrayDimensions: Object.freeze([...items]) }), span });
}

function fieldDimensions(field: FlatField, binding: Binding): readonly number[] {
  return binding.dimensions === undefined ? dimensions(field.type) : Object.freeze([...binding.dimensions, ...dimensions(field.type)]);
}

function coordinateSuffixes(items: readonly number[], span: SourceSpan): readonly (readonly TinySolExpression[])[] {
  let output: readonly (readonly TinySolExpression[])[] = Object.freeze([Object.freeze([])]);
  for (const length of items) output = Object.freeze(output.flatMap((prefix) => Array.from({ length }, (_, index) => Object.freeze([...prefix, integer(index, span)]))));
  return output;
}

function scalarFieldAccess(name: string, binding: Binding, key: TinySolExpression | undefined, indices: readonly TinySolExpression[], items: readonly number[], field: FlatField, span: SourceSpan): TinySolExpression {
  if (indices.length !== items.length) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(span), details: { operation: "struct-array-rank" } });
  if (binding.mode === "mapping") {
    if (key === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(span), details: { operation: "mapping-key" } });
    if (items.length === 0) return Object.freeze({ kind: "IndexExpression", object: identifier(name, span), index: key, span });
    return nestedStorage(name, key, indices, items, field, span);
  }
  if (items.length === 0) return identifier(name, span);
  if (items.length === 1) return Object.freeze({ kind: "IndexExpression", object: identifier(name, span), index: indices[0]!, span });
  return nestedArray(name, indices, items, field, span);
}

function fieldAccess(name: string, binding: Binding, key: TinySolExpression | undefined, indices: readonly TinySolExpression[], items: readonly number[], field: FlatField, span: SourceSpan): TinySolExpression {
  if (indices.length > items.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(span), details: { actual: "scalar", expected: "array" } });
  if (indices.length === items.length) return scalarFieldAccess(name, binding, key, indices, items, field, span);
  const elements = coordinateSuffixes(items.slice(indices.length), span).map((suffix) => scalarFieldAccess(name, binding, key, [...indices, ...suffix], items, field, span));
  return Object.freeze({ kind: "ArrayLiteralExpression", elements: Object.freeze(elements), span });
}

function zero(span: SourceSpan, type?: TinySolScalarTypeNode): TinySolExpression {
  if (type?.name === "bool") return Object.freeze({ kind: "LiteralExpression", literalKind: "bool", value: "false", span });
  if (type?.name === "address") return Object.freeze({ kind: "LiteralExpression", literalKind: "address", value: `0x${"0".repeat(40)}`, span });
  if (type?.name === "bytes32") return Object.freeze({ kind: "LiteralExpression", literalKind: "bytes32", value: `0x${"0".repeat(64)}`, span });
  if (type?.name === "account") return Object.freeze({ kind: "LiteralExpression", literalKind: "account", value: `0x${"0".repeat(64)}`, span });
  return Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: "0", span });
}

function callableShape(expression: TinySolExpression, context: LoweringContext): CallableShape | undefined {
  if (expression.kind === "FunctionCallExpression") return context.functions.get(expression.functionName);
  if (expression.kind === "ExternalCallExpression") return context.interfaces.get(expression.interfaceName)?.get(expression.functionName);
  return undefined;
}

function mapArguments(arguments_: readonly TinySolExpression[], parameters: readonly TinySolScalarTypeNode[] | undefined, bindings: ReadonlyMap<string, Binding>, context: LoweringContext): readonly TinySolExpression[] {
  return Object.freeze(arguments_.flatMap((argument, index) => {
    const expected = parameters?.[index];
    if (expected?.userType !== undefined && context.structs.has(expected.userType)) return expected.arrayLength === undefined ? flattenValue(argument, expected.userType, bindings, context) : aggregateArrayValue(argument, expected, bindings, context);
    return [mapExpression(argument, bindings, context)];
  }));
}

function mapExpression(expression: TinySolExpression, bindings: ReadonlyMap<string, Binding>, context: LoweringContext): TinySolExpression {
  if (expression.kind === "IdentifierExpression") {
    if (bindings.has(expression.name)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: bindings.get(expression.name)!.structName, expected: "scalar" } });
    return expression;
  }
  if (expression.kind === "MemberExpression" || expression.kind === "IndexExpression") {
    const item = access(expression); const binding = item === undefined ? undefined : bindings.get(item.root);
    if (item === undefined || binding === undefined) {
      if (expression.kind === "MemberExpression" || item?.path !== "") fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...at(expression.span), details: { name: item?.root ?? (expression.kind === "MemberExpression" ? expression.member : "aggregate") } });
    } else {
    const field = flattenFields(binding.structName, context.structs, context.enums).find((candidate) => candidate.path === item.path);
    if (field === undefined) {
      const aggregate = nestedStruct(binding.structName, item.path, context.structs, indexedPathCounts(item.memberIndices));
      if (aggregate !== undefined) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: aggregate, expected: "scalar" } });
      fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { ...at(expression.span), details: { name: `${binding.structName}.${item.path}` } });
    }
    const name = fieldName(item.root, item.path, binding.mode);
    const indices: TinySolExpression[] = [];
    let key: TinySolExpression | undefined;
    const rootDimensions = binding.dimensions ?? Object.freeze([]);
    if (binding.mode === "mapping") {
      if (item.rootIndices.length === 0) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(expression.span), details: { operation: "mapping-key" } });
      if (item.rootIndices.length !== rootDimensions.length + 1) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: "partial-struct-array", expected: typeLabel(binding.structName, rootDimensions) } });
      key = mapExpression(item.rootIndices[0]!, bindings, context); indices.push(...item.rootIndices.slice(1).map((index) => mapExpression(index, bindings, context)));
    }
    else if (binding.mode === "array" || binding.mode === "localArray") {
      if (item.rootIndices.length !== rootDimensions.length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: typeLabel(binding.structName, rootDimensions.slice(item.rootIndices.length)), expected: "scalar" } });
      indices.push(...item.rootIndices.map((index) => mapExpression(index, bindings, context)));
    }
    else if (item.rootIndices.length !== 0) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(expression.span), details: { operation: "index-non-array" } });
    indices.push(...item.memberIndices.map((indexed) => mapExpression(indexed.index, bindings, context)));
    return fieldAccess(name, binding, key, indices, fieldDimensions(field, binding), field, expression.span);
    }
  }
  if (expression.kind === "StructLiteralExpression") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: expression.structName, expected: "scalar" } });
  if (expression.kind === "ArrayLiteralExpression") return Object.freeze({ ...expression, elements: Object.freeze(expression.elements.map((item) => mapExpression(item, bindings, context))) });
  if (expression.kind === "IndexExpression") {
    if (expression.object.kind === "IdentifierExpression" && bindings.has(expression.object.name)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: bindings.get(expression.object.name)!.structName, expected: "scalar" } });
    return Object.freeze({ ...expression, object: mapExpression(expression.object, bindings, context) as typeof expression.object, index: mapExpression(expression.index, bindings, context) });
  }
  if (expression.kind === "LocalArrayIndexExpression") return Object.freeze({ ...expression, index: mapExpression(expression.index, bindings, context) });
  if (expression.kind === "NestedArrayIndexExpression" || expression.kind === "LocalNestedArrayIndexExpression") return Object.freeze({ ...expression, indices: Object.freeze(expression.indices.map((index) => mapExpression(index, bindings, context))) });
  if (expression.kind === "NestedStorageIndexExpression") return Object.freeze({ ...expression, key: mapExpression(expression.key, bindings, context), indices: Object.freeze(expression.indices.map((index) => mapExpression(index, bindings, context))) });
  if (expression.kind === "UnaryExpression") return Object.freeze({ ...expression, operand: mapExpression(expression.operand, bindings, context) });
  if (expression.kind === "CastExpression") return Object.freeze({ ...expression, value: mapExpression(expression.value, bindings, context) });
  if (expression.kind === "BinaryExpression") return Object.freeze({ ...expression, left: mapExpression(expression.left, bindings, context), right: mapExpression(expression.right, bindings, context) });
  if (expression.kind === "ConditionalExpression") return Object.freeze({ ...expression, condition: mapExpression(expression.condition, bindings, context), consequent: mapExpression(expression.consequent, bindings, context), alternate: mapExpression(expression.alternate, bindings, context) });
  if (expression.kind === "FunctionCallExpression") return Object.freeze({ ...expression, arguments: mapArguments(expression.arguments, context.functions.get(expression.functionName)?.parameters, bindings, context) });
  if (expression.kind === "ExternalCallExpression") {
    const shape = context.interfaces.get(expression.interfaceName)?.get(expression.functionName);
    return Object.freeze({ ...expression, target: mapExpression(expression.target, bindings, context), arguments: mapArguments(expression.arguments, shape?.parameters, bindings, context) });
  }
  if (expression.kind === "CreateExpression") return Object.freeze({ ...expression, codeHash: mapExpression(expression.codeHash, bindings, context), arguments: mapArguments(expression.arguments, context.constructors.get(expression.interfaceName), bindings, context) });
  return expression;
}

function flattenLiteral(expression: Extract<TinySolExpression, { readonly kind: "StructLiteralExpression" }>, expected: string, bindings: ReadonlyMap<string, Binding>, context: LoweringContext, prelude?: TinySolStatement[]): readonly TinySolExpression[] {
  if (expression.structName !== expected) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: expression.structName, expected } });
  const declaration = context.structs.get(expected)!; const provided = new Map(expression.fields.map((field) => [field.name, field]));
  if (provided.size !== expression.fields.length) fail(ToolchainErrorCode.DUPLICATE_FIELD, { ...at(expression.span), details: { struct: expected } });
  const expectedNames = declaration.fields.map((field) => field.name);
  if (provided.size !== expectedNames.length || expectedNames.some((name) => !provided.has(name))) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: provided.size, expected: expectedNames.length } });
  const output: TinySolExpression[] = [];
  for (const field of declaration.fields) {
    const value = provided.get(field.name)!.value; const userType = field.type.userType;
    if (userType !== undefined && context.structs.has(userType)) {
      if (field.type.arrayLength === undefined) output.push(...flattenValue(value, userType, bindings, context, prelude));
      else output.push(...aggregateArrayValue(value, field.type, bindings, context, prelude));
    }
    else {
      const mapped = mapExpression(value, bindings, context);
      const literals = mapped.kind === "ArrayLiteralExpression" ? mapped.elements : [mapped];
      if (userType !== undefined && context.enums.has(userType)) for (const item of literals) if (item.kind === "LiteralExpression" && item.literalKind === "integer" && BigInt(item.value) >= BigInt(context.enums.get(userType)!.length)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(item.span), details: { actual: item.value, expected: userType } });
      output.push(mapped);
    }
  }
  return Object.freeze(output);
}

function stabilized(reference: StructReference, bindings: ReadonlyMap<string, Binding>, context: LoweringContext, prelude: TinySolStatement[] | undefined, span: SourceSpan): StructReference {
  if (prelude === undefined) return reference;
  let result = reference;
  if (reference.key !== undefined) {
    const name = `$structKey${context.temporary++}`; const type = reference.binding.indexType ?? uint256(span);
    prelude.push(Object.freeze({ kind: "VariableDeclaration", name, type, initializer: mapExpression(reference.key, bindings, context), span })); result = Object.freeze({ ...result, key: identifier(name, span) });
  }
  const indices = reference.indices.map((index) => {
    const name = `$structIndex${context.temporary++}`;
    prelude.push(Object.freeze({ kind: "VariableDeclaration", name, type: uint256(span), initializer: mapExpression(index, bindings, context), span })); return identifier(name, span);
  });
  result = Object.freeze({ ...result, indices: Object.freeze(indices) });
  return result;
}

function flattenReference(reference: StructReference, span: SourceSpan, context: LoweringContext): readonly TinySolExpression[] {
  return Object.freeze(flattenFields(reference.structName, context.structs, context.enums).map((field) => {
    const path = reference.prefix.length === 0 ? field.path : `${reference.prefix}.${field.path}`;
    const rootField = flattenFields(reference.binding.structName, context.structs, context.enums).find((candidate) => candidate.path === path)!;
    return fieldAccess(fieldName(reference.root, path, reference.binding.mode), reference.binding, reference.key, reference.indices, fieldDimensions(rootField, reference.binding), rootField, span);
  }));
}

function flattenReferenceValue(reference: StructReference, span: SourceSpan, context: LoweringContext): readonly TinySolExpression[] {
  return flattenReference(reference, span, context);
}

function flattenValue(expression: TinySolExpression, expected: string, bindings: ReadonlyMap<string, Binding>, context: LoweringContext, prelude?: TinySolStatement[]): readonly TinySolExpression[] {
  if (expression.kind === "StructLiteralExpression") return flattenLiteral(expression, expected, bindings, context, prelude);
  const raw = structReference(expression, bindings, context);
  if (raw === undefined || raw.structName !== expected) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: raw?.structName ?? "scalar", expected } });
  return flattenReferenceValue(stabilized(raw, bindings, context, prelude, expression.span), expression.span, context);
}

function aggregateLength(field: FlatField, length: number): number { return length * (field.type.arrayLength ?? 1); }

function aggregateFieldType(field: FlatField, aggregateDimensions: readonly number[]): TinySolScalarTypeNode {
  return dimensioned(field.type, [...aggregateDimensions, ...dimensions(field.type)]);
}

function aggregateArrayCall(expression: TinySolExpression, expected: TinySolScalarTypeNode, context: LoweringContext): boolean {
  const shape = callableShape(expression, context);
  return (expression.kind === "FunctionCallExpression" || expression.kind === "ExternalCallExpression")
    && shape?.returns.length === 1 && shape.returns[0]?.userType === expected.userType && sameDimensions(dimensions(shape.returns[0]!), dimensions(expected));
}

function aggregateArrayValue(expression: TinySolExpression, expected: TinySolScalarTypeNode, bindings: ReadonlyMap<string, Binding>, context: LoweringContext, prelude?: TinySolStatement[]): readonly TinySolExpression[] {
  const structName = expected.userType!; const expectedDimensions = dimensions(expected); const length = expected.arrayLength!; const fields = flattenFields(structName, context.structs, context.enums);
  if (expression.kind === "ArrayLiteralExpression") {
    const leaves: TinySolExpression[] = [];
    const collect = (value: TinySolExpression, depth: number): void => {
      if (depth === expectedDimensions.length) {
        if (value.kind === "ArrayLiteralExpression") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: "array", expected: structName } });
        leaves.push(value); return;
      }
      if (value.kind !== "ArrayLiteralExpression") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: structName, expected: typeLabel(structName, expectedDimensions.slice(depth)) } });
      const expectedLength = expectedDimensions[depth]!;
      if (value.elements.length !== expectedLength) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: value.elements.length, expected: expectedLength } });
      value.elements.forEach((element) => collect(element, depth + 1));
    };
    collect(expression, 0);
    if (leaves.length !== length) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: leaves.length, expected: length } });
    const elements = leaves.map((element) => flattenValue(element, structName, bindings, context, prelude));
    const scalarElements = (value: TinySolExpression, field: FlatField): readonly TinySolExpression[] => {
      if (field.type.arrayLength === undefined) return Object.freeze([value]);
      const output: TinySolExpression[] = [];
      const visit = (item: TinySolExpression): void => {
        if (item.kind !== "ArrayLiteralExpression") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(item.span), details: { actual: "scalar", expected: typeLabel(field.type.name, dimensions(field.type)) } });
        item.elements.forEach((element) => element.kind === "ArrayLiteralExpression" ? visit(element) : output.push(element));
      };
      visit(value);
      if (output.length !== field.type.arrayLength) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: output.length, expected: field.type.arrayLength } });
      return Object.freeze(output);
    };
    return Object.freeze(fields.map((field, fieldIndex) => Object.freeze({
      kind: "ArrayLiteralExpression",
      elements: Object.freeze(elements.flatMap((item) => scalarElements(item[fieldIndex]!, field))),
      span: expression.span
    })));
  }
  if (expression.kind === "IdentifierExpression") {
    const binding = bindings.get(expression.name);
    if (binding?.structName !== structName || binding.length !== length || !sameDimensions(binding.dimensions ?? Object.freeze([]), expectedDimensions) || (binding.mode !== "localArray" && binding.mode !== "array")) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: binding === undefined ? "scalar" : typeLabel(binding.structName, binding.dimensions ?? Object.freeze([])), expected: typeLabel(structName, expectedDimensions) } });
    if (binding.mode === "localArray") return Object.freeze(fields.map((field) => identifier(fieldName(expression.name, field.path, binding.mode), expression.span)));
    return Object.freeze(fields.map((field) => fieldAccess(fieldName(expression.name, field.path, binding.mode), binding, undefined, [], fieldDimensions(field, binding), field, expression.span)));
  }
  const partial = partialStructArrayReference(expression, bindings);
  if (partial !== undefined) {
    if (partial.reference.structName !== structName || !sameDimensions(partial.dimensions, expectedDimensions)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: typeLabel(partial.reference.structName, partial.dimensions), expected: typeLabel(structName, expectedDimensions) } });
    if (prelude === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(expression.span), details: { operation: "unstabilized-struct-subarray-index" } });
    const reference = stabilized(partial.reference, bindings, context, prelude, expression.span);
    return Object.freeze(fields.map((field) => {
      const rootField = flattenFields(reference.binding.structName, context.structs, context.enums).find((candidate) => candidate.path === field.path)!;
      return fieldAccess(fieldName(reference.root, field.path, reference.binding.mode), reference.binding, reference.key, reference.indices, fieldDimensions(rootField, reference.binding), rootField, expression.span);
    }));
  }
  fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: "scalar", expected: typeLabel(structName, expectedDimensions) } });
}

function guardExpression(value: TinySolExpression, maximum: number, span: SourceSpan): TinySolStatement {
  const right = Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(maximum), span }) as TinySolExpression;
  return Object.freeze({ kind: "RequireStatement", condition: Object.freeze({ kind: "BinaryExpression", operator: "<", left: value, right, span }), span });
}

function flatFieldGuards(root: string, field: FlatField, mode: Binding["mode"], span: SourceSpan): readonly TinySolStatement[] {
  if (field.enumMaximum === undefined) return Object.freeze([]);
  const name = fieldName(root, field.path, mode);
  if (field.type.arrayLength === undefined) return Object.freeze([guardExpression(identifier(name, span), field.enumMaximum, span)]);
  return Object.freeze(Array.from({ length: field.type.arrayLength }, (_, index) => guardExpression(Object.freeze({ kind: "IndexExpression", object: identifier(name, span), index: Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span }), span }), field.enumMaximum!, span)));
}

function flatValueGuards(value: TinySolExpression, field: FlatField, span: SourceSpan): readonly TinySolStatement[] {
  if (field.enumMaximum === undefined) return Object.freeze([]);
  if (field.type.arrayLength === undefined) return Object.freeze([guardExpression(value, field.enumMaximum, span)]);
  if (value.kind !== "IdentifierExpression") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(span), details: { actual: "expression", expected: "enum-array" } });
  return Object.freeze(Array.from({ length: field.type.arrayLength }, (_, index) => guardExpression(Object.freeze({ kind: "IndexExpression", object: value, index: Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span }), span }), field.enumMaximum!, span)));
}

function aggregateGuards(root: string, binding: Binding, span: SourceSpan, context: LoweringContext): readonly TinySolStatement[] {
  const length = binding.length!; const guards: TinySolStatement[] = [];
  for (const field of flattenFields(binding.structName, context.structs, context.enums)) {
    if (field.enumMaximum === undefined) continue;
    const fieldLength = aggregateLength(field, length);
    for (let index = 0; index < fieldLength; index += 1) {
      const item = Object.freeze({ kind: "IndexExpression", object: identifier(fieldName(root, field.path, binding.mode), span), index: Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span }), span }) as TinySolExpression;
      guards.push(guardExpression(item, field.enumMaximum, span));
    }
  }
  return Object.freeze(guards);
}

function structCall(expression: TinySolExpression, expected: string, context: LoweringContext): boolean {
  const shape = callableShape(expression, context);
  return (expression.kind === "FunctionCallExpression" || expression.kind === "ExternalCallExpression") && shape?.returns.length === 1 && shape.returns[0]?.userType === expected && shape.returns[0]?.arrayLength === undefined;
}

function captureCall(expression: TinySolExpression, structName: string, root: string, bindings: ReadonlyMap<string, Binding>, context: LoweringContext): { readonly statement: TinySolStatement; readonly binding: Binding; readonly guards: readonly TinySolStatement[] } {
  const value = mapExpression(expression, bindings, context);
  if (value.kind !== "FunctionCallExpression" && value.kind !== "ExternalCallExpression") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...at(expression.span) });
  const binding: Binding = Object.freeze({ structName, mode: "local" }); const fields = flattenFields(structName, context.structs, context.enums);
  const statement: TinySolStatement = Object.freeze({ kind: "TupleAssignment", bindings: Object.freeze(fields.map((field) => Object.freeze({ name: fieldName(root, field.path, "local"), type: field.type, span: expression.span }))), value, span: expression.span });
  const guards = Object.freeze(fields.flatMap((field) => flatFieldGuards(root, field, "local", expression.span)));
  return Object.freeze({ statement, binding, guards });
}

function captureAggregateCall(expression: TinySolExpression, expected: TinySolScalarTypeNode, root: string, bindings: ReadonlyMap<string, Binding>, context: LoweringContext): { readonly statement: TinySolStatement; readonly binding: Binding; readonly guards: readonly TinySolStatement[]; readonly values: readonly TinySolExpression[] } {
  const value = mapExpression(expression, bindings, context);
  if (value.kind !== "FunctionCallExpression" && value.kind !== "ExternalCallExpression") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...at(expression.span) });
  const aggregateDimensions = dimensions(expected); const binding: Binding = Object.freeze({ structName: expected.userType!, mode: "localArray", length: expected.arrayLength!, dimensions: aggregateDimensions, indexType: uint256(expected.span) }); const fields = flattenFields(expected.userType!, context.structs, context.enums);
  const statement: TinySolStatement = Object.freeze({ kind: "TupleAssignment", bindings: Object.freeze(fields.map((field) => Object.freeze({ name: fieldName(root, field.path, binding.mode), type: aggregateFieldType(field, aggregateDimensions), span: expression.span }))), value, span: expression.span });
  const values = Object.freeze(fields.map((field) => identifier(fieldName(root, field.path, binding.mode), expression.span)));
  return Object.freeze({ statement, binding, guards: aggregateGuards(root, binding, expression.span, context), values });
}

function captureAggregateValues(values: readonly TinySolExpression[], expected: TinySolScalarTypeNode, output: TinySolStatement[], context: LoweringContext, span: SourceSpan): { readonly binding: Binding; readonly values: readonly TinySolExpression[] } {
  const root = `$structArrayValue${context.temporary++}`; const aggregateDimensions = dimensions(expected); const binding: Binding = Object.freeze({ structName: expected.userType!, mode: "localArray", length: expected.arrayLength!, dimensions: aggregateDimensions, indexType: uint256(expected.span) }); const fields = flattenFields(expected.userType!, context.structs, context.enums);
  fields.forEach((field, index) => output.push(Object.freeze({ kind: "VariableDeclaration", name: fieldName(root, field.path, binding.mode), type: aggregateFieldType(field, aggregateDimensions), initializer: values[index]!, span })));
  output.push(...aggregateGuards(root, binding, span, context));
  return Object.freeze({ binding, values: Object.freeze(fields.map((field) => identifier(fieldName(root, field.path, binding.mode), span))) });
}

function temporaryValues(values: readonly TinySolExpression[], fields: readonly FlatField[], output: TinySolStatement[], context: LoweringContext, span: SourceSpan): readonly TinySolExpression[] {
  return Object.freeze(values.map((value, index) => {
    const name = `$structValue${context.temporary++}$${index}`; output.push(Object.freeze({ kind: "VariableDeclaration", name, type: fields[index]!.type, initializer: value, span })); return identifier(name, span);
  }));
}

function appendFieldAssignment(output: TinySolStatement[], target: TinySolExpression, value: TinySolExpression, field: FlatField, span: SourceSpan): void {
  if (field.type.arrayLength === undefined) {
    output.push(Object.freeze({ kind: "Assignment", target: target as Extract<TinySolExpression, { readonly kind: "IdentifierExpression" | "IndexExpression" | "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" | "NestedStorageIndexExpression" }>, value, span })); return;
  }
  if ((target.kind !== "IdentifierExpression" && target.kind !== "ArrayLiteralExpression") || value.kind !== "IdentifierExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(span), details: { feature: "nested-fixed-array" } });
  for (let index = 0; index < field.type.arrayLength; index += 1) {
    const atIndex = Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span }) as TinySolExpression;
    const indexedTarget = target.kind === "ArrayLiteralExpression" ? target.elements[index]! : Object.freeze({ kind: "IndexExpression", object: target, index: atIndex, span });
    output.push(Object.freeze({ kind: "Assignment", target: indexedTarget as Extract<TinySolExpression, { readonly kind: "IndexExpression" | "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" | "NestedStorageIndexExpression" }>, value: Object.freeze({ kind: "IndexExpression", object: value, index: atIndex, span }), span }));
  }
}

function appendFieldDelete(output: TinySolStatement[], target: TinySolExpression, field: FlatField, span: SourceSpan): void {
  if (field.type.arrayLength === undefined) {
    output.push(Object.freeze({ kind: "Assignment", target: target as Extract<TinySolExpression, { readonly kind: "IdentifierExpression" | "IndexExpression" | "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" | "NestedStorageIndexExpression" }>, value: zero(span, field.type), span })); return;
  }
  if (target.kind !== "IdentifierExpression" && target.kind !== "ArrayLiteralExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(span), details: { feature: "nested-fixed-array" } });
  for (let index = 0; index < field.type.arrayLength; index += 1) {
    const atIndex = Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span }) as TinySolExpression;
    const indexedTarget = target.kind === "ArrayLiteralExpression" ? target.elements[index]! : Object.freeze({ kind: "IndexExpression", object: target, index: atIndex, span });
    output.push(Object.freeze({ kind: "Assignment", target: indexedTarget as Extract<TinySolExpression, { readonly kind: "IndexExpression" | "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" | "NestedStorageIndexExpression" }>, value: zero(span, field.type), span }));
  }
}

function checkedArguments(arguments_: readonly TinySolExpression[], parameters: readonly TinySolScalarTypeNode[] | undefined, bindings: ReadonlyMap<string, Binding>, context: LoweringContext, output: TinySolStatement[]): readonly TinySolExpression[] {
  const values: TinySolExpression[] = [];
  arguments_.forEach((argument, index) => {
    const expected = parameters?.[index];
    if (expected?.userType === undefined || !context.structs.has(expected.userType)) { values.push(mapExpression(argument, bindings, context)); return; }
    if (expected.arrayLength !== undefined) {
      const captured = captureAggregateValues(aggregateArrayValue(argument, expected, bindings, context, output), expected, output, context, argument.span);
      values.push(...captured.values); return;
    }
    const fields = flattenFields(expected.userType, context.structs, context.enums); const captured = temporaryValues(flattenValue(argument, expected.userType, bindings, context, output), fields, output, context, argument.span);
    fields.forEach((field, fieldIndex) => output.push(...flatValueGuards(captured[fieldIndex]!, field, argument.span))); values.push(...captured);
  });
  return Object.freeze(values);
}

function transformBlock(block: TinySolBlock, inherited: ReadonlyMap<string, Binding>, returns: readonly TinySolScalarTypeNode[], context: LoweringContext): TinySolBlock {
  const bindings = new Map(inherited); const output: TinySolStatement[] = [];
  const expr = (value: TinySolExpression) => mapExpression(value, bindings, context);
  for (const statement of block.statements) {
    if (statement.kind === "Block") { output.push(transformBlock(statement, bindings, returns, context)); continue; }
    if (statement.kind === "VariableDeclaration" && statement.type.userType !== undefined && context.structs.has(statement.type.userType)) {
      const structName = statement.type.userType; const fields = flattenFields(structName, context.structs, context.enums);
      if (statement.type.arrayLength !== undefined) {
        const aggregateDimensions = dimensions(statement.type); const binding: Binding = Object.freeze({ structName, mode: "localArray", length: statement.type.arrayLength, dimensions: aggregateDimensions, indexType: uint256(statement.type.span) });
        if (statement.initializer !== undefined && aggregateArrayCall(statement.initializer, statement.type, context)) {
          const captured = captureAggregateCall(statement.initializer, statement.type, statement.name, bindings, context); output.push(captured.statement, ...captured.guards);
        } else {
          const values = statement.initializer === undefined ? undefined : aggregateArrayValue(statement.initializer, statement.type, bindings, context, output);
          fields.forEach((field, index) => output.push(Object.freeze({ kind: "VariableDeclaration", name: fieldName(statement.name, field.path, binding.mode), type: aggregateFieldType(field, aggregateDimensions), ...(values === undefined ? {} : { initializer: values[index]! }), span: statement.span })));
          output.push(...aggregateGuards(statement.name, binding, statement.span, context));
        }
        bindings.set(statement.name, binding); continue;
      }
      const binding: Binding = Object.freeze({ structName, mode: "local" });
      if (statement.initializer !== undefined && structCall(statement.initializer, structName, context)) {
        const captured = captureCall(statement.initializer, structName, statement.name, bindings, context); output.push(captured.statement, ...captured.guards);
      } else {
        const values = statement.initializer === undefined ? undefined : flattenValue(statement.initializer, structName, bindings, context, output);
        fields.forEach((field, index) => output.push(Object.freeze({ kind: "VariableDeclaration", name: fieldName(statement.name, field.path, "local"), type: field.type, ...(values === undefined ? field.type.arrayLength === undefined ? { initializer: zero(statement.span, field.type) } : {} : { initializer: values[index]! }), span: statement.span })));
        for (const field of fields) output.push(...flatFieldGuards(statement.name, field, "local", statement.span));
      }
      bindings.set(statement.name, binding); continue;
    }
    if (statement.kind === "VariableDeclaration") { if (statement.type.userType !== undefined) fail(ToolchainErrorCode.UNKNOWN_TYPE, { ...at(statement.type.span), details: { name: statement.type.userType } }); output.push(Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: expr(statement.initializer) }) })); continue; }
    if (statement.kind === "Assignment") {
      if (statement.target.kind === "IdentifierExpression") {
        const targetName = statement.target.name; const binding = bindings.get(targetName);
        if (binding?.mode === "array" || binding?.mode === "localArray") {
          if (statement.operator !== undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(statement.span), details: { operation: statement.operator, type: `${binding.structName}[${binding.length}]` } });
          const expected = Object.freeze({ kind: "ScalarType", name: "uint256", userType: binding.structName, arrayLength: binding.length!, ...(binding.dimensions!.length < 2 ? {} : { arrayDimensions: binding.dimensions }), span: statement.span }) as TinySolScalarTypeNode;
          let values: readonly TinySolExpression[];
          if (aggregateArrayCall(statement.value, expected, context)) {
            const captured = captureAggregateCall(statement.value, expected, `$structArrayCall${context.temporary++}`, bindings, context); output.push(captured.statement, ...captured.guards); values = captured.values;
          } else {
            values = captureAggregateValues(aggregateArrayValue(statement.value, expected, bindings, context, output), expected, output, context, statement.value.span).values;
          }
          const fields = flattenFields(binding.structName, context.structs, context.enums);
          fields.forEach((field, index) => {
            if (binding.mode === "localArray") { output.push(Object.freeze({ kind: "Assignment", target: identifier(fieldName(targetName, field.path, binding.mode), statement.target.span), value: values[index]!, span: statement.span })); return; }
            const length = aggregateLength(field, binding.length!);
            for (let item = 0; item < length; item += 1) output.push(Object.freeze({
              kind: "Assignment",
              target: Object.freeze({ kind: "IndexExpression", object: identifier(fieldName(targetName, field.path, binding.mode), statement.target.span), index: integer(item, statement.span), span: statement.span }),
              value: Object.freeze({ kind: "IndexExpression", object: values[index] as TinySolIdentifierExpression, index: integer(item, statement.span), span: statement.span }),
              span: statement.span
            }));
          });
          continue;
        }
      }
      const partialArrayTarget = partialStructArrayReference(statement.target, bindings);
      if (partialArrayTarget !== undefined) {
        if (statement.operator !== undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(statement.span), details: { operation: statement.operator, type: typeLabel(partialArrayTarget.reference.structName, partialArrayTarget.dimensions) } });
        const expected = structArrayType(partialArrayTarget.reference.structName, partialArrayTarget.dimensions, statement.span);
        const target = stabilized(partialArrayTarget.reference, bindings, context, output, statement.target.span);
        let values: readonly TinySolExpression[];
        if (aggregateArrayCall(statement.value, expected, context)) {
          const captured = captureAggregateCall(statement.value, expected, `$structSubarrayCall${context.temporary++}`, bindings, context); output.push(captured.statement, ...captured.guards); values = captured.values;
        } else values = captureAggregateValues(aggregateArrayValue(statement.value, expected, bindings, context, output), expected, output, context, statement.value.span).values;
        const fields = flattenFields(target.structName, context.structs, context.enums); const targets = flattenReference(target, statement.target.span, context);
        fields.forEach((field, fieldIndex) => {
          const targetArray = targets[fieldIndex]!; const source = values[fieldIndex]!; const length = aggregateLength(field, expected.arrayLength!);
          if (targetArray.kind !== "ArrayLiteralExpression" || source.kind !== "IdentifierExpression" || targetArray.elements.length !== length) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(statement.span), details: { operation: "struct-subarray-layout" } });
          targetArray.elements.forEach((item, index) => output.push(Object.freeze({ kind: "Assignment", target: item as Extract<TinySolExpression, { readonly kind: "IndexExpression" | "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" | "NestedStorageIndexExpression" }>, value: Object.freeze({ kind: "IndexExpression", object: source, index: integer(index, statement.span), span: statement.span }), span: statement.span })));
        });
        continue;
      }
      const rawTarget = structReference(statement.target, bindings, context);
      if (rawTarget !== undefined) {
        if (statement.operator !== undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(statement.span), details: { operation: statement.operator, type: rawTarget.structName } });
        const target = stabilized(rawTarget, bindings, context, output, statement.target.span); const fields = flattenFields(target.structName, context.structs, context.enums);
        let values: readonly TinySolExpression[];
        if (structCall(statement.value, target.structName, context)) {
          const root = `$structCall${context.temporary++}`; const captured = captureCall(statement.value, target.structName, root, bindings, context); output.push(captured.statement, ...captured.guards); values = flattenReference({ root, prefix: "", binding: captured.binding, structName: target.structName, indices: Object.freeze([]) }, statement.value.span, context);
        } else {
          values = temporaryValues(flattenValue(statement.value, target.structName, bindings, context, output), fields, output, context, statement.span);
          fields.forEach((field, fieldIndex) => output.push(...flatValueGuards(values[fieldIndex]!, field, statement.value.span)));
        }
        const targets = flattenReference(target, statement.target.span, context);
        targets.forEach((item, index) => appendFieldAssignment(output, item, values[index]!, fields[index]!, statement.span));
        continue;
      }
      if (statement.target.kind === "MemberExpression" || statement.target.kind === "IndexExpression" && statement.target.object.kind === "MemberExpression") {
        const item = access(statement.target); const binding = item === undefined ? undefined : bindings.get(item.root); const field = binding === undefined ? undefined : flattenFields(binding.structName, context.structs, context.enums).find((candidate) => candidate.path === item!.path);
        if (field?.enumMaximum !== undefined) {
          if (statement.value.kind === "LiteralExpression" && statement.value.literalKind === "integer" && BigInt(statement.value.value) >= BigInt(field.enumMaximum)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(statement.value.span), details: { actual: statement.value.value, expected: `${binding!.structName}.${item!.path}` } });
          const name = `$structEnum${context.temporary++}`; const value = expr(statement.value); const type = Object.freeze({ kind: "ScalarType", name: field.type.name, span: field.type.span }) as TinySolScalarTypeNode; output.push(Object.freeze({ kind: "VariableDeclaration", name, type, initializer: value, span: statement.span }), guardExpression(identifier(name, statement.value.span), field.enumMaximum, statement.span), Object.freeze({ ...statement, target: expr(statement.target) as typeof statement.target, value: identifier(name, statement.value.span) })); continue;
        }
      }
      output.push(Object.freeze({ ...statement, target: expr(statement.target) as typeof statement.target, value: expr(statement.value) })); continue;
    }
    if (statement.kind === "DeleteStatement") {
      if (statement.target.kind === "IdentifierExpression") {
        const binding = bindings.get(statement.target.name);
        if (binding?.mode === "array") {
          for (const field of flattenFields(binding.structName, context.structs, context.enums)) {
            const name = fieldName(statement.target.name, field.path, binding.mode);
            for (let item = 0; item < aggregateLength(field, binding.length!); item += 1) output.push(Object.freeze({ kind: "Assignment", target: Object.freeze({ kind: "IndexExpression", object: identifier(name, statement.target.span), index: integer(item, statement.span), span: statement.span }), value: zero(statement.span, field.type), span: statement.span }));
          }
          continue;
        }
        if (binding?.mode === "localArray") {
          for (const field of flattenFields(binding.structName, context.structs, context.enums)) output.push(Object.freeze({ kind: "DeleteStatement", target: identifier(fieldName(statement.target.name, field.path, binding.mode), statement.target.span), span: statement.span }));
          continue;
        }
      }
      const partialArrayTarget = partialStructArrayReference(statement.target, bindings);
      if (partialArrayTarget !== undefined) {
        const target = stabilized(partialArrayTarget.reference, bindings, context, output, statement.target.span); const fields = flattenFields(target.structName, context.structs, context.enums); const targets = flattenReference(target, statement.target.span, context);
        fields.forEach((field, fieldIndex) => {
          const targetArray = targets[fieldIndex]!; const length = aggregateLength(field, dimensionProduct(partialArrayTarget.dimensions, statement.span));
          if (targetArray.kind !== "ArrayLiteralExpression" || targetArray.elements.length !== length) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(statement.span), details: { operation: "struct-subarray-layout" } });
          targetArray.elements.forEach((item) => output.push(Object.freeze({ kind: "Assignment", target: item as Extract<TinySolExpression, { readonly kind: "IndexExpression" | "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" | "NestedStorageIndexExpression" }>, value: zero(statement.span, field.type), span: statement.span })));
        });
        continue;
      }
      const rawTarget = structReference(statement.target, bindings, context);
      if (rawTarget !== undefined) {
        const target = stabilized(rawTarget, bindings, context, output, statement.target.span); const fields = flattenFields(target.structName, context.structs, context.enums); const targets = flattenReference(target, statement.target.span, context);
        targets.forEach((item, index) => appendFieldDelete(output, item, fields[index]!, statement.span)); continue;
      }
      output.push(Object.freeze({ ...statement, target: expr(statement.target) as typeof statement.target })); continue;
    }
    if (statement.kind === "TupleAssignment") {
      const shape = callableShape(statement.value, context);
      if (shape !== undefined && shape.returns.length !== statement.bindings.length) fail(ToolchainErrorCode.RETURN_MISMATCH, { ...at(statement.span), details: { actual: shape.returns.length, expected: statement.bindings.length } });
      const expanded: typeof statement.bindings[number][] = []; const guards: TinySolStatement[] = []; const pending: [string, Binding][] = [];
      statement.bindings.forEach((item, index) => {
        const returned = shape?.returns[index]; const typedStruct = item.type?.userType !== undefined && context.structs.has(item.type.userType) ? item.type.userType : undefined; const existing = item.type === undefined ? bindings.get(item.name) : undefined; const expected = typedStruct ?? existing?.structName;
        if (item.type?.userType !== undefined && typedStruct === undefined) fail(ToolchainErrorCode.UNKNOWN_TYPE, { ...at(item.type.span), details: { name: item.type.userType } });
        if (expected === undefined) {
          if (returned?.userType !== undefined && context.structs.has(returned.userType)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(item.span), details: { actual: returned.userType, expected: item.type?.name ?? "scalar" } });
          expanded.push(item); return;
        }
        const expectedLength = item.type?.arrayLength ?? existing?.length; const expectedDimensions = item.type === undefined ? existing?.dimensions ?? Object.freeze([]) : dimensions(item.type);
        if (returned !== undefined && (returned.userType !== expected || !sameDimensions(dimensions(returned), expectedDimensions))) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(item.span), details: { actual: returned.userType === undefined ? returned.name : typeLabel(returned.userType, dimensions(returned)), expected: typeLabel(expected, expectedDimensions) } });
        const binding = existing ?? Object.freeze({ structName: expected, mode: expectedLength === undefined ? "local" as const : "localArray" as const, ...(expectedLength === undefined ? {} : { length: expectedLength, dimensions: expectedDimensions, indexType: uint256(item.span) }) }); const fields = flattenFields(expected, context.structs, context.enums);
        fields.forEach((field) => {
          const name = fieldName(item.name, field.path, binding.mode); expanded.push(Object.freeze({ ...item, name, ...(item.type === undefined ? {} : { type: expectedLength === undefined ? field.type : aggregateFieldType(field, expectedDimensions) }) }));
          if (expectedLength === undefined) guards.push(...flatFieldGuards(item.name, field, binding.mode, item.span));
        });
        if (expectedLength !== undefined) guards.push(...aggregateGuards(item.name, binding, item.span, context));
        if (typedStruct !== undefined) pending.push([item.name, binding]);
      });
      const value = expr(statement.value) as typeof statement.value; output.push(Object.freeze({ ...statement, bindings: Object.freeze(expanded), value }), ...guards); for (const [name, binding] of pending) bindings.set(name, binding); continue;
    }
    if (statement.kind === "IfStatement") { output.push(Object.freeze({ ...statement, condition: expr(statement.condition), consequent: transformBlock(statement.consequent, bindings, returns, context), ...(statement.alternate === undefined ? {} : { alternate: transformBlock(statement.alternate, bindings, returns, context) }) })); continue; }
    if (statement.kind === "WhileStatement") { output.push(Object.freeze({ ...statement, condition: expr(statement.condition), body: transformBlock(statement.body, bindings, returns, context) })); continue; }
    if (statement.kind === "ForStatement") {
      if (statement.initializer?.kind === "VariableDeclaration" && statement.initializer.type.userType !== undefined && context.structs.has(statement.initializer.type.userType)) {
        const initializer = transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([statement.initializer]), span: statement.initializer.span }), bindings, returns, context);
        bindings.set(statement.initializer.name, Object.freeze({ structName: statement.initializer.type.userType, mode: statement.initializer.type.arrayLength === undefined ? "local" : "localArray", ...(statement.initializer.type.arrayLength === undefined ? {} : { length: statement.initializer.type.arrayLength, dimensions: dimensions(statement.initializer.type), indexType: uint256(statement.initializer.type.span) }) }));
        const { initializer: _initializer, ...loopStatement } = statement;
        const loop: TinySolStatement = Object.freeze({ ...loopStatement, ...(statement.condition === undefined ? {} : { condition: expr(statement.condition) }), ...(statement.update === undefined ? {} : { update: transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([statement.update]), span: statement.update.span }), bindings, returns, context).statements[0] as typeof statement.update }), body: transformBlock(statement.body, bindings, returns, context) });
        output.push(Object.freeze({ kind: "Block", statements: Object.freeze([...initializer.statements, loop]), span: statement.span })); continue;
      }
      const wrap = (item: TinySolStatement | undefined) => item === undefined ? undefined : transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([item]), span: item.span }), bindings, returns, context).statements[0];
      output.push(Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: wrap(statement.initializer) as typeof statement.initializer }), ...(statement.condition === undefined ? {} : { condition: expr(statement.condition) }), ...(statement.update === undefined ? {} : { update: wrap(statement.update) as typeof statement.update }), body: transformBlock(statement.body, bindings, returns, context) })); continue;
    }
    if (statement.kind === "BreakStatement" || statement.kind === "ContinueStatement") { output.push(statement); continue; }
    if (statement.kind === "ReturnStatement") {
      const values: TinySolExpression[] = [];
      statement.values.forEach((value, index) => {
        const type = returns[index];
        if (type?.userType === undefined || !context.structs.has(type.userType)) { values.push(expr(value)); return; }
        if (type.arrayLength !== undefined) {
          if (aggregateArrayCall(value, type, context)) {
            const captured = captureAggregateCall(value, type, `$structArrayReturn${context.temporary++}`, bindings, context); output.push(captured.statement, ...captured.guards); values.push(...captured.values);
          } else {
            const captured = captureAggregateValues(aggregateArrayValue(value, type, bindings, context, output), type, output, context, value.span); values.push(...captured.values);
          }
          return;
        }
        const fields = flattenFields(type.userType, context.structs, context.enums);
        if (structCall(value, type.userType, context)) {
          const root = `$structReturn${context.temporary++}`; const captured = captureCall(value, type.userType, root, bindings, context); output.push(captured.statement, ...captured.guards); values.push(...flattenReference({ root, prefix: "", binding: captured.binding, structName: type.userType, indices: Object.freeze([]) }, value.span, context));
        } else {
          const captured = temporaryValues(flattenValue(value, type.userType, bindings, context, output), fields, output, context, value.span);
          fields.forEach((field, fieldIndex) => output.push(...flatValueGuards(captured[fieldIndex]!, field, value.span))); values.push(...captured);
        }
      });
      output.push(Object.freeze({ ...statement, values: Object.freeze(values) })); continue;
    }
    if (statement.kind === "RequireStatement") { output.push(Object.freeze({ ...statement, condition: expr(statement.condition) })); continue; }
    if (statement.kind === "RevertStatement") { output.push(Object.freeze({ ...statement, ...(statement.arguments === undefined ? {} : { arguments: checkedArguments(statement.arguments, statement.errorName === undefined ? undefined : context.errors.get(statement.errorName), bindings, context, output) }) })); continue; }
    if (statement.kind === "EmitStatement") { output.push(Object.freeze({ ...statement, arguments: checkedArguments(statement.arguments, context.events.get(statement.eventName), bindings, context, output) })); continue; }
    if (statement.kind === "ExpressionStatement") { output.push(Object.freeze({ ...statement, expression: expr(statement.expression) })); continue; }
  }
  return Object.freeze({ ...block, statements: Object.freeze(output) });
}

function flattenParameters(parameters: readonly TinySolParameter[], context: LoweringContext): readonly TinySolParameter[] {
  return Object.freeze(parameters.flatMap((parameter) => parameter.type.userType !== undefined && context.structs.has(parameter.type.userType)
    ? flattenFields(parameter.type.userType, context.structs, context.enums).map((field) => Object.freeze({ ...parameter, name: fieldName(parameter.name, field.path, "local"), type: parameter.type.arrayLength === undefined ? field.type : aggregateFieldType(field, dimensions(parameter.type)) }))
    : parameter.type.userType !== undefined ? fail(ToolchainErrorCode.UNKNOWN_TYPE, { ...at(parameter.type.span), details: { name: parameter.type.userType } }) : [parameter]));
}

function flattenTypes(types: readonly TinySolScalarTypeNode[], context: LoweringContext): readonly TinySolScalarTypeNode[] {
  return Object.freeze(types.flatMap((type) => type.userType !== undefined && context.structs.has(type.userType)
    ? flattenFields(type.userType, context.structs, context.enums).map((field) => type.arrayLength === undefined ? field.type : aggregateFieldType(field, dimensions(type)))
    : type.userType !== undefined ? fail(ToolchainErrorCode.UNKNOWN_TYPE, { ...at(type.span), details: { name: type.userType } }) : [type]));
}

function flattenEventParameters<T extends TinySolParameter>(parameters: readonly T[], context: LoweringContext): readonly T[] {
  return Object.freeze(parameters.flatMap((parameter) => parameter.type.userType !== undefined && context.structs.has(parameter.type.userType)
    ? flattenFields(parameter.type.userType, context.structs, context.enums).map((field) => Object.freeze({ ...parameter, name: `${parameter.name}.${field.path}`, type: parameter.type.arrayLength === undefined ? field.type : aggregateFieldType(field, dimensions(parameter.type)) }) as T) : [parameter]));
}

function parameterBinding(parameter: TinySolParameter): Binding {
  return Object.freeze({
    structName: parameter.type.userType!,
    mode: parameter.type.arrayLength === undefined ? "local" : "localArray",
    ...(parameter.type.arrayLength === undefined ? {} : { length: parameter.type.arrayLength, dimensions: dimensions(parameter.type), indexType: uint256(parameter.type.span) })
  });
}

function parameterGuards(parameter: TinySolParameter, context: LoweringContext): readonly TinySolStatement[] {
  if (parameter.type.userType === undefined || !context.structs.has(parameter.type.userType)) return Object.freeze([]);
  const binding = parameterBinding(parameter);
  if (binding.mode === "localArray") return aggregateGuards(parameter.name, binding, parameter.span, context);
  return Object.freeze(flattenFields(binding.structName, context.structs, context.enums).flatMap((field) => flatFieldGuards(parameter.name, field, binding.mode, parameter.span)));
}

function localWords(block: TinySolBlock): number {
  let words = 0;
  for (const statement of block.statements) {
    if (statement.kind === "VariableDeclaration") words += 1;
    else if (statement.kind === "TupleAssignment") words += statement.bindings.filter((binding) => binding.type !== undefined).length;
    else if (statement.kind === "Block") words += localWords(statement);
    else if (statement.kind === "IfStatement") words += localWords(statement.consequent) + (statement.alternate === undefined ? 0 : localWords(statement.alternate));
    else if (statement.kind === "WhileStatement") words += localWords(statement.body);
    else if (statement.kind === "ForStatement") words += (statement.initializer?.kind === "VariableDeclaration" ? 1 : 0) + localWords(statement.body);
  }
  return words;
}

function enforceCallableLimits(parameters: number, returns: number, locals: number, internal: boolean, span: SourceSpan): void {
  const inputMaximum = internal ? 31 : TINYSOL_LIMITS.parameters;
  if (parameters > inputMaximum) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(span), details: { resource: "function-input-words", actual: parameters, maximum: inputMaximum } });
  if (returns > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(span), details: { resource: "function-output-words", actual: returns, maximum: TINYSOL_LIMITS.parameters } });
  const maximum = internal ? 31 : 128; const actual = parameters + locals;
  if (actual > maximum) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(span), details: { resource: "local-words", actual, maximum } });
}

export function lowerStructs(program: TinySolProgram, enums: EnumTable): TinySolProgram {
  const structs = validateDeclarations(program, enums);
  const known = (type: TinySolScalarTypeNode): void => { if (type.userType !== undefined && !structs.has(type.userType)) fail(ToolchainErrorCode.UNKNOWN_TYPE, { ...at(type.span), details: { name: type.userType } }); };
  for (const state of program.contract.stateVariables) { if (state.type.kind === "ScalarType") known(state.type); else { known(state.type.keyType); known(state.type.valueType); } }
  for (const event of program.contract.events) event.parameters.forEach((parameter) => known(parameter.type));
  for (const error of program.contract.errors) error.parameters.forEach((parameter) => known(parameter.type));
  if (program.contract.constructor?.kind === "ConstructorDeclaration") program.contract.constructor.parameters.forEach((parameter) => known(parameter.type));
  for (const fn of program.contract.functions) { fn.parameters.forEach((parameter) => known(parameter.type)); fn.returns.forEach(known); }
  for (const item of program.interfaces) { if (item.constructor?.kind === "InterfaceConstructor") item.constructor.parameters.forEach(known); for (const fn of item.functions) { fn.parameters.forEach(known); fn.returns.forEach(known); } }
  if (structs.size === 0) return Object.freeze({ ...program, contract: Object.freeze({ ...program.contract, structs: Object.freeze([]) }) });
  const context: LoweringContext = {
    structs, enums,
    functions: new Map(program.contract.functions.map((fn) => [fn.name, Object.freeze({ parameters: Object.freeze(fn.parameters.map((parameter) => parameter.type)), returns: fn.returns })])),
    interfaces: new Map(program.interfaces.map((item) => [item.name, new Map(item.functions.map((fn) => [fn.name, Object.freeze({ parameters: fn.parameters, returns: fn.returns })]))])),
    constructors: new Map(program.interfaces.flatMap((item) => item.constructor?.kind === "InterfaceConstructor" ? [[item.name, item.constructor.parameters] as const] : [])),
    events: new Map(program.contract.events.map((event) => [event.name, event.parameters.map((parameter) => parameter.type)])),
    errors: new Map(program.contract.errors.map((error) => [error.name, error.parameters.map((parameter) => parameter.type)])),
    temporary: 0
  };
  const bindings = new Map<string, Binding>(); const stateVariables: TinySolProgram["contract"]["stateVariables"][number][] = [];
  for (const state of program.contract.stateVariables) {
    if (state.type.kind === "ScalarType" && state.type.userType !== undefined && structs.has(state.type.userType)) {
      const mode = state.type.arrayLength === undefined ? "storage" : "array"; const binding: Binding = Object.freeze({ structName: state.type.userType, mode, ...(mode === "array" ? { indexType: uint256(state.type.span), length: state.type.arrayLength, dimensions: dimensions(state.type) } : {}) }); bindings.set(state.name, binding);
      for (const field of flattenFields(state.type.userType, structs, enums)) {
        stateVariables.push(Object.freeze({ ...state, name: fieldName(state.name, field.path, mode), type: state.type.arrayLength === undefined ? field.type : aggregateFieldType(field, dimensions(state.type)) }));
      }
    } else if (state.type.kind === "MappingType" && state.type.valueType.userType !== undefined && structs.has(state.type.valueType.userType)) {
      const aggregateDimensions = dimensions(state.type.valueType); const aggregateWords = state.type.valueType.arrayLength ?? 1;
      bindings.set(state.name, Object.freeze({ structName: state.type.valueType.userType, mode: "mapping", indexType: state.type.keyType, ...(state.type.valueType.arrayLength === undefined ? {} : { length: aggregateWords, dimensions: aggregateDimensions }) }));
      for (const field of flattenFields(state.type.valueType.userType, structs, enums)) {
        const items = Object.freeze([...aggregateDimensions, ...dimensions(field.type)]); const valueArrayLength = items.length === 0 ? 1 : dimensionProduct(items, state.type.span);
        const valueType = items.length === 0 ? field.type : Object.freeze({ kind: "ScalarType", name: field.type.name, span: field.type.span }) as TinySolScalarTypeNode;
        stateVariables.push(Object.freeze({ ...state, name: fieldName(state.name, field.path, "mapping"), type: Object.freeze({ ...state.type, valueType, ...(items.length === 0 ? {} : { valueArrayLength }), ...(items.length < 2 ? {} : { valueArrayDimensions: items }) }) as TinySolMappingTypeNode }));
      }
    } else stateVariables.push(state);
  }
  if (stateVariables.length > TINYSOL_LIMITS.stateVariables) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(program.contract.span), details: { resource: "lowered-state-variables", actual: stateVariables.length, maximum: TINYSOL_LIMITS.stateVariables } });
  const events = Object.freeze(program.contract.events.map((event) => Object.freeze({ ...event, parameters: flattenEventParameters(event.parameters, context) })));
  const errors = Object.freeze(program.contract.errors.map((error) => Object.freeze({ ...error, parameters: flattenEventParameters(error.parameters, context) })));
  for (const event of events) if (event.parameters.length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(event.span), details: { resource: "event-words", actual: event.parameters.length, maximum: TINYSOL_LIMITS.parameters } });
  for (const error of errors) if (error.parameters.length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(error.span), details: { resource: "error-words", actual: error.parameters.length, maximum: TINYSOL_LIMITS.parameters } });
  const functions = Object.freeze(program.contract.functions.map((fn) => {
    const local = new Map(bindings); fn.parameters.forEach((parameter) => { if (parameter.type.userType !== undefined && structs.has(parameter.type.userType)) local.set(parameter.name, parameterBinding(parameter)); });
    const body = transformBlock(fn.body, local, fn.returns, context); const parameters = flattenParameters(fn.parameters, context); const returns = flattenTypes(fn.returns, context);
    const guards = fn.parameters.flatMap((parameter) => parameterGuards(parameter, context));
    enforceCallableLimits(parameters.length, returns.length, localWords(body), fn.visibility === "internal", fn.span);
    return Object.freeze({ ...fn, parameters, returns, body: Object.freeze({ ...body, statements: Object.freeze([...guards, ...body.statements]) }) });
  }));
  const constructor = program.contract.constructor?.kind !== "ConstructorDeclaration" ? undefined : (() => {
    const declaration = program.contract.constructor; const local = new Map(bindings); declaration.parameters.forEach((parameter) => { if (parameter.type.userType !== undefined && structs.has(parameter.type.userType)) local.set(parameter.name, parameterBinding(parameter)); });
    const body = transformBlock(declaration.body, local, [], context); const parameters = flattenParameters(declaration.parameters, context); const guards = declaration.parameters.flatMap((parameter) => parameterGuards(parameter, context));
    enforceCallableLimits(parameters.length, 0, localWords(body), false, declaration.span);
    return Object.freeze({ ...declaration, parameters, body: Object.freeze({ ...body, statements: Object.freeze([...guards, ...body.statements]) }) });
  })();
  const loweredInterfaces = Object.freeze(program.interfaces.map((item) => {
    const loweredConstructor = item.constructor?.kind !== "InterfaceConstructor" ? undefined : Object.freeze({ ...item.constructor, parameters: flattenTypes(item.constructor.parameters, context) });
    if (loweredConstructor !== undefined && loweredConstructor.parameters.length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(item.constructor!.span), details: { resource: "create-input-words", actual: loweredConstructor.parameters.length, maximum: TINYSOL_LIMITS.parameters } });
    const loweredFunctions = Object.freeze(item.functions.map((fn) => {
      const parameters = flattenTypes(fn.parameters, context); const returns = flattenTypes(fn.returns, context);
      if (parameters.length > 23) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(fn.span), details: { resource: "call-input-words", actual: parameters.length, maximum: 23 } });
      if (returns.length > 8) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(fn.span), details: { resource: "call-output-words", actual: returns.length, maximum: 8 } });
      return Object.freeze({ ...fn, parameters, returns });
    }));
    return Object.freeze({ ...item, ...(loweredConstructor === undefined ? {} : { constructor: loweredConstructor }), functions: loweredFunctions });
  }));
  const contract = Object.freeze({ ...program.contract, structs: Object.freeze([]), stateVariables: Object.freeze(stateVariables), events, errors, ...(constructor === undefined ? {} : { constructor }), functions });
  return Object.freeze({ ...program, interfaces: loweredInterfaces, contract });
}
