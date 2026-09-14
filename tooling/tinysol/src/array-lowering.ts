import { ToolchainErrorCode, fail } from "./errors.js";
import { TINYSOL_LIMITS } from "./compiler-types.js";
import type {
  SourceSpan,
  TinySolBlock,
  TinySolExpression,
  TinySolIdentifierExpression,
  TinySolParameter,
  TinySolProgram,
  TinySolScalarTypeNode,
  TinySolStatement
} from "./compiler-types.js";

interface ArrayBinding {
  readonly elementType: TinySolScalarTypeNode;
  readonly length: number;
  readonly dimensions: readonly number[];
  readonly elements: readonly string[];
}

interface CallableShape {
  readonly parameters: readonly TinySolScalarTypeNode[];
  readonly returns: readonly TinySolScalarTypeNode[];
}

interface PartialArrayAccess {
  readonly root: TinySolIdentifierExpression;
  readonly indices: readonly TinySolExpression[];
  readonly dimensions: readonly number[];
  readonly elementType: TinySolScalarTypeNode;
  readonly keyType?: TinySolScalarTypeNode;
}

interface LoweringContext {
  readonly functions: ReadonlyMap<string, CallableShape>;
  readonly interfaces: ReadonlyMap<string, ReadonlyMap<string, CallableShape>>;
  readonly constructors: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly events: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly errors: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly stateArrays: ReadonlyMap<string, TinySolScalarTypeNode>;
  readonly mappingArrays: ReadonlyMap<string, { readonly keyType: TinySolScalarTypeNode; readonly valueType: TinySolScalarTypeNode }>;
  temporary: number;
}

function at(span: SourceSpan) { return { line: span.start.line, column: span.start.column, offset: span.start.byteOffset }; }

function dimensions(type: TinySolScalarTypeNode): readonly number[] {
  return type.arrayDimensions ?? (type.arrayLength === undefined ? Object.freeze([]) : Object.freeze([type.arrayLength]));
}

function sameDimensions(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((dimension, index) => dimension === right[index]);
}

function arrayTypeName(type: TinySolScalarTypeNode): string {
  return `${type.name}${[...dimensions(type)].reverse().map((length) => `[${length}]`).join("")}`;
}

function sameArrayType(left: TinySolScalarTypeNode, right: TinySolScalarTypeNode): boolean {
  return left.name === right.name && left.arrayLength === right.arrayLength && sameDimensions(dimensions(left), dimensions(right));
}

function arrayType(type: TinySolScalarTypeNode, items: readonly number[]): TinySolScalarTypeNode {
  const length = items.reduce((product, item) => product * item, 1);
  return Object.freeze({ kind: "ScalarType", name: type.name, arrayLength: length, ...(items.length < 2 ? {} : { arrayDimensions: Object.freeze([...items]) }), span: type.span });
}

function elementType(type: TinySolScalarTypeNode): TinySolScalarTypeNode {
  if (type.userType !== undefined) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(type.span), details: { feature: "aggregate-fixed-array" } });
  return Object.freeze({ kind: "ScalarType", name: type.name, span: type.span });
}

function elementNames(name: string, length: number): readonly string[] {
  return Object.freeze(Array.from({ length }, (_, index) => `${name}$${index}`));
}

function identifier(name: string, span: SourceSpan): TinySolIdentifierExpression {
  return Object.freeze({ kind: "IdentifierExpression", name, span });
}

function indexedAccess(expression: TinySolExpression): { readonly root: TinySolIdentifierExpression; readonly indices: readonly TinySolExpression[] } | undefined {
  const indices: TinySolExpression[] = []; let current = expression;
  while (current.kind === "IndexExpression") { indices.unshift(current.index); current = current.object; }
  return current.kind === "IdentifierExpression" && indices.length > 0 ? Object.freeze({ root: current, indices: Object.freeze(indices) }) : undefined;
}

function indexExpression(root: TinySolIdentifierExpression, indices: readonly TinySolExpression[], span: SourceSpan): TinySolExpression {
  return indices.reduce<TinySolExpression>((object, index) => Object.freeze({ kind: "IndexExpression", object: object as TinySolIdentifierExpression | Extract<TinySolExpression, { readonly kind: "IndexExpression" }>, index, span }), root);
}

function partialArrayAccess(expression: TinySolExpression, bindings: ReadonlyMap<string, ArrayBinding>, context: LoweringContext): PartialArrayAccess | undefined {
  const access = indexedAccess(expression);
  if (access === undefined) return undefined;
  const binding = bindings.get(access.root.name);
  if (binding !== undefined) {
    if (binding.dimensions.length > 1 && access.indices.length === 1 && (access.root.name.includes("$") || access.root.name.includes("."))) return undefined;
    if (access.indices.length >= binding.dimensions.length) return undefined;
    return Object.freeze({ root: access.root, indices: access.indices, dimensions: binding.dimensions, elementType: binding.elementType });
  }
  const state = context.stateArrays.get(access.root.name);
  if (state !== undefined) {
    const items = dimensions(state);
    if (items.length > 1 && access.indices.length === 1 && (access.root.name.includes("$") || access.root.name.includes("."))) return undefined;
    if (access.indices.length >= items.length) return undefined;
    return Object.freeze({ root: access.root, indices: access.indices, dimensions: items, elementType: elementType(state) });
  }
  const mapping = context.mappingArrays.get(access.root.name);
  if (mapping !== undefined) {
    const items = dimensions(mapping.valueType);
    if (access.indices.length === 0 || access.indices.length - 1 >= items.length) return undefined;
    return Object.freeze({ root: access.root, indices: access.indices, dimensions: items, elementType: elementType(mapping.valueType), keyType: mapping.keyType });
  }
  return undefined;
}

function coordinateSuffixes(items: readonly number[], span: SourceSpan): readonly (readonly TinySolExpression[])[] {
  let output: readonly (readonly TinySolExpression[])[] = Object.freeze([Object.freeze([])]);
  for (const length of items) output = Object.freeze(output.flatMap((prefix) => Array.from({ length }, (_, index) => Object.freeze([...prefix, Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(index), span }) as TinySolExpression]))));
  return output;
}

function zero(type: TinySolScalarTypeNode, span: SourceSpan): TinySolExpression {
  if (type.name === "bool") return Object.freeze({ kind: "LiteralExpression", literalKind: "bool", value: "false", span });
  if (type.name === "address") return Object.freeze({ kind: "LiteralExpression", literalKind: "address", value: `0x${"0".repeat(40)}`, span });
  if (type.name === "bytes32") return Object.freeze({ kind: "LiteralExpression", literalKind: "bytes32", value: `0x${"0".repeat(64)}`, span });
  if (type.name === "account") return Object.freeze({ kind: "LiteralExpression", literalKind: "account", value: `0x${"0".repeat(64)}`, span });
  return Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: "0", span });
}

function flattenTypes(types: readonly TinySolScalarTypeNode[]): readonly TinySolScalarTypeNode[] {
  return Object.freeze(types.flatMap((type) => type.arrayLength === undefined ? [type] : Array.from({ length: type.arrayLength }, () => elementType(type))));
}

function flattenParameters(parameters: readonly TinySolParameter[]): readonly TinySolParameter[] {
  return Object.freeze(parameters.flatMap((parameter) => {
    if (parameter.type.arrayLength === undefined) return [parameter];
    const type = elementType(parameter.type);
    return elementNames(parameter.name, parameter.type.arrayLength).map((name) => Object.freeze({ ...parameter, name, type }));
  }));
}

function callableShape(expression: TinySolExpression, context: LoweringContext): CallableShape | undefined {
  if (expression.kind === "FunctionCallExpression") return context.functions.get(expression.functionName);
  if (expression.kind === "ExternalCallExpression") return context.interfaces.get(expression.interfaceName)?.get(expression.functionName);
  return undefined;
}

function mapArguments(arguments_: readonly TinySolExpression[], parameters: readonly TinySolScalarTypeNode[] | undefined, bindings: ReadonlyMap<string, ArrayBinding>, context: LoweringContext, prelude?: TinySolStatement[]): readonly TinySolExpression[] {
  return Object.freeze(arguments_.flatMap((argument, index) => {
    const expected = parameters?.[index];
    return expected?.arrayLength === undefined ? [mapExpression(argument, bindings, context, prelude)] : flattenArrayValue(argument, expected, bindings, context, prelude);
  }));
}

function mapExpression(expression: TinySolExpression, bindings: ReadonlyMap<string, ArrayBinding>, context: LoweringContext, prelude?: TinySolStatement[]): TinySolExpression {
  if (expression.kind === "IdentifierExpression") {
    if (bindings.has(expression.name)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: "array", expected: "scalar" } });
    return expression;
  }
  if (expression.kind === "ArrayLiteralExpression") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: "array", expected: "scalar" } });
  if (expression.kind === "IndexExpression") {
    const access = indexedAccess(expression);
    if (access === undefined) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "unlowered-aggregate-index" } });
    const indices = Object.freeze(access.indices.map((index) => mapExpression(index, bindings, context, prelude)));
    const binding = bindings.get(access.root.name);
    if (binding !== undefined) {
      if (indices.length === 1 && binding.dimensions.length > 1 && (access.root.name.includes("$") || access.root.name.includes("."))) return Object.freeze({ kind: "LocalArrayIndexExpression", baseName: binding.elements[0]!, length: binding.length, elementType: binding.elementType.name, index: indices[0]!, span: expression.span });
      if (indices.length !== binding.dimensions.length) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "partial-multidimensional-array-index" } });
      if (binding.dimensions.length === 1) return Object.freeze({ kind: "LocalArrayIndexExpression", baseName: binding.elements[0]!, length: binding.length, elementType: binding.elementType.name, index: indices[0]!, span: expression.span });
      return Object.freeze({ kind: "LocalNestedArrayIndexExpression", baseName: binding.elements[0]!, indices, dimensions: binding.dimensions, elementType: binding.elementType.name, span: expression.span });
    }
    const state = context.stateArrays.get(access.root.name);
    if (state !== undefined) {
      const items = dimensions(state);
      if (indices.length === 1 && items.length > 1 && (access.root.name.includes("$") || access.root.name.includes("."))) return Object.freeze({ kind: "IndexExpression", object: access.root, index: indices[0]!, span: expression.span });
      if (indices.length !== items.length) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "partial-multidimensional-array-index" } });
      if (items.length === 1) return Object.freeze({ kind: "IndexExpression", object: access.root, index: indices[0]!, span: expression.span });
      return Object.freeze({ kind: "NestedArrayIndexExpression", object: access.root, indices, dimensions: items, elementType: state.name, span: expression.span });
    }
    const mapping = context.mappingArrays.get(access.root.name);
    if (mapping !== undefined) {
      const items = dimensions(mapping.valueType);
      if (indices.length !== items.length + 1) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "partial-multidimensional-array-index" } });
      return Object.freeze({ kind: "NestedStorageIndexExpression", object: access.root, key: indices[0]!, indices: Object.freeze(indices.slice(1)), dimensions: items, elementType: mapping.valueType.name, span: expression.span });
    }
    if (expression.object.kind !== "IdentifierExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "unlowered-aggregate-index" } });
    return Object.freeze({ ...expression, index: indices[0]! });
  }
  if (expression.kind === "LocalArrayIndexExpression") return Object.freeze({ ...expression, index: mapExpression(expression.index, bindings, context, prelude) });
  if (expression.kind === "NestedArrayIndexExpression") {
    const indices = Object.freeze(expression.indices.map((index) => mapExpression(index, bindings, context, prelude)));
    const binding = bindings.get(expression.object.name);
    if (binding === undefined) return Object.freeze({ ...expression, indices });
    if (binding.length !== expression.dimensions.reduce((product, dimension) => product * dimension, 1) || binding.elementType.name !== expression.elementType) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(expression.span), details: { operation: "nested-array-layout" } });
    return Object.freeze({ kind: "LocalNestedArrayIndexExpression", baseName: binding.elements[0]!, indices, dimensions: expression.dimensions, elementType: expression.elementType, span: expression.span });
  }
  if (expression.kind === "LocalNestedArrayIndexExpression") return Object.freeze({ ...expression, indices: Object.freeze(expression.indices.map((index) => mapExpression(index, bindings, context, prelude))) });
  if (expression.kind === "NestedStorageIndexExpression") return Object.freeze({ ...expression, key: mapExpression(expression.key, bindings, context, prelude), indices: Object.freeze(expression.indices.map((index) => mapExpression(index, bindings, context, prelude))) });
  if (expression.kind === "MemberExpression" || expression.kind === "StructLiteralExpression") fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "unlowered-aggregate-expression" } });
  if (expression.kind === "UnaryExpression") return Object.freeze({ ...expression, operand: mapExpression(expression.operand, bindings, context, prelude) });
  if (expression.kind === "CastExpression") return Object.freeze({ ...expression, value: mapExpression(expression.value, bindings, context, prelude) });
  if (expression.kind === "BinaryExpression") return Object.freeze({ ...expression, left: mapExpression(expression.left, bindings, context, prelude), right: mapExpression(expression.right, bindings, context, prelude) });
  if (expression.kind === "ConditionalExpression") return Object.freeze({ ...expression, condition: mapExpression(expression.condition, bindings, context, prelude), consequent: mapExpression(expression.consequent, bindings, context, prelude), alternate: mapExpression(expression.alternate, bindings, context, prelude) });
  if (expression.kind === "FunctionCallExpression") {
    const shape = context.functions.get(expression.functionName);
    return Object.freeze({ ...expression, arguments: mapArguments(expression.arguments, shape?.parameters, bindings, context, prelude) });
  }
  if (expression.kind === "ExternalCallExpression") {
    const shape = context.interfaces.get(expression.interfaceName)?.get(expression.functionName);
    return Object.freeze({ ...expression, target: mapExpression(expression.target, bindings, context, prelude), arguments: mapArguments(expression.arguments, shape?.parameters, bindings, context, prelude) });
  }
  if (expression.kind === "CreateExpression") return Object.freeze({ ...expression, codeHash: mapExpression(expression.codeHash, bindings, context, prelude), arguments: mapArguments(expression.arguments, context.constructors.get(expression.interfaceName), bindings, context, prelude) });
  return expression;
}

function partialRemainingDimensions(access: PartialArrayAccess): readonly number[] {
  return Object.freeze(access.dimensions.slice(access.indices.length - (access.keyType === undefined ? 0 : 1)));
}

function stabilizePartialIndices(access: PartialArrayAccess, bindings: ReadonlyMap<string, ArrayBinding>, context: LoweringContext, prelude: TinySolStatement[]): readonly TinySolExpression[] {
  return Object.freeze(access.indices.map((index, position) => {
    const name = `$subarrayIndex${context.temporary++}`;
    const type = position === 0 && access.keyType !== undefined ? access.keyType : Object.freeze({ kind: "ScalarType", name: "uint256", span: index.span }) as TinySolScalarTypeNode;
    prelude.push(Object.freeze({ kind: "VariableDeclaration", name, type, initializer: mapExpression(index, bindings, context, prelude), span: index.span }));
    return identifier(name, index.span);
  }));
}

function expandPartialAccess(access: PartialArrayAccess, stableIndices: readonly TinySolExpression[], bindings: ReadonlyMap<string, ArrayBinding>, context: LoweringContext, prelude: TinySolStatement[], span: SourceSpan): readonly TinySolExpression[] {
  return Object.freeze(coordinateSuffixes(partialRemainingDimensions(access), span).map((suffix) => mapExpression(indexExpression(access.root, [...stableIndices, ...suffix], span), bindings, context, prelude)));
}

function flattenArrayValue(expression: TinySolExpression, expected: TinySolScalarTypeNode, bindings: ReadonlyMap<string, ArrayBinding>, context: LoweringContext, prelude?: TinySolStatement[]): readonly TinySolExpression[] {
  const length = expected.arrayLength!; const type = elementType(expected); const items = dimensions(expected);
  if (expression.kind === "ArrayLiteralExpression") {
    if (items.length > 1 && expression.elements.length === length && expression.elements.every((item) => item.kind !== "ArrayLiteralExpression")) return Object.freeze(expression.elements.map((item) => mapExpression(item, bindings, context, prelude)));
    const flatten = (value: TinySolExpression, depth: number): readonly TinySolExpression[] => {
      if (depth === items.length) return Object.freeze([mapExpression(value, bindings, context, prelude)]);
      if (value.kind !== "ArrayLiteralExpression") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: "scalar", expected: `array[${items[depth]}]` } });
      if (value.elements.length !== items[depth]!) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: value.elements.length, expected: items[depth]! } });
      return Object.freeze(value.elements.flatMap((item) => flatten(item, depth + 1)));
    };
    return flatten(expression, 0);
  }
  if (expression.kind === "IdentifierExpression") {
    const binding = bindings.get(expression.name);
    if (binding === undefined || binding.length !== length || binding.elementType.name !== type.name || !sameDimensions(binding.dimensions, items)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: binding === undefined ? "scalar" : arrayTypeName(Object.freeze({ ...binding.elementType, arrayLength: binding.length, ...(binding.dimensions.length === 1 ? {} : { arrayDimensions: binding.dimensions }) })), expected: arrayTypeName(expected) } });
    return Object.freeze(binding.elements.map((name) => identifier(name, expression.span)));
  }
  const partial = partialArrayAccess(expression, bindings, context);
  if (partial !== undefined) {
    const remaining = partialRemainingDimensions(partial); const actual = arrayType(partial.elementType, remaining);
    if (partial.elementType.name !== type.name || !sameDimensions(remaining, items)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: arrayTypeName(actual), expected: arrayTypeName(expected) } });
    if (prelude === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(expression.span), details: { operation: "unstabilized-subarray-index" } });
    const stable = stabilizePartialIndices(partial, bindings, context, prelude);
    const values = expandPartialAccess(partial, stable, bindings, context, prelude, expression.span);
    if (values.length !== length) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(expression.span), details: { operation: "subarray-layout" } });
    return Object.freeze(values);
  }
  fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: "scalar", expected: arrayTypeName(expected) } });
}

function arrayCall(expression: TinySolExpression, expected: TinySolScalarTypeNode, context: LoweringContext): boolean {
  const shape = callableShape(expression, context);
  return (expression.kind === "FunctionCallExpression" || expression.kind === "ExternalCallExpression")
    && shape?.returns.length === 1 && shape.returns[0]?.arrayLength === expected.arrayLength && shape.returns[0]?.name === expected.name
    && sameDimensions(dimensions(shape.returns[0]!), dimensions(expected));
}

function arrayBinding(name: string, type: TinySolScalarTypeNode): ArrayBinding {
  return Object.freeze({ elementType: elementType(type), length: type.arrayLength!, dimensions: dimensions(type), elements: elementNames(name, type.arrayLength!) });
}

function bindingType(binding: ArrayBinding): TinySolScalarTypeNode {
  return Object.freeze({ ...binding.elementType, arrayLength: binding.length, ...(binding.dimensions.length === 1 ? {} : { arrayDimensions: binding.dimensions }) });
}

function arrayTuple(expression: TinySolExpression, binding: ArrayBinding, typed: boolean, context: LoweringContext, bindings: ReadonlyMap<string, ArrayBinding>, prelude?: TinySolStatement[]): TinySolStatement {
  const value = mapExpression(expression, bindings, context, prelude);
  if (value.kind !== "FunctionCallExpression" && value.kind !== "ExternalCallExpression") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...at(expression.span) });
  return Object.freeze({
    kind: "TupleAssignment",
    bindings: Object.freeze(binding.elements.map((name) => Object.freeze({ name, ...(typed ? { type: binding.elementType } : {}), span: expression.span }))),
    value,
    span: expression.span
  });
}

function transformBlock(block: TinySolBlock, inherited: ReadonlyMap<string, ArrayBinding>, returns: readonly TinySolScalarTypeNode[], context: LoweringContext): TinySolBlock {
  const bindings = new Map(inherited); const output: TinySolStatement[] = [];
  for (const statement of block.statements) {
    if (statement.kind === "Block") { output.push(transformBlock(statement, bindings, returns, context)); continue; }
    if (statement.kind === "VariableDeclaration" && statement.type.arrayLength !== undefined) {
      const binding = arrayBinding(statement.name, statement.type);
      if (statement.initializer !== undefined && arrayCall(statement.initializer, statement.type, context)) output.push(arrayTuple(statement.initializer, binding, true, context, bindings, output));
      else {
        const values = statement.initializer === undefined ? Array.from({ length: binding.length }, () => zero(binding.elementType, statement.span)) : flattenArrayValue(statement.initializer, statement.type, bindings, context, output);
        binding.elements.forEach((name, index) => output.push(Object.freeze({ kind: "VariableDeclaration", name, type: binding.elementType, initializer: values[index]!, span: statement.span })));
      }
      bindings.set(statement.name, binding); continue;
    }
    if (statement.kind === "VariableDeclaration") { output.push(Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: mapExpression(statement.initializer, bindings, context, output) }) })); continue; }
    if (statement.kind === "Assignment" && statement.target.kind === "IdentifierExpression" && bindings.has(statement.target.name)) {
      if (statement.operator !== undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(statement.span), details: { operation: statement.operator, type: "array" } });
      const binding = bindings.get(statement.target.name)!;
      if (arrayCall(statement.value, bindingType(binding), context)) output.push(arrayTuple(statement.value, binding, false, context, bindings, output));
      else {
        const expected = bindingType(binding); const values = flattenArrayValue(statement.value, expected, bindings, context, output);
        const temporaries = values.map((value, index) => {
          const name = `$array${context.temporary++}$${index}`; output.push(Object.freeze({ kind: "VariableDeclaration", name, type: binding.elementType, initializer: value, span: statement.span })); return name;
        });
        binding.elements.forEach((name, index) => output.push(Object.freeze({ kind: "Assignment", target: identifier(name, statement.target.span), value: identifier(temporaries[index]!, statement.value.span), span: statement.span })));
      }
      continue;
    }
    if (statement.kind === "Assignment") {
      const partial = partialArrayAccess(statement.target, bindings, context);
      if (partial !== undefined) {
        if (statement.operator !== undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(statement.span), details: { operation: statement.operator, type: "subarray" } });
        const stable = stabilizePartialIndices(partial, bindings, context, output); const targets = expandPartialAccess(partial, stable, bindings, context, output, statement.target.span);
        const expected = arrayType(partial.elementType, partialRemainingDimensions(partial)); const values = flattenArrayValue(statement.value, expected, bindings, context, output);
        const temporaries = values.map((value) => {
          const name = `$subarrayValue${context.temporary++}`; output.push(Object.freeze({ kind: "VariableDeclaration", name, type: partial.elementType, initializer: value, span: statement.value.span })); return identifier(name, statement.value.span);
        });
        targets.forEach((target, index) => output.push(Object.freeze({ kind: "Assignment", target: target as Extract<TinySolExpression, { readonly kind: "IndexExpression" | "LocalArrayIndexExpression" | "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" | "NestedStorageIndexExpression" }>, value: temporaries[index]!, span: statement.span })));
        continue;
      }
      output.push(Object.freeze({ ...statement, target: mapExpression(statement.target, bindings, context, output) as typeof statement.target, value: mapExpression(statement.value, bindings, context, output) })); continue;
    }
    if (statement.kind === "DeleteStatement" && statement.target.kind === "IdentifierExpression" && bindings.has(statement.target.name)) {
      const binding = bindings.get(statement.target.name)!;
      for (const name of binding.elements) output.push(Object.freeze({ kind: "Assignment", target: identifier(name, statement.target.span), value: zero(binding.elementType, statement.span), span: statement.span }));
      continue;
    }
    if (statement.kind === "DeleteStatement") {
      const partial = partialArrayAccess(statement.target, bindings, context);
      if (partial !== undefined) {
        const stable = stabilizePartialIndices(partial, bindings, context, output); const targets = expandPartialAccess(partial, stable, bindings, context, output, statement.target.span);
        targets.forEach((target) => output.push(Object.freeze({ kind: "Assignment", target: target as Extract<TinySolExpression, { readonly kind: "IndexExpression" | "LocalArrayIndexExpression" | "NestedArrayIndexExpression" | "LocalNestedArrayIndexExpression" | "NestedStorageIndexExpression" }>, value: zero(partial.elementType, statement.span), span: statement.span })));
        continue;
      }
      output.push(Object.freeze({ ...statement, target: mapExpression(statement.target, bindings, context, output) as typeof statement.target })); continue;
    }
    if (statement.kind === "TupleAssignment") {
      const returned = callableShape(statement.value, context)?.returns;
      const expanded: typeof statement.bindings[number][] = [];
      for (const [index, item] of statement.bindings.entries()) {
        const existing = item.type === undefined ? bindings.get(item.name) : undefined;
        const expected = item.type ?? (existing === undefined ? undefined : bindingType(existing)); const actual = returned?.[index];
        if (expected?.arrayLength !== undefined && (actual === undefined || !sameArrayType(actual, expected))) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(item.span), details: { actual: actual === undefined ? "scalar" : arrayTypeName(actual), expected: arrayTypeName(expected) } });
        if (item.type?.arrayLength !== undefined) { const binding = arrayBinding(item.name, item.type); bindings.set(item.name, binding); for (const name of binding.elements) expanded.push(Object.freeze({ ...item, name, type: binding.elementType })); }
        else if (item.type === undefined && bindings.has(item.name)) { const binding = bindings.get(item.name)!; for (const name of binding.elements) expanded.push(Object.freeze({ ...item, name })); }
        else expanded.push(item);
      }
      const value = mapExpression(statement.value, bindings, context, output);
      if (value.kind !== "FunctionCallExpression" && value.kind !== "ExternalCallExpression") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { ...at(statement.span) });
      output.push(Object.freeze({ ...statement, bindings: Object.freeze(expanded), value })); continue;
    }
    if (statement.kind === "IfStatement") { output.push(Object.freeze({ ...statement, condition: mapExpression(statement.condition, bindings, context, output), consequent: transformBlock(statement.consequent, bindings, returns, context), ...(statement.alternate === undefined ? {} : { alternate: transformBlock(statement.alternate, bindings, returns, context) }) })); continue; }
    if (statement.kind === "WhileStatement") { output.push(Object.freeze({ ...statement, condition: mapExpression(statement.condition, bindings, context), body: transformBlock(statement.body, bindings, returns, context) })); continue; }
    if (statement.kind === "ForStatement") {
      if (statement.initializer?.kind === "VariableDeclaration" && statement.initializer.type.arrayLength !== undefined) {
        const initializer = transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([statement.initializer]), span: statement.initializer.span }), bindings, returns, context);
        bindings.set(statement.initializer.name, arrayBinding(statement.initializer.name, statement.initializer.type));
        const { initializer: _initializer, ...loopStatement } = statement;
        const loop: TinySolStatement = Object.freeze({ ...loopStatement, ...(statement.condition === undefined ? {} : { condition: mapExpression(statement.condition, bindings, context) }), ...(statement.update === undefined ? {} : { update: transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([statement.update]), span: statement.update.span }), bindings, returns, context).statements[0] as typeof statement.update }), body: transformBlock(statement.body, bindings, returns, context) });
        output.push(Object.freeze({ kind: "Block", statements: Object.freeze([...initializer.statements, loop]), span: statement.span })); continue;
      }
      const wrap = (item: TinySolStatement | undefined) => item === undefined ? undefined : transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([item]), span: item.span }), bindings, returns, context).statements[0];
      output.push(Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: wrap(statement.initializer) as typeof statement.initializer }), ...(statement.condition === undefined ? {} : { condition: mapExpression(statement.condition, bindings, context) }), ...(statement.update === undefined ? {} : { update: wrap(statement.update) as typeof statement.update }), body: transformBlock(statement.body, bindings, returns, context) })); continue;
    }
    if (statement.kind === "BreakStatement" || statement.kind === "ContinueStatement") { output.push(statement); continue; }
    if (statement.kind === "ReturnStatement") {
      const values: TinySolExpression[] = [];
      statement.values.forEach((value, index) => {
        const expected = returns[index];
        if (expected?.arrayLength === undefined) { values.push(mapExpression(value, bindings, context, output)); return; }
        if (arrayCall(value, expected, context)) {
          const binding = arrayBinding(`$return${context.temporary++}`, expected); output.push(arrayTuple(value, binding, true, context, bindings, output));
          values.push(...binding.elements.map((name) => identifier(name, value.span))); return;
        }
        values.push(...flattenArrayValue(value, expected, bindings, context, output));
      });
      output.push(Object.freeze({ ...statement, values: Object.freeze(values) })); continue;
    }
    if (statement.kind === "RequireStatement") { output.push(Object.freeze({ ...statement, condition: mapExpression(statement.condition, bindings, context, output) })); continue; }
    if (statement.kind === "RevertStatement") { output.push(Object.freeze({ ...statement, ...(statement.arguments === undefined ? {} : { arguments: mapArguments(statement.arguments, statement.errorName === undefined ? undefined : context.errors.get(statement.errorName), bindings, context, output) }) })); continue; }
    if (statement.kind === "EmitStatement") { output.push(Object.freeze({ ...statement, arguments: mapArguments(statement.arguments, context.events.get(statement.eventName), bindings, context, output) })); continue; }
    if (statement.kind === "ExpressionStatement") { output.push(Object.freeze({ ...statement, expression: mapExpression(statement.expression, bindings, context, output) })); continue; }
  }
  return Object.freeze({ ...block, statements: Object.freeze(output) });
}

function bindingsForParameters(parameters: readonly TinySolParameter[]): ReadonlyMap<string, ArrayBinding> {
  const bindings = new Map<string, ArrayBinding>();
  for (const parameter of parameters) if (parameter.type.arrayLength !== undefined) bindings.set(parameter.name, arrayBinding(parameter.name, parameter.type));
  return bindings;
}

function flattenEventParameters<T extends TinySolParameter>(parameters: readonly T[]): readonly T[] {
  return Object.freeze(parameters.flatMap((parameter) => parameter.type.arrayLength === undefined ? [parameter] : elementNames(parameter.name, parameter.type.arrayLength).map((name) => Object.freeze({ ...parameter, name: name.replace("$", "."), type: elementType(parameter.type) }) as T)));
}

function containsArray(block: TinySolBlock): boolean {
  return block.statements.some((statement) => statement.kind === "VariableDeclaration" && statement.type.arrayLength !== undefined
    || statement.kind === "TupleAssignment" && statement.bindings.some((binding) => binding.type?.arrayLength !== undefined)
    || statement.kind === "Block" && containsArray(statement)
    || statement.kind === "IfStatement" && (containsArray(statement.consequent) || statement.alternate !== undefined && containsArray(statement.alternate))
    || statement.kind === "WhileStatement" && containsArray(statement.body)
    || statement.kind === "ForStatement" && containsArray(statement.body));
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

export function lowerFixedArrays(program: TinySolProgram): TinySolProgram {
  const functions = new Map(program.contract.functions.map((fn) => [fn.name, Object.freeze({ parameters: Object.freeze(fn.parameters.map((parameter) => parameter.type)), returns: fn.returns })]));
  const interfaces = new Map(program.interfaces.map((item) => [item.name, new Map(item.functions.map((fn) => [fn.name, Object.freeze({ parameters: fn.parameters, returns: fn.returns })]))]));
  const constructors = new Map(program.interfaces.flatMap((item) => item.constructor?.kind === "InterfaceConstructor" ? [[item.name, item.constructor.parameters] as const] : []));
  const context: LoweringContext = {
    functions,
    interfaces,
    constructors,
    events: new Map(program.contract.events.map((event) => [event.name, event.parameters.map((parameter) => parameter.type)])),
    errors: new Map(program.contract.errors.map((error) => [error.name, error.parameters.map((parameter) => parameter.type)])),
    stateArrays: new Map(program.contract.stateVariables.flatMap((state) => state.type.kind === "ScalarType" && state.type.arrayLength !== undefined ? [[state.name, state.type] as const] : [])),
    mappingArrays: new Map(program.contract.stateVariables.flatMap((state) => state.type.kind === "MappingType" && state.type.valueType.arrayLength !== undefined ? [[state.name, Object.freeze({ keyType: state.type.keyType, valueType: state.type.valueType })] as const] : [])),
    temporary: 0
  };
  for (const item of program.interfaces) {
    if (item.constructor?.kind === "InterfaceConstructor" && item.constructor.parameters.some((type) => type.arrayLength !== undefined) && flattenTypes(item.constructor.parameters).length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(item.constructor.span), details: { resource: "create-input-words", maximum: TINYSOL_LIMITS.parameters } });
    for (const fn of item.functions) {
      if (!fn.parameters.some((type) => type.arrayLength !== undefined) && !fn.returns.some((type) => type.arrayLength !== undefined)) continue;
      const inputs = flattenTypes(fn.parameters).length; const outputs = flattenTypes(fn.returns).length;
      if (inputs > 23) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(fn.span), details: { resource: "call-input-words", actual: inputs, maximum: 23 } });
      if (outputs > 8) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(fn.span), details: { resource: "call-output-words", actual: outputs, maximum: 8 } });
    }
  }
  for (const event of program.contract.events) if (event.parameters.some((parameter) => parameter.type.arrayLength !== undefined) && flattenEventParameters(event.parameters).length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(event.span), details: { resource: "event-words", maximum: TINYSOL_LIMITS.parameters } });
  for (const error of program.contract.errors) if (error.parameters.some((parameter) => parameter.type.arrayLength !== undefined) && flattenEventParameters(error.parameters).length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(error.span), details: { resource: "error-words", maximum: TINYSOL_LIMITS.parameters } });
  const loweredFunctions = program.contract.functions.map((fn) => {
    const hasArray = fn.parameters.some((parameter) => parameter.type.arrayLength !== undefined) || fn.returns.some((type) => type.arrayLength !== undefined) || containsArray(fn.body);
    const parameters = flattenParameters(fn.parameters); const returns = flattenTypes(fn.returns); const body = transformBlock(fn.body, bindingsForParameters(fn.parameters), fn.returns, context);
    if (hasArray) {
      const inputMaximum = fn.visibility === "internal" ? 31 : TINYSOL_LIMITS.parameters;
      if (parameters.length > inputMaximum) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(fn.span), details: { resource: "function-input-words", actual: parameters.length, maximum: inputMaximum } });
      if (returns.length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(fn.span), details: { resource: "function-output-words", actual: returns.length, maximum: TINYSOL_LIMITS.parameters } });
      const maximum = fn.visibility === "internal" ? 31 : 128; const actual = parameters.length + localWords(body);
      if (actual > maximum) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(fn.span), details: { resource: "local-words", actual, maximum } });
    }
    return Object.freeze({ ...fn, parameters, returns, body });
  });
  const constructor = program.contract.constructor?.kind !== "ConstructorDeclaration" ? undefined : (() => {
    const declaration = program.contract.constructor; const parameters = flattenParameters(declaration.parameters); const body = transformBlock(declaration.body, bindingsForParameters(declaration.parameters), [], context);
    if (declaration.parameters.some((parameter) => parameter.type.arrayLength !== undefined) || containsArray(declaration.body)) {
      if (parameters.length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(declaration.span), details: { resource: "constructor-input-words", actual: parameters.length, maximum: TINYSOL_LIMITS.parameters } });
      const actual = parameters.length + localWords(body); if (actual > 128) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...at(declaration.span), details: { resource: "local-words", actual, maximum: 128 } });
    }
    return Object.freeze({ ...declaration, parameters, body });
  })();
  const stateVariables = Object.freeze(program.contract.stateVariables.map((state) => {
    if (state.type.kind !== "MappingType" || state.type.valueType.arrayLength === undefined) return state;
    const items = dimensions(state.type.valueType); const valueType = elementType(state.type.valueType);
    return Object.freeze({ ...state, type: Object.freeze({ ...state.type, valueType, valueArrayLength: state.type.valueType.arrayLength, ...(items.length === 1 ? {} : { valueArrayDimensions: items }) }) });
  }));
  const contract = Object.freeze({
    ...program.contract,
    stateVariables,
    ...(constructor === undefined ? {} : { constructor }),
    functions: Object.freeze(loweredFunctions)
  });
  const events = Object.freeze(program.contract.events.map((event) => Object.freeze({ ...event, parameters: flattenEventParameters(event.parameters) })));
  const errors = Object.freeze(program.contract.errors.map((error) => Object.freeze({ ...error, parameters: flattenEventParameters(error.parameters) })));
  const loweredContract = Object.freeze({ ...contract, events, errors });
  const loweredInterfaces = Object.freeze(program.interfaces.map((item) => Object.freeze({
    ...item,
    ...(item.constructor?.kind !== "InterfaceConstructor" ? {} : { constructor: Object.freeze({ ...item.constructor, parameters: flattenTypes(item.constructor.parameters) }) }),
    functions: Object.freeze(item.functions.map((fn) => Object.freeze({ ...fn, parameters: flattenTypes(fn.parameters), returns: flattenTypes(fn.returns) })))
  })));
  return Object.freeze({ ...program, interfaces: loweredInterfaces, contract: loweredContract });
}
