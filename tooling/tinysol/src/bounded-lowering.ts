import { ToolchainErrorCode, fail } from "./errors.js";
import type {
  SourceSpan,
  TinySolAssignableExpression,
  TinySolBlock,
  TinySolExpression,
  TinySolMappingTypeNode,
  TinySolParameter,
  TinySolProgram,
  TinySolScalarTypeNode,
  TinySolStatement,
  TinySolStructDeclaration,
  TinySolTypeNode
} from "./compiler-types.js";

interface CollectionBinding {
  readonly type: TinySolScalarTypeNode;
  readonly mode: "local" | "storage" | "mapping" | "member";
}

interface CollectionReference {
  readonly binding: CollectionBinding;
  readonly logical: TinySolExpression;
  readonly length: TinySolExpression;
  readonly data: TinySolExpression;
}

interface CallableShape {
  readonly parameters: readonly TinySolScalarTypeNode[];
  readonly returns: readonly TinySolScalarTypeNode[];
}

interface Context {
  readonly structs: ReadonlyMap<string, TinySolStructDeclaration>;
  readonly functions: ReadonlyMap<string, CallableShape>;
  readonly interfaces: ReadonlyMap<string, ReadonlyMap<string, CallableShape>>;
  readonly constructors: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly events: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly errors: ReadonlyMap<string, readonly TinySolScalarTypeNode[]>;
  readonly stateTypes: ReadonlyMap<string, TinySolTypeNode>;
  temporary: number;
}

function at(span: SourceSpan) { return { line: span.start.line, column: span.start.column, offset: span.start.byteOffset }; }
function collection(type: TinySolScalarTypeNode | undefined): type is TinySolScalarTypeNode & { readonly boundedKind: "vector" | "bytes" | "string"; readonly capacity: number } { return type?.boundedKind !== undefined && type.capacity !== undefined; }
function plain(type: TinySolScalarTypeNode): TinySolScalarTypeNode {
  const { boundedKind: _kind, capacity: _capacity, ...rest } = type; return Object.freeze(rest);
}
function lengthType(span: SourceSpan): TinySolScalarTypeNode { return Object.freeze({ kind: "ScalarType", name: "uint256", span }); }
function dataType(type: TinySolScalarTypeNode): TinySolScalarTypeNode { return Object.freeze({ ...plain(type), arrayLength: type.capacity! }); }
function id(name: string, span: SourceSpan): TinySolExpression { return Object.freeze({ kind: "IdentifierExpression", name, span }); }
function integer(value: number, span: SourceSpan): TinySolExpression { return Object.freeze({ kind: "LiteralExpression", literalKind: "integer", value: String(value), span }); }
function zero(type: TinySolScalarTypeNode, span: SourceSpan, structs: ReadonlyMap<string, TinySolStructDeclaration>): TinySolExpression {
  if (type.userType !== undefined) {
    const declaration = structs.get(type.userType); if (declaration === undefined) return integer(0, span);
    return Object.freeze({ kind: "StructLiteralExpression", structName: type.userType, fields: Object.freeze(declaration.fields.flatMap((field) => collection(field.type) ? [
      Object.freeze({ name: `${field.name}$length`, value: integer(0, span), span }), Object.freeze({ name: `${field.name}$data`, value: emptyCollectionLiteral(field.type, span, structs), span })
    ] : [Object.freeze({ name: field.name, value: zero(field.type, span, structs), span })])), span });
  }
  return Object.freeze({ kind: "LiteralExpression", literalKind: type.name === "bool" ? "bool" : "integer", value: type.name === "bool" ? "false" : "0", span });
}
function emptyCollectionLiteral(type: TinySolScalarTypeNode, span: SourceSpan, structs: ReadonlyMap<string, TinySolStructDeclaration>): TinySolExpression {
  return Object.freeze({ kind: "ArrayLiteralExpression", elements: Object.freeze(Array.from({ length: type.capacity! }, () => zero(plain(type), span, structs))), span });
}
function index(object: TinySolExpression, atIndex: TinySolExpression, span: SourceSpan): TinySolExpression {
  return Object.freeze({ kind: "IndexExpression", object: object as Extract<TinySolExpression, { readonly kind: "IdentifierExpression" | "IndexExpression" | "MemberExpression" }>, index: atIndex, span });
}
function member(object: TinySolExpression, name: string, span: SourceSpan): TinySolExpression {
  return Object.freeze({ kind: "MemberExpression", object: object as Extract<TinySolExpression, { readonly kind: "IdentifierExpression" | "IndexExpression" | "MemberExpression" }>, member: name, span });
}
function assignment(target: TinySolExpression, value: TinySolExpression, span: SourceSpan): TinySolStatement {
  return Object.freeze({ kind: "Assignment", target: target as TinySolAssignableExpression, value, span });
}
function requireStatement(condition: TinySolExpression, span: SourceSpan): TinySolStatement { return Object.freeze({ kind: "RequireStatement", condition, span }); }
function binary(operator: string, left: TinySolExpression, right: TinySolExpression, span: SourceSpan): TinySolExpression { return Object.freeze({ kind: "BinaryExpression", operator, left, right, span }); }
function sameCollection(left: TinySolScalarTypeNode, right: TinySolScalarTypeNode): boolean { return left.boundedKind === right.boundedKind && left.capacity === right.capacity && left.name === right.name && left.userType === right.userType; }
function collectionGuards(length: TinySolExpression, data: TinySolExpression, type: TinySolScalarTypeNode, span: SourceSpan): readonly TinySolStatement[] {
  const guards: TinySolStatement[] = [requireStatement(binary("<=", length, integer(type.capacity!, span), span), span)];
  if (type.userType === undefined) for (let item = 0; item < type.capacity!; item += 1) guards.push(requireStatement(binary("||", binary("<", integer(item, span), length, span), binary("==", index(data, integer(item, span), span), zero(plain(type), span, new Map()), span), span), span));
  return Object.freeze(guards);
}

function expandType(type: TinySolScalarTypeNode): readonly TinySolScalarTypeNode[] { return collection(type) ? Object.freeze([lengthType(type.span), dataType(type)]) : Object.freeze([type]); }
function expandParameter<T extends TinySolParameter>(parameter: T): readonly T[] {
  if (!collection(parameter.type)) return Object.freeze([parameter]);
  return Object.freeze([
    Object.freeze({ ...parameter, name: `${parameter.name}$length`, type: lengthType(parameter.type.span) }) as T,
    Object.freeze({ ...parameter, name: `${parameter.name}$data`, type: dataType(parameter.type) }) as T
  ]);
}

function rootName(expression: TinySolExpression): string | undefined {
  let current = expression;
  while (current.kind === "IndexExpression" || current.kind === "MemberExpression") current = current.object;
  return current.kind === "IdentifierExpression" ? current.name : undefined;
}

function nominalType(expression: TinySolExpression, nominals: ReadonlyMap<string, TinySolScalarTypeNode>, context: Context): string | undefined {
  if (expression.kind === "IdentifierExpression") return nominals.get(expression.name)?.userType;
  if (expression.kind === "IndexExpression") {
    const root = rootName(expression); const state = root === undefined ? undefined : context.stateTypes.get(root);
    if (state?.kind === "MappingType") return state.valueType.userType;
    return nominalType(expression.object, nominals, context);
  }
  if (expression.kind === "MemberExpression") {
    const owner = nominalType(expression.object, nominals, context); const declaration = owner === undefined ? undefined : context.structs.get(owner);
    return declaration?.fields.find((field) => field.name === expression.member)?.type.userType;
  }
  return undefined;
}

function memberCollectionType(expression: TinySolExpression, nominals: ReadonlyMap<string, TinySolScalarTypeNode>, context: Context): TinySolScalarTypeNode | undefined {
  if (expression.kind !== "MemberExpression") return undefined;
  const owner = nominalType(expression.object, nominals, context); const declaration = owner === undefined ? undefined : context.structs.get(owner);
  const type = declaration?.fields.find((field) => field.name === expression.member)?.type;
  return collection(type) ? type : undefined;
}

function collectionReference(expression: TinySolExpression, bindings: ReadonlyMap<string, CollectionBinding>, nominals: ReadonlyMap<string, TinySolScalarTypeNode>, context: Context): CollectionReference | undefined {
  if (expression.kind === "IdentifierExpression") {
    const binding = bindings.get(expression.name); if (binding === undefined) return undefined;
    return Object.freeze({ binding, logical: expression, length: id(`${expression.name}$length`, expression.span), data: id(`${expression.name}$data`, expression.span) });
  }
  if (expression.kind === "IndexExpression" && expression.object.kind === "IdentifierExpression") {
    const binding = bindings.get(expression.object.name); if (binding?.mode !== "mapping") return undefined;
    return Object.freeze({ binding, logical: expression, length: index(id(`${expression.object.name}$length`, expression.span), expression.index, expression.span), data: index(id(`${expression.object.name}$data`, expression.span), expression.index, expression.span) });
  }
  const type = memberCollectionType(expression, nominals, context);
  if (type !== undefined && expression.kind === "MemberExpression") {
    const binding: CollectionBinding = Object.freeze({ type, mode: "member" });
    return Object.freeze({ binding, logical: expression, length: member(expression.object, `${expression.member}$length`, expression.span), data: member(expression.object, `${expression.member}$data`, expression.span) });
  }
  return undefined;
}

function encodedString(value: string, type: TinySolScalarTypeNode, span: SourceSpan): readonly TinySolExpression[] {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > type.capacity!) fail(ToolchainErrorCode.ARRAY_LENGTH_INVALID, { ...at(span), details: { actual: bytes.length, maximum: type.capacity!, type: type.boundedKind! } });
  return Object.freeze([...bytes].map((value) => integer(value, span)));
}

function literalElements(expression: TinySolExpression, type: TinySolScalarTypeNode): readonly TinySolExpression[] | undefined {
  if (expression.kind === "StringLiteralExpression") {
    if (type.boundedKind !== "string" && type.boundedKind !== "bytes") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: "string", expected: type.boundedKind! } });
    return encodedString(expression.value, type, expression.span);
  }
  if (expression.kind === "ArrayLiteralExpression") {
    if (expression.elements.length > type.capacity!) fail(ToolchainErrorCode.ARRAY_LENGTH_INVALID, { ...at(expression.span), details: { actual: expression.elements.length, maximum: type.capacity! } });
    return expression.elements;
  }
  return undefined;
}

function stabilize(value: TinySolExpression, output: TinySolStatement[], context: Context): TinySolExpression {
  if (value.kind === "IdentifierExpression" || value.kind === "LiteralExpression") return value;
  const name = `$boundedIndex${context.temporary++}`; output.push(Object.freeze({ kind: "VariableDeclaration", name, type: lengthType(value.span), initializer: value, span: value.span })); return id(name, value.span);
}

function transformBlock(block: TinySolBlock, inheritedBindings: ReadonlyMap<string, CollectionBinding>, inheritedNominals: ReadonlyMap<string, TinySolScalarTypeNode>, returns: readonly TinySolScalarTypeNode[], context: Context): TinySolBlock {
  const bindings = new Map(inheritedBindings); const nominals = new Map(inheritedNominals); const output: TinySolStatement[] = [];

  const mapExpression = (expression: TinySolExpression, statements: TinySolStatement[] = output): TinySolExpression => {
    if (expression.kind === "StringLiteralExpression") fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(expression.span), details: { actual: "string", expected: "bounded string or bytes" } });
    if (expression.kind === "MethodCallExpression") fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(expression.span), details: { operation: expression.method, reason: "method-call-expression" } });
    if (expression.kind === "LiteralExpression" || expression.kind === "IdentifierExpression" || expression.kind === "ContextExpression") return expression;
    if (expression.kind === "MemberExpression") {
      const reference = collectionReference(expression.object, bindings, nominals, context);
      if (reference !== undefined && expression.member === "length") return mapExpression(reference.length, statements);
      return Object.freeze({ ...expression, object: mapExpression(expression.object, statements) as typeof expression.object });
    }
    if (expression.kind === "IndexExpression") {
      const reference = collectionReference(expression.object, bindings, nominals, context);
      if (reference !== undefined) {
        const mappedIndex = stabilize(mapExpression(expression.index, statements), statements, context); const mappedLength = mapExpression(reference.length, statements);
        statements.push(requireStatement(binary("<", mappedIndex, mappedLength, expression.span), expression.span));
        return index(mapExpression(reference.data, statements), mappedIndex, expression.span);
      }
      return Object.freeze({ ...expression, object: mapExpression(expression.object, statements) as typeof expression.object, index: mapExpression(expression.index, statements) });
    }
    if (expression.kind === "LocalArrayIndexExpression" || expression.kind === "NestedArrayIndexExpression" || expression.kind === "LocalNestedArrayIndexExpression" || expression.kind === "NestedStorageIndexExpression") return expression;
    if (expression.kind === "UnaryExpression") return Object.freeze({ ...expression, operand: mapExpression(expression.operand, statements) });
    if (expression.kind === "BinaryExpression") return Object.freeze({ ...expression, left: mapExpression(expression.left, statements), right: mapExpression(expression.right, statements) });
    if (expression.kind === "ConditionalExpression") return Object.freeze({ ...expression, condition: mapExpression(expression.condition, statements), consequent: mapExpression(expression.consequent, statements), alternate: mapExpression(expression.alternate, statements) });
    if (expression.kind === "CastExpression") return Object.freeze({ ...expression, value: mapExpression(expression.value, statements) });
    if (expression.kind === "ArrayLiteralExpression") return Object.freeze({ ...expression, elements: Object.freeze(expression.elements.map((item) => mapExpression(item, statements))) });
    if (expression.kind === "StructLiteralExpression") {
      const declaration = context.structs.get(expression.structName); const fields: typeof expression.fields[number][] = [];
      for (const field of expression.fields) {
        const expected = declaration?.fields.find((item) => item.name === field.name)?.type;
        if (!collection(expected)) { fields.push(Object.freeze({ ...field, value: mapExpression(field.value, statements) })); continue; }
        const value = collectionValue(field.value, expected, statements); fields.push(Object.freeze({ ...field, name: `${field.name}$length`, value: value.length }), Object.freeze({ ...field, name: `${field.name}$data`, value: value.data }));
      }
      return Object.freeze({ ...expression, fields: Object.freeze(fields) });
    }
    if (expression.kind === "FunctionCallExpression") {
      const shape = context.functions.get(expression.functionName); return Object.freeze({ ...expression, arguments: mapArguments(expression.arguments, shape?.parameters, statements) });
    }
    if (expression.kind === "ExternalCallExpression") {
      const shape = context.interfaces.get(expression.interfaceName)?.get(expression.functionName); return Object.freeze({ ...expression, target: mapExpression(expression.target, statements), arguments: mapArguments(expression.arguments, shape?.parameters, statements) });
    }
    const parameters = context.constructors.get(expression.interfaceName); return Object.freeze({ ...expression, codeHash: mapExpression(expression.codeHash, statements), arguments: mapArguments(expression.arguments, parameters, statements) });
  };

  const mapArguments = (values: readonly TinySolExpression[], parameters: readonly TinySolScalarTypeNode[] | undefined, statements: TinySolStatement[]): readonly TinySolExpression[] => Object.freeze(values.flatMap((value, item) => {
    const expected = parameters?.[item]; if (!collection(expected)) return [mapExpression(value, statements)]; const expanded = collectionValue(value, expected, statements); return [expanded.length, expanded.data];
  }));

  const collectionValue = (value: TinySolExpression, expected: TinySolScalarTypeNode, statements: TinySolStatement[]): { readonly length: TinySolExpression; readonly data: TinySolExpression } => {
    const elements = literalElements(value, expected);
    if (elements !== undefined) {
      const mapped = elements.map((item) => mapExpression(item, statements)); const padding = Array.from({ length: expected.capacity! - mapped.length }, () => zero(plain(expected), value.span, context.structs));
      return Object.freeze({ length: integer(mapped.length, value.span), data: Object.freeze({ kind: "ArrayLiteralExpression", elements: Object.freeze([...mapped, ...padding]), span: value.span }) });
    }
    const reference = collectionReference(value, bindings, nominals, context);
    if (reference !== undefined) {
      if (!sameCollection(reference.binding.type, expected)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: reference.binding.type.boundedKind!, expected: expected.boundedKind! } });
      const mappedData = mapExpression(reference.data, statements);
      const data = reference.binding.mode === "storage"
        ? Object.freeze({ kind: "ArrayLiteralExpression", elements: Object.freeze(Array.from({ length: expected.capacity! }, (_, item) => index(mappedData, integer(item, value.span), value.span))), span: value.span }) as TinySolExpression
        : mappedData;
      return Object.freeze({ length: mapExpression(reference.length, statements), data });
    }
    if (value.kind === "FunctionCallExpression" || value.kind === "ExternalCallExpression") {
      const shape = value.kind === "FunctionCallExpression" ? context.functions.get(value.functionName) : context.interfaces.get(value.interfaceName)?.get(value.functionName);
      if (shape?.returns.length !== 1 || !collection(shape.returns[0]) || !sameCollection(shape.returns[0], expected)) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: "call", expected: expected.boundedKind! } });
      const name = `$boundedCall${context.temporary++}`; const mapped = mapExpression(value, statements);
      statements.push(Object.freeze({ kind: "TupleAssignment", bindings: Object.freeze([
        Object.freeze({ name: `${name}$length`, type: lengthType(value.span), span: value.span }), Object.freeze({ name: `${name}$data`, type: dataType(expected), span: value.span })
      ]), value: mapped as Extract<TinySolExpression, { readonly kind: "FunctionCallExpression" | "ExternalCallExpression" }>, span: value.span }));
      statements.push(...collectionGuards(id(`${name}$length`, value.span), id(`${name}$data`, value.span), expected, value.span));
      return Object.freeze({ length: id(`${name}$length`, value.span), data: id(`${name}$data`, value.span) });
    }
    fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(value.span), details: { actual: "scalar", expected: expected.boundedKind! } });
  };

  const bind = (name: string, type: TinySolScalarTypeNode, mode: CollectionBinding["mode"]): void => { bindings.set(name, Object.freeze({ type, mode })); };

  for (const statement of block.statements) {
    if (statement.kind === "Block") { output.push(transformBlock(statement, bindings, nominals, returns, context)); continue; }
    if (statement.kind === "VariableDeclaration") {
      if (collection(statement.type)) {
        bind(statement.name, statement.type, "local"); const value = statement.initializer === undefined ? undefined : collectionValue(statement.initializer, statement.type, output);
        output.push(Object.freeze({ ...statement, name: `${statement.name}$length`, type: lengthType(statement.type.span), initializer: value?.length ?? integer(0, statement.span) }));
        output.push(Object.freeze({ ...statement, name: `${statement.name}$data`, type: dataType(statement.type), ...(value === undefined ? {} : { initializer: value.data }) })); continue;
      }
      if (statement.type.userType !== undefined) nominals.set(statement.name, statement.type);
      output.push(Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: mapExpression(statement.initializer) }) })); continue;
    }
    if (statement.kind === "Assignment") {
      const whole = collectionReference(statement.target, bindings, nominals, context);
      if (whole !== undefined) {
        if (statement.operator !== undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(statement.span), details: { operation: statement.operator, type: whole.binding.type.boundedKind! } });
        const value = collectionValue(statement.value, whole.binding.type, output); const temporary = `$boundedValue${context.temporary++}`;
        output.push(Object.freeze({ kind: "VariableDeclaration", name: `${temporary}$length`, type: lengthType(statement.span), initializer: value.length, span: statement.span }));
        output.push(Object.freeze({ kind: "VariableDeclaration", name: `${temporary}$data`, type: dataType(whole.binding.type), initializer: value.data, span: statement.span }));
        output.push(assignment(mapExpression(whole.length), id(`${temporary}$length`, statement.span), statement.span));
        if (whole.binding.mode === "storage" || whole.binding.mode === "member") for (let item = 0; item < whole.binding.type.capacity!; item += 1) output.push(assignment(index(mapExpression(whole.data), integer(item, statement.span), statement.span), index(id(`${temporary}$data`, statement.span), integer(item, statement.span), statement.span), statement.span));
        else output.push(assignment(mapExpression(whole.data), id(`${temporary}$data`, statement.span), statement.span));
        continue;
      }
      if (statement.target.kind === "IndexExpression") {
        const reference = collectionReference(statement.target.object, bindings, nominals, context);
        if (reference !== undefined) {
          const atIndex = stabilize(mapExpression(statement.target.index), output, context); const length = mapExpression(reference.length); const data = mapExpression(reference.data);
          output.push(requireStatement(binary("<", atIndex, integer(reference.binding.type.capacity!, statement.span), statement.span), statement.span));
          output.push(Object.freeze({ kind: "IfStatement", condition: binary(">=", atIndex, length, statement.span), consequent: Object.freeze({ kind: "Block", statements: Object.freeze([assignment(length, binary("+", atIndex, integer(1, statement.span), statement.span), statement.span)]), span: statement.span }), span: statement.span }));
          output.push(Object.freeze({ ...statement, target: index(data, atIndex, statement.target.span) as TinySolAssignableExpression, value: mapExpression(statement.value) })); continue;
        }
      }
      output.push(Object.freeze({ ...statement, target: mapExpression(statement.target) as TinySolAssignableExpression, value: mapExpression(statement.value) })); continue;
    }
    if (statement.kind === "DeleteStatement") {
      const whole = collectionReference(statement.target, bindings, nominals, context);
      if (whole !== undefined) {
        output.push(assignment(mapExpression(whole.length), integer(0, statement.span), statement.span));
        if (whole.binding.mode === "storage" || whole.binding.mode === "member") for (let item = 0; item < whole.binding.type.capacity!; item += 1) output.push(Object.freeze({ ...statement, target: index(mapExpression(whole.data), integer(item, statement.span), statement.span) as TinySolAssignableExpression }));
        else output.push(Object.freeze({ ...statement, target: mapExpression(whole.data) as TinySolAssignableExpression }));
        continue;
      }
      if (statement.target.kind === "IndexExpression") {
        const reference = collectionReference(statement.target.object, bindings, nominals, context);
        if (reference !== undefined) { const atIndex = stabilize(mapExpression(statement.target.index), output, context); output.push(requireStatement(binary("<", atIndex, mapExpression(reference.length), statement.span), statement.span), Object.freeze({ ...statement, target: index(mapExpression(reference.data), atIndex, statement.span) as TinySolAssignableExpression })); continue; }
      }
      output.push(Object.freeze({ ...statement, target: mapExpression(statement.target) as TinySolAssignableExpression })); continue;
    }
    if (statement.kind === "ExpressionStatement" && statement.expression.kind === "MethodCallExpression") {
      const call = statement.expression; const reference = collectionReference(call.object, bindings, nominals, context);
      if (reference === undefined) fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(call.span), details: { operation: call.method, reason: "non-collection" } });
      const lengthTarget = mapExpression(reference.length); const length = reference.binding.mode === "mapping" ? stabilize(lengthTarget, output, context) : lengthTarget; const data = mapExpression(reference.data);
      if (call.method === "push") {
        if (call.arguments.length !== 1) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(call.span), details: { actual: call.arguments.length, expected: 1 } });
        output.push(requireStatement(binary("<", length, integer(reference.binding.type.capacity!, call.span), call.span), call.span));
        output.push(assignment(index(data, length, call.span), mapExpression(call.arguments[0]!), call.span));
        output.push(assignment(lengthTarget, binary("+", length, integer(1, call.span), call.span), call.span)); continue;
      }
      if (call.method === "pop") {
        if (call.arguments.length !== 0) fail(ToolchainErrorCode.TYPE_MISMATCH, { ...at(call.span), details: { actual: call.arguments.length, expected: 0 } });
        output.push(requireStatement(binary(">", length, integer(0, call.span), call.span), call.span));
        const nextLength = stabilize(binary("-", length, integer(1, call.span), call.span), output, context); output.push(assignment(lengthTarget, nextLength, call.span));
        output.push(Object.freeze({ kind: "DeleteStatement", target: index(data, nextLength, call.span) as TinySolAssignableExpression, span: call.span })); continue;
      }
      fail(ToolchainErrorCode.INVALID_OPERATION, { ...at(call.span), details: { operation: call.method, reason: "unknown-collection-method" } });
    }
    if (statement.kind === "TupleAssignment") {
      const shape = statement.value.kind === "FunctionCallExpression" ? context.functions.get(statement.value.functionName) : context.interfaces.get(statement.value.interfaceName)?.get(statement.value.functionName);
      const expanded: typeof statement.bindings[number][] = [];
      statement.bindings.forEach((item, position) => {
        const expected = item.type ?? shape?.returns[position];
        if (!collection(expected)) { expanded.push(Object.freeze({ ...item, ...(item.type === undefined ? {} : { type: plain(item.type) }) })); return; }
        bind(item.name, expected, "local"); expanded.push(Object.freeze({ ...item, name: `${item.name}$length`, ...(item.type === undefined ? {} : { type: lengthType(item.span) }) }), Object.freeze({ ...item, name: `${item.name}$data`, ...(item.type === undefined ? {} : { type: dataType(expected) }) }));
      });
      output.push(Object.freeze({ ...statement, bindings: Object.freeze(expanded), value: mapExpression(statement.value) as typeof statement.value })); continue;
    }
    if (statement.kind === "IfStatement") { output.push(Object.freeze({ ...statement, condition: mapExpression(statement.condition), consequent: transformBlock(statement.consequent, bindings, nominals, returns, context), ...(statement.alternate === undefined ? {} : { alternate: transformBlock(statement.alternate, bindings, nominals, returns, context) }) })); continue; }
    if (statement.kind === "WhileStatement") { output.push(Object.freeze({ ...statement, condition: mapExpression(statement.condition), body: transformBlock(statement.body, bindings, nominals, returns, context) })); continue; }
    if (statement.kind === "ForStatement") {
      if (statement.initializer?.kind === "VariableDeclaration" && collection(statement.initializer.type)) {
        const initializer = transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([statement.initializer]), span: statement.initializer.span }), bindings, nominals, returns, context); bind(statement.initializer.name, statement.initializer.type, "local");
        const { initializer: _initializer, ...rest } = statement; const loop: TinySolStatement = Object.freeze({ ...rest, ...(statement.condition === undefined ? {} : { condition: mapExpression(statement.condition) }), ...(statement.update === undefined ? {} : { update: transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([statement.update]), span: statement.update.span }), bindings, nominals, returns, context).statements[0] as typeof statement.update }), body: transformBlock(statement.body, bindings, nominals, returns, context) });
        output.push(Object.freeze({ kind: "Block", statements: Object.freeze([...initializer.statements, loop]), span: statement.span })); continue;
      }
      const one = (item: TinySolStatement | undefined) => item === undefined ? undefined : transformBlock(Object.freeze({ kind: "Block", statements: Object.freeze([item]), span: item.span }), bindings, nominals, returns, context).statements[0];
      output.push(Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: one(statement.initializer) as typeof statement.initializer }), ...(statement.condition === undefined ? {} : { condition: mapExpression(statement.condition) }), ...(statement.update === undefined ? {} : { update: one(statement.update) as typeof statement.update }), body: transformBlock(statement.body, bindings, nominals, returns, context) })); continue;
    }
    if (statement.kind === "ReturnStatement") {
      const values: TinySolExpression[] = []; statement.values.forEach((value, position) => { const expected = returns[position]; if (!collection(expected)) values.push(mapExpression(value)); else { const expanded = collectionValue(value, expected, output); values.push(expanded.length, expanded.data); } });
      output.push(Object.freeze({ ...statement, values: Object.freeze(values) })); continue;
    }
    if (statement.kind === "RequireStatement") { output.push(Object.freeze({ ...statement, condition: mapExpression(statement.condition) })); continue; }
    if (statement.kind === "RevertStatement") { output.push(Object.freeze({ ...statement, ...(statement.arguments === undefined ? {} : { arguments: mapArguments(statement.arguments, statement.errorName === undefined ? undefined : context.errors.get(statement.errorName), output) }) })); continue; }
    if (statement.kind === "EmitStatement") { output.push(Object.freeze({ ...statement, arguments: mapArguments(statement.arguments, context.events.get(statement.eventName), output) })); continue; }
    if (statement.kind === "ExpressionStatement") { output.push(Object.freeze({ ...statement, expression: mapExpression(statement.expression) })); continue; }
    output.push(statement);
  }
  return Object.freeze({ ...block, statements: Object.freeze(output) });
}

function expandStruct(declaration: TinySolStructDeclaration): TinySolStructDeclaration {
  return Object.freeze({ ...declaration, fields: Object.freeze(declaration.fields.flatMap((field) => collection(field.type) ? [
    Object.freeze({ ...field, name: `${field.name}$length`, type: lengthType(field.type.span) }),
    Object.freeze({ ...field, name: `${field.name}$data`, type: dataType(field.type) })
  ] : [field])) });
}

function expandState(name: string, type: TinySolTypeNode, span: SourceSpan): readonly TinySolProgram["contract"]["stateVariables"][number][] {
  if (type.kind === "ScalarType" && collection(type)) return Object.freeze([
    Object.freeze({ kind: "StateVariable", name: `${name}$length`, type: lengthType(type.span), span }),
    Object.freeze({ kind: "StateVariable", name: `${name}$data`, type: dataType(type), span })
  ]);
  if (type.kind === "MappingType" && collection(type.valueType)) {
    const mapping = (valueType: TinySolScalarTypeNode): TinySolMappingTypeNode => Object.freeze({ ...type, valueType });
    return Object.freeze([
      Object.freeze({ kind: "StateVariable", name: `${name}$length`, type: mapping(lengthType(type.valueType.span)), span }),
      Object.freeze({ kind: "StateVariable", name: `${name}$data`, type: mapping(dataType(type.valueType)), span })
    ]);
  }
  return Object.freeze([Object.freeze({ kind: "StateVariable", name, type, span })]);
}

export function lowerBoundedCollections(program: TinySolProgram): TinySolProgram {
  const structs = new Map(program.contract.structs.map((item) => [item.name, item]));
  const functions = new Map(program.contract.functions.map((fn) => [fn.name, Object.freeze({ parameters: Object.freeze(fn.parameters.map((item) => item.type)), returns: fn.returns })]));
  const interfaces = new Map(program.interfaces.map((item) => [item.name, new Map(item.functions.map((fn) => [fn.name, Object.freeze({ parameters: fn.parameters, returns: fn.returns })]))]));
  const constructors = new Map(program.interfaces.flatMap((item) => item.constructor?.kind === "InterfaceConstructor" ? [[item.name, item.constructor.parameters] as const] : []));
  const events = new Map(program.contract.events.map((item) => [item.name, Object.freeze(item.parameters.map((parameter) => parameter.type))]));
  const errors = new Map(program.contract.errors.map((item) => [item.name, Object.freeze(item.parameters.map((parameter) => parameter.type))]));
  const stateTypes = new Map(program.contract.stateVariables.map((item) => [item.name, item.type]));
  const context: Context = { structs, functions, interfaces, constructors, events, errors, stateTypes, temporary: 0 };
  const stateBindings = new Map<string, CollectionBinding>(); const stateNominals = new Map<string, TinySolScalarTypeNode>();
  for (const state of program.contract.stateVariables) {
    if (state.type.kind === "ScalarType") { if (collection(state.type)) stateBindings.set(state.name, Object.freeze({ type: state.type, mode: "storage" })); if (state.type.userType !== undefined) stateNominals.set(state.name, state.type); }
    else { if (collection(state.type.valueType)) stateBindings.set(state.name, Object.freeze({ type: state.type.valueType, mode: "mapping" })); if (state.type.valueType.userType !== undefined) stateNominals.set(state.name, state.type.valueType); }
  }
  const lowerCallable = <T extends TinySolProgram["contract"]["functions"][number] | NonNullable<TinySolProgram["contract"]["constructor"]>>(fn: T): T => {
    const bindings = new Map(stateBindings); const nominals = new Map(stateNominals);
    for (const parameter of fn.parameters) { if (collection(parameter.type)) bindings.set(parameter.name, Object.freeze({ type: parameter.type, mode: "local" })); if (parameter.type.userType !== undefined) nominals.set(parameter.name, parameter.type); }
    const returns = "returns" in fn ? fn.returns : Object.freeze([]); let body = transformBlock(fn.body, bindings, nominals, returns, context);
    if (!("visibility" in fn) || fn.visibility === "external") {
      const guards = fn.parameters.flatMap((parameter) => collection(parameter.type) ? collectionGuards(id(`${parameter.name}$length`, parameter.span), id(`${parameter.name}$data`, parameter.span), parameter.type, parameter.span) : []);
      if (guards.length > 0) body = Object.freeze({ ...body, statements: Object.freeze([...guards, ...body.statements]) });
    }
    return Object.freeze({ ...fn, parameters: Object.freeze(fn.parameters.flatMap(expandParameter)), ...("returns" in fn ? { returns: Object.freeze(fn.returns.flatMap(expandType)) } : {}), body }) as unknown as T;
  };
  const contract = program.contract;
  const loweredContract = Object.freeze({ ...contract,
    structs: Object.freeze(contract.structs.map(expandStruct)),
    stateVariables: Object.freeze(contract.stateVariables.flatMap((state) => expandState(state.name, state.type, state.span))),
    events: Object.freeze(contract.events.map((event) => Object.freeze({ ...event, parameters: Object.freeze(event.parameters.flatMap(expandParameter)) }))),
    errors: Object.freeze(contract.errors.map((error) => Object.freeze({ ...error, parameters: Object.freeze(error.parameters.flatMap(expandParameter)) }))),
    ...(contract.constructor?.kind !== "ConstructorDeclaration" ? {} : { constructor: lowerCallable(contract.constructor) }),
    functions: Object.freeze(contract.functions.map(lowerCallable))
  });
  const loweredInterfaces = Object.freeze(program.interfaces.map((item) => Object.freeze({ ...item,
    ...(item.constructor?.kind !== "InterfaceConstructor" ? {} : { constructor: Object.freeze({ ...item.constructor, parameters: Object.freeze(item.constructor.parameters.flatMap(expandType)) }) }),
    functions: Object.freeze(item.functions.map((fn) => Object.freeze({ ...fn, parameters: Object.freeze(fn.parameters.flatMap(expandType)), returns: Object.freeze(fn.returns.flatMap(expandType)) })))
  })));
  return Object.freeze({ ...program, interfaces: loweredInterfaces, contract: loweredContract });
}
