import { ToolchainErrorCode, fail } from "./errors.js";
import type { SourceSpan, TinySolBlock, TinySolExpression, TinySolMappingTypeNode, TinySolProgram, TinySolScalarTypeNode, TinySolStatement, TinySolStructDeclaration } from "./compiler-types.js";

interface MappingPath { readonly path: string; readonly type: TinySolMappingTypeNode; readonly span: SourceSpan }
function at(span: SourceSpan) { return { line: span.start.line, column: span.start.column, offset: span.start.byteOffset }; }

function memberPath(expression: TinySolExpression): { readonly root: string; readonly fields: readonly string[] } | undefined {
  const fields: string[] = []; let current = expression;
  while (current.kind === "MemberExpression") { fields.unshift(current.member); current = current.object; }
  return current.kind === "IdentifierExpression" ? Object.freeze({ root: current.name, fields: Object.freeze(fields) }) : undefined;
}

export function lowerStructMappingFields(program: TinySolProgram): TinySolProgram {
  const structs = new Map(program.contract.structs.map((item) => [item.name, item]));
  const cache = new Map<string, boolean>();
  const containsMapping = (name: string, visiting: readonly string[] = []): boolean => {
    const known = cache.get(name); if (known !== undefined) return known;
    if (visiting.includes(name)) return false; const declaration = structs.get(name); if (declaration === undefined) return false;
    const result = declaration.fields.some((field) => field.mappingType !== undefined || field.type.userType !== undefined && containsMapping(field.type.userType, [...visiting, name])); cache.set(name, result); return result;
  };
  const collect = (name: string, prefix = "", visiting: readonly string[] = []): readonly MappingPath[] => {
    if (visiting.includes(name)) return Object.freeze([]); const declaration = structs.get(name); if (declaration === undefined) return Object.freeze([]); const output: MappingPath[] = [];
    for (const field of declaration.fields) {
      const path = prefix.length === 0 ? field.name : `${prefix}.${field.name}`;
      if (field.mappingType !== undefined) output.push(Object.freeze({ path, type: field.mappingType, span: field.span }));
      else if (field.type.userType !== undefined) {
        if (field.type.arrayLength !== undefined && containsMapping(field.type.userType)) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(field.span), details: { feature: "mapping-field-in-struct-array" } });
        output.push(...collect(field.type.userType, path, [...visiting, name]));
      }
    }
    return Object.freeze(output);
  };
  const generated = new Map<string, MappingPath>();
  const extraStates: TinySolProgram["contract"]["stateVariables"][number][] = [];
  for (const state of program.contract.stateVariables) {
    if (state.type.kind !== "ScalarType" || state.type.userType === undefined || !containsMapping(state.type.userType)) continue;
    if (state.type.arrayLength !== undefined) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(state.span), details: { feature: "mapping-field-in-struct-array" } });
    for (const item of collect(state.type.userType)) {
      const name = `${state.name}.${item.path}`; generated.set(name, item); extraStates.push(Object.freeze({ kind: "StateVariable", name, type: item.type, span: item.span }));
    }
  }
  for (const state of program.contract.stateVariables) if (state.type.kind === "MappingType" && state.type.valueType.userType !== undefined && containsMapping(state.type.valueType.userType)) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(state.span), details: { feature: "mapping-field-in-mapping-value" } });
  const assertPortable = (type: TinySolScalarTypeNode, span: SourceSpan): void => { if (type.userType !== undefined && containsMapping(type.userType)) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(span), details: { feature: "mapping-field-storage-only", type: type.userType } }); };
  for (const callable of [...program.contract.functions, ...(program.contract.constructor?.kind === "ConstructorDeclaration" ? [program.contract.constructor] : [])]) {
    callable.parameters.forEach((item) => assertPortable(item.type, item.span)); if ("returns" in callable) callable.returns.forEach((item) => assertPortable(item, item.span));
  }
  for (const item of program.interfaces) { item.constructor?.kind === "InterfaceConstructor" && item.constructor.parameters.forEach((type) => assertPortable(type, type.span)); item.functions.forEach((fn) => { fn.parameters.forEach((type) => assertPortable(type, type.span)); fn.returns.forEach((type) => assertPortable(type, type.span)); }); }
  program.contract.events.forEach((event) => event.parameters.forEach((item) => assertPortable(item.type, item.span))); program.contract.errors.forEach((error) => error.parameters.forEach((item) => assertPortable(item.type, item.span)));

  const mapExpression = (expression: TinySolExpression): TinySolExpression => {
    if (expression.kind === "LiteralExpression" || expression.kind === "StringLiteralExpression" || expression.kind === "IdentifierExpression" || expression.kind === "ContextExpression" || expression.kind === "LocalArrayIndexExpression" || expression.kind === "NestedArrayIndexExpression" || expression.kind === "LocalNestedArrayIndexExpression" || expression.kind === "NestedStorageIndexExpression") return expression;
    if (expression.kind === "IndexExpression") {
      const path = memberPath(expression.object); const logical = path === undefined ? undefined : `${path.root}.${path.fields.join(".")}`;
      if (logical !== undefined && generated.has(logical)) return Object.freeze({ ...expression, object: Object.freeze({ kind: "IdentifierExpression", name: logical, span: expression.object.span }), index: mapExpression(expression.index) });
      return Object.freeze({ ...expression, object: mapExpression(expression.object) as typeof expression.object, index: mapExpression(expression.index) });
    }
    if (expression.kind === "MemberExpression") return Object.freeze({ ...expression, object: mapExpression(expression.object) as typeof expression.object });
    if (expression.kind === "MethodCallExpression") return Object.freeze({ ...expression, object: mapExpression(expression.object) as typeof expression.object, arguments: Object.freeze(expression.arguments.map(mapExpression)) });
    if (expression.kind === "UnaryExpression") return Object.freeze({ ...expression, operand: mapExpression(expression.operand) });
    if (expression.kind === "BinaryExpression") return Object.freeze({ ...expression, left: mapExpression(expression.left), right: mapExpression(expression.right) });
    if (expression.kind === "ConditionalExpression") return Object.freeze({ ...expression, condition: mapExpression(expression.condition), consequent: mapExpression(expression.consequent), alternate: mapExpression(expression.alternate) });
    if (expression.kind === "CastExpression") return Object.freeze({ ...expression, value: mapExpression(expression.value) });
    if (expression.kind === "ArrayLiteralExpression") return Object.freeze({ ...expression, elements: Object.freeze(expression.elements.map(mapExpression)) });
    if (expression.kind === "StructLiteralExpression") { if (containsMapping(expression.structName)) fail(ToolchainErrorCode.UNSUPPORTED_FEATURE, { ...at(expression.span), details: { feature: "mapping-field-storage-only", type: expression.structName } }); return Object.freeze({ ...expression, fields: Object.freeze(expression.fields.map((field) => Object.freeze({ ...field, value: mapExpression(field.value) }))) }); }
    if (expression.kind === "FunctionCallExpression") return Object.freeze({ ...expression, arguments: Object.freeze(expression.arguments.map(mapExpression)) });
    if (expression.kind === "ExternalCallExpression") return Object.freeze({ ...expression, target: mapExpression(expression.target), arguments: Object.freeze(expression.arguments.map(mapExpression)) });
    return Object.freeze({ ...expression, codeHash: mapExpression(expression.codeHash), arguments: Object.freeze(expression.arguments.map(mapExpression)) });
  };
  const mapBlock = (block: TinySolBlock): TinySolBlock => Object.freeze({ ...block, statements: Object.freeze(block.statements.map(mapStatement)) });
  const mapStatement = (statement: TinySolStatement): TinySolStatement => {
    if (statement.kind === "Block") return mapBlock(statement);
    if (statement.kind === "VariableDeclaration") { assertPortable(statement.type, statement.span); return Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: mapExpression(statement.initializer) }) }); }
    if (statement.kind === "Assignment") return Object.freeze({ ...statement, target: mapExpression(statement.target) as typeof statement.target, value: mapExpression(statement.value) });
    if (statement.kind === "DeleteStatement") return Object.freeze({ ...statement, target: mapExpression(statement.target) as typeof statement.target });
    if (statement.kind === "TupleAssignment") { statement.bindings.forEach((item) => item.type !== undefined && assertPortable(item.type, item.span)); return Object.freeze({ ...statement, value: mapExpression(statement.value) as typeof statement.value }); }
    if (statement.kind === "IfStatement") return Object.freeze({ ...statement, condition: mapExpression(statement.condition), consequent: mapBlock(statement.consequent), ...(statement.alternate === undefined ? {} : { alternate: mapBlock(statement.alternate) }) });
    if (statement.kind === "WhileStatement") return Object.freeze({ ...statement, condition: mapExpression(statement.condition), body: mapBlock(statement.body) });
    if (statement.kind === "ForStatement") return Object.freeze({ ...statement, ...(statement.initializer === undefined ? {} : { initializer: mapStatement(statement.initializer) as typeof statement.initializer }), ...(statement.condition === undefined ? {} : { condition: mapExpression(statement.condition) }), ...(statement.update === undefined ? {} : { update: mapStatement(statement.update) as typeof statement.update }), body: mapBlock(statement.body) });
    if (statement.kind === "ReturnStatement") return Object.freeze({ ...statement, values: Object.freeze(statement.values.map(mapExpression)) });
    if (statement.kind === "RequireStatement") return Object.freeze({ ...statement, condition: mapExpression(statement.condition) });
    if (statement.kind === "RevertStatement") return Object.freeze({ ...statement, ...(statement.arguments === undefined ? {} : { arguments: Object.freeze(statement.arguments.map(mapExpression)) }) });
    if (statement.kind === "EmitStatement") return Object.freeze({ ...statement, arguments: Object.freeze(statement.arguments.map(mapExpression)) });
    if (statement.kind === "ExpressionStatement") return Object.freeze({ ...statement, expression: mapExpression(statement.expression) });
    return statement;
  };
  const structsWithoutMappings = Object.freeze(program.contract.structs.map((declaration) => Object.freeze({ ...declaration, fields: Object.freeze(declaration.fields.filter((field) => field.mappingType === undefined)) })));
  const constructor = program.contract.constructor?.kind === "ConstructorDeclaration" ? Object.freeze({ ...program.contract.constructor, body: mapBlock(program.contract.constructor.body) }) : undefined;
  const contract = Object.freeze({ ...program.contract, structs: structsWithoutMappings, stateVariables: Object.freeze([...program.contract.stateVariables, ...extraStates]), ...(constructor === undefined ? {} : { constructor }), functions: Object.freeze(program.contract.functions.map((fn) => Object.freeze({ ...fn, body: mapBlock(fn.body) }))) });
  return Object.freeze({ ...program, contract });
}
