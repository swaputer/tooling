import { ToolchainErrorCode, fail } from "./errors.js";
import { lexTinySol, mergeSpans } from "./lexer.js";
import {
  TINYSOL_LIMITS,
  type SourceSpan,
  type TinySolAssignableExpression,
  type TinySolBlock,
  type TinySolConstructorDeclaration,
  type TinySolContractDeclaration,
  type TinySolCreateExpression,
  type TinySolEventDeclaration,
  type TinySolEventParameter,
  type TinySolExpression,
  type TinySolExpressionStatement,
  type TinySolExternalCallExpression,
  type TinySolForStatement,
  type TinySolFunctionDeclaration,
  type TinySolIdentifierExpression,
  type TinySolIfStatement,
  type TinySolIndexExpression,
  type TinySolInterfaceConstructor,
  type TinySolInterfaceDeclaration,
  type TinySolInterfaceFunction,
  type TinySolMappingTypeNode,
  type TinySolParameter,
  type TinySolProgram,
  type TinySolScalarType,
  type TinySolScalarTypeNode,
  type TinySolStateVariable,
  type TinySolStatement,
  type TinySolToken,
  type TinySolTypeNode,
  type TinySolVariableDeclaration,
  type TinySolWhileStatement
,
  type TinySolFunctionCallExpression
} from "./compiler-types.js";

const SCALAR_TYPES = new Set<TinySolScalarType>(["uint256", "int256", "bool", "bytes32", "account", "address"]);
const CONTEXT_PATHS = new Set([
  "msg.sender", "this.id", "tx.actor", "tx.router", "tx.executor", "tx.recipient", "world.id", "world.executionHeight", "buy.ethIn", "buy.grossTokenOut", "buy.tickAfter",
  "block.number", "block.timestamp", "gas.bytePrice", "gas.bytesUsed", "gas.bytesRemaining"
]);
const PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6,
  "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10
});

class Parser {
  readonly tokens: readonly TinySolToken[];
  readonly sourceName: string;
  index = 0;
  nodes = 0;
  depth = 0;
  loopDepth = 0;

  constructor(tokens: readonly TinySolToken[], sourceName: string) { this.tokens = tokens; this.sourceName = sourceName; }
  node<T>(value: T): T { this.nodes += 1; if (this.nodes > TINYSOL_LIMITS.astNodes) fail(ToolchainErrorCode.AST_LIMIT, { details: { maximum: TINYSOL_LIMITS.astNodes } }); return Object.freeze(value); }
  enter(): void { this.depth += 1; if (this.depth > TINYSOL_LIMITS.nestingDepth) fail(ToolchainErrorCode.NESTING_LIMIT, { details: { maximum: TINYSOL_LIMITS.nestingDepth } }); }
  leave(): void { this.depth -= 1; }
  peek(distance = 0): TinySolToken { return this.tokens[this.index + distance] ?? this.tokens[this.tokens.length - 1]!; }
  take(): TinySolToken { const token = this.peek(); this.index += 1; return token; }
  at(value: string): boolean { return this.peek().value === value; }
  consume(value: string): TinySolToken | undefined { if (!this.at(value)) return undefined; return this.take(); }
  expect(value: string): TinySolToken {
    const token = this.peek();
    if (token.value !== value) fail(ToolchainErrorCode.PARSE_EXPECTED_TOKEN, { line: token.span.start.line, column: token.span.start.column, offset: token.span.start.byteOffset, details: { expected: value, actual: token.value || "<eof>" } });
    return this.take();
  }
  identifier(): TinySolToken {
    const token = this.peek();
    if (token.kind !== "identifier") fail(ToolchainErrorCode.PARSE_EXPECTED_TOKEN, { line: token.span.start.line, column: token.span.start.column, details: { expected: "identifier", actual: token.value || "<eof>" } });
    return this.take();
  }

  scalarType(): TinySolScalarTypeNode {
    const token = this.peek();
    if (!SCALAR_TYPES.has(token.value as TinySolScalarType)) fail(ToolchainErrorCode.PARSE_EXPECTED_TOKEN, { line: token.span.start.line, column: token.span.start.column, details: { expected: "type", actual: token.value } });
    this.take(); return this.node({ kind: "ScalarType", name: token.value as TinySolScalarType, span: token.span });
  }
  type(): TinySolTypeNode {
    if (!this.at("mapping")) return this.scalarType();
    const start = this.take(); this.expect("("); const keyType = this.scalarType(); this.expect("=>"); const valueType = this.scalarType(); const end = this.expect(")");
    return this.node<TinySolMappingTypeNode>({ kind: "MappingType", keyType, valueType, span: mergeSpans(start, end) });
  }
  parameters(names: boolean): readonly TinySolParameter[] {
    const result: TinySolParameter[] = []; this.expect("(");
    if (!this.at(")")) {
      do {
        const type = this.scalarType();
        const name = names ? this.identifier() : undefined;
        result.push(this.node({ kind: "Parameter", name: name?.value ?? "", type, span: name === undefined ? type.span : mergeSpans(type.span, name) }));
        if (result.length > TINYSOL_LIMITS.parameters) fail(ToolchainErrorCode.RESOURCE_LIMIT, { details: { resource: "parameters", maximum: TINYSOL_LIMITS.parameters } });
      } while (this.consume(",") !== undefined);
    }
    this.expect(")"); return Object.freeze(result);
  }
  returnTypes(): readonly TinySolScalarTypeNode[] {
    if (this.consume("returns") === undefined) return Object.freeze([]);
    this.expect("("); const result: TinySolScalarTypeNode[] = [];
    if (!this.at(")")) do { result.push(this.scalarType()); } while (this.consume(",") !== undefined);
    this.expect(")"); return Object.freeze(result);
  }

  interface(): TinySolInterfaceDeclaration {
    const start = this.expect("interface"); const name = this.identifier(); this.expect("{");
    const functions: TinySolInterfaceFunction[] = []; let constructor: TinySolInterfaceConstructor | undefined;
    while (!this.at("}")) {
      if (this.at("constructor")) {
        const cstart = this.take(); if (constructor !== undefined) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { line: cstart.span.start.line, column: cstart.span.start.column, details: { name: "constructor" } });
        const parameters = this.parameters(false).map((parameter) => parameter.type); const end = this.expect(";");
        constructor = this.node({ kind: "InterfaceConstructor", parameters: Object.freeze(parameters), span: mergeSpans(cstart, end) });
      } else {
        const fstart = this.expect("function"); const fname = this.identifier(); const parameters = this.parameters(false).map((parameter) => parameter.type);
        const view = this.consume("view") !== undefined; const returns = this.returnTypes(); const end = this.expect(";");
        functions.push(this.node({ kind: "InterfaceFunction", name: fname.value, parameters: Object.freeze(parameters), returns, view, span: mergeSpans(fstart, end) }));
      }
    }
    const end = this.expect("}");
    return this.node({ kind: "InterfaceDeclaration", name: name.value, ...(constructor === undefined ? {} : { constructor }), functions: Object.freeze(functions), span: mergeSpans(start, end) });
  }

  event(): TinySolEventDeclaration {
    const start = this.expect("event"); const name = this.identifier(); this.expect("("); const parameters: TinySolEventParameter[] = [];
    if (!this.at(")")) do {
      const type = this.scalarType(); const indexed = this.consume("indexed") !== undefined; const pname = this.identifier();
      parameters.push(this.node({ kind: "Parameter", name: pname.value, type, indexed, span: mergeSpans(type.span, pname) }));
    } while (this.consume(",") !== undefined);
    this.expect(")"); const end = this.expect(";");
    return this.node({ kind: "EventDeclaration", name: name.value, parameters: Object.freeze(parameters), span: mergeSpans(start, end) });
  }
  constructorDeclaration(): TinySolConstructorDeclaration {
    const start = this.expect("constructor"); const parameters = this.parameters(true); const body = this.block();
    return this.node({ kind: "ConstructorDeclaration", parameters, body, span: mergeSpans(start, body.span) });
  }
  functionDeclaration(): TinySolFunctionDeclaration {
    const start = this.expect("function"); const name = this.identifier(); const parameters = this.parameters(true);
    const visibility = this.consume("external") !== undefined ? "external" : this.consume("internal") !== undefined ? "internal" : "external";
    const view = this.consume("view") !== undefined; const returns = this.returnTypes(); const body = this.block();
    return this.node({
      kind: "FunctionDeclaration", name: name.value, visibility, parameters, returns, view, body, span: mergeSpans(start, body.span)
    });
  }
  contract(): TinySolContractDeclaration {
    const start = this.expect("contract"); const name = this.identifier(); this.expect("{");
    const stateVariables: TinySolStateVariable[] = []; const events: TinySolEventDeclaration[] = []; const functions: TinySolFunctionDeclaration[] = []; let constructor: TinySolConstructorDeclaration | undefined;
    while (!this.at("}")) {
      if (this.at("event")) events.push(this.event());
      else if (this.at("constructor")) { if (constructor !== undefined) fail(ToolchainErrorCode.DUPLICATE_DECLARATION, { details: { name: "constructor" } }); constructor = this.constructorDeclaration(); }
      else if (this.at("function")) functions.push(this.functionDeclaration());
      else {
        const type = this.type(); const variable = this.identifier(); const end = this.expect(";");
        stateVariables.push(this.node({ kind: "StateVariable", name: variable.value, type, span: mergeSpans(type.span, end) }));
      }
      if (stateVariables.length > TINYSOL_LIMITS.stateVariables || functions.length > TINYSOL_LIMITS.functions || events.length > TINYSOL_LIMITS.events) fail(ToolchainErrorCode.RESOURCE_LIMIT, { details: { resource: "declarations" } });
    }
    const end = this.expect("}");
    return this.node({ kind: "ContractDeclaration", name: name.value, stateVariables: Object.freeze(stateVariables), events: Object.freeze(events), ...(constructor === undefined ? {} : { constructor }), functions: Object.freeze(functions), span: mergeSpans(start, end) });
  }
  program(): TinySolProgram {
    const interfaces: TinySolInterfaceDeclaration[] = []; while (this.at("interface")) interfaces.push(this.interface());
    const contract = this.contract(); const eof = this.peek(); if (eof.kind !== "eof") this.expect("<eof>");
    const start = interfaces[0]?.span ?? contract.span;
    return this.node({ kind: "Program", interfaces: Object.freeze(interfaces), contract, span: mergeSpans(start, contract.span), sourceName: this.sourceName });
  }

  block(): TinySolBlock {
    this.enter(); const start = this.expect("{"); const statements: TinySolStatement[] = [];
    while (!this.at("}")) { if (this.peek().kind === "eof") this.expect("}"); statements.push(this.statement()); }
    const end = this.expect("}"); this.leave(); return this.node({ kind: "Block", statements: Object.freeze(statements), span: mergeSpans(start, end) });
  }
  variableDeclaration(expectSemicolon = true): TinySolVariableDeclaration {
    const type = this.scalarType(); const name = this.identifier(); const initializer = this.consume("=") === undefined ? undefined : this.expression(); const end = expectSemicolon ? this.expect(";") : (initializer?.span ?? name.span);
    return this.node({ kind: "VariableDeclaration", name: name.value, type, ...(initializer === undefined ? {} : { initializer }), span: mergeSpans(type.span, end) });
  }
  statement(): TinySolStatement {
    if (this.at("{")) return this.block();
    if (SCALAR_TYPES.has(this.peek().value as TinySolScalarType)) return this.variableDeclaration();
    if (this.at("if")) return this.ifStatement();
    if (this.at("while")) return this.whileStatement();
    if (this.at("for")) return this.forStatement();
    if (this.at("return")) {
      const start = this.take(); const values: TinySolExpression[] = [];
      if (!this.at(";")) do { values.push(this.expression()); } while (this.consume(",") !== undefined);
      const end = this.expect(";"); return this.node({ kind: "ReturnStatement", values: Object.freeze(values), span: mergeSpans(start, end) });
    }
    if (this.at("require")) { const start = this.take(); this.expect("("); const condition = this.expression(); this.expect(")"); const end = this.expect(";"); return this.node({ kind: "RequireStatement", condition, span: mergeSpans(start, end) }); }
    if (this.at("revert")) { const start = this.take(); if (this.consume("(") !== undefined) this.expect(")"); const end = this.expect(";"); return this.node({ kind: "RevertStatement", span: mergeSpans(start, end) }); }
    if (this.at("emit")) {
      const start = this.take(); const eventName = this.identifier(); const args = this.arguments(); const end = this.expect(";");
      return this.node({ kind: "EmitStatement", eventName: eventName.value, arguments: args, span: mergeSpans(start, end) });
    }
    return this.assignmentOrExpression(true);
  }
  assignmentOrExpression(semicolon: boolean): TinySolStatement {
    const expression = this.expression();
    if (this.consume("=") !== undefined) {
      if (expression.kind !== "IdentifierExpression" && expression.kind !== "IndexExpression") fail(ToolchainErrorCode.INVALID_ASSIGNMENT, { line: expression.span.start.line, column: expression.span.start.column });
      const value = this.expression(); const end = semicolon ? this.expect(";") : value.span;
      return this.node({ kind: "Assignment", target: expression as TinySolAssignableExpression, value, span: mergeSpans(expression.span, end) });
    }
    const end = semicolon ? this.expect(";") : expression.span;
    return this.node<TinySolExpressionStatement>({ kind: "ExpressionStatement", expression, span: mergeSpans(expression.span, end) });
  }
  ifStatement(): TinySolIfStatement {
    const start = this.expect("if"); this.expect("("); const condition = this.expression(); this.expect(")"); const consequent = this.block(); const alternate = this.consume("else") === undefined ? undefined : this.block();
    return this.node({ kind: "IfStatement", condition, consequent, ...(alternate === undefined ? {} : { alternate }), span: mergeSpans(start, alternate?.span ?? consequent.span) });
  }
  whileStatement(): TinySolWhileStatement {
    const start = this.expect("while"); this.expect("("); const condition = this.expression(); this.expect(")"); this.loopDepth += 1; if (this.loopDepth > TINYSOL_LIMITS.loopNesting) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...locationOf(start), details: { resource: "loop-nesting", maximum: TINYSOL_LIMITS.loopNesting } }); const body = this.block(); this.loopDepth -= 1;
    return this.node({ kind: "WhileStatement", condition, body, span: mergeSpans(start, body.span) });
  }
  forStatement(): TinySolForStatement {
    const start = this.expect("for"); this.expect("(");
    let initializer: TinySolForStatement["initializer"];
    if (!this.at(";")) initializer = SCALAR_TYPES.has(this.peek().value as TinySolScalarType) ? this.variableDeclaration(false) : this.assignmentOrExpression(false) as TinySolForStatement["initializer"];
    this.expect(";"); const condition = this.at(";") ? undefined : this.expression(); this.expect(";");
    const update = this.at(")") ? undefined : this.assignmentOrExpression(false) as TinySolForStatement["update"]; this.expect(")"); this.loopDepth += 1; if (this.loopDepth > TINYSOL_LIMITS.loopNesting) fail(ToolchainErrorCode.RESOURCE_LIMIT, { ...locationOf(start), details: { resource: "loop-nesting", maximum: TINYSOL_LIMITS.loopNesting } }); const body = this.block(); this.loopDepth -= 1;
    return this.node({ kind: "ForStatement", ...(initializer === undefined ? {} : { initializer }), ...(condition === undefined ? {} : { condition }), ...(update === undefined ? {} : { update }), body, span: mergeSpans(start, body.span) });
  }

  arguments(): readonly TinySolExpression[] {
    const args: TinySolExpression[] = []; this.expect("("); if (!this.at(")")) do { args.push(this.expression()); } while (this.consume(",") !== undefined); this.expect(")"); return Object.freeze(args);
  }
  expression(minimum = 0, depth = 0): TinySolExpression {
    if (depth > TINYSOL_LIMITS.expressionDepth) fail(ToolchainErrorCode.EXPRESSION_LIMIT, { details: { maximum: TINYSOL_LIMITS.expressionDepth } });
    let left = this.prefix(depth + 1);
    while (true) {
      const operator = this.peek().value; const precedence = PRECEDENCE[operator]; if (precedence === undefined || precedence < minimum) break;
      this.take(); const right = this.expression(precedence + 1, depth + 1); left = this.node({ kind: "BinaryExpression", operator, left, right, span: mergeSpans(left.span, right.span) });
    }
    return left;
  }
  prefix(depth: number): TinySolExpression {
    const token = this.peek();
    if (token.value === "!" || token.value === "~" || token.value === "-") { this.take(); const operand = this.expression(11, depth); return this.node({ kind: "UnaryExpression", operator: token.value as "!" | "~" | "-", operand, span: mergeSpans(token, operand.span) }); }
    if (this.consume("(") !== undefined) { const value = this.expression(0, depth); this.expect(")"); return value; }
    if (token.kind === "integer" || token.kind === "bytes32" || token.kind === "address" || token.value === "true" || token.value === "false") {
      this.take(); const literalKind = token.value === "true" || token.value === "false" ? "bool" : token.kind as "integer" | "bytes32" | "address";
      return this.node({ kind: "LiteralExpression", literalKind, value: token.value, span: token.span });
    }
    if (token.value === "call" || token.value === "staticcall") return this.externalCall();
    if (token.value === "create") return this.createExpression();
    const first = this.identifier();
    if (this.consume(".") !== undefined) {
      const second = this.identifier(); const path = `${first.value}.${second.value}`;
      if (!CONTEXT_PATHS.has(path)) fail(ToolchainErrorCode.UNDEFINED_SYMBOL, { line: first.span.start.line, column: first.span.start.column, details: { name: path } });
      return this.node({ kind: "ContextExpression", path, span: mergeSpans(first, second) });
    }
    const identifier = this.node<TinySolIdentifierExpression>({ kind: "IdentifierExpression", name: first.value, span: first.span });
    if (this.consume("[") !== undefined) { const index = this.expression(); const end = this.expect("]"); return this.node<TinySolIndexExpression>({ kind: "IndexExpression", object: identifier, index, span: mergeSpans(first, end) }); }
    if (this.consume("(") !== undefined) {
      const args: TinySolExpression[] = [];
      if (!this.at(")")) do { args.push(this.expression()); } while (this.consume(",") !== undefined);
      const end = this.expect(")");
      return this.node<TinySolFunctionCallExpression>({ kind: "FunctionCallExpression", functionName: first.value, arguments: Object.freeze(args), span: mergeSpans(first, end) });
    }
    return identifier;
  }
  externalCall(): TinySolExternalCallExpression {
    const start = this.take(); const interfaceName = this.identifier(); this.expect("."); const functionName = this.identifier(); this.expect("("); const target = this.expression(); const args: TinySolExpression[] = [];
    while (this.consume(",") !== undefined) args.push(this.expression()); const end = this.expect(")");
    return this.node({ kind: "ExternalCallExpression", callKind: start.value as "call" | "staticcall", interfaceName: interfaceName.value, functionName: functionName.value, target, arguments: Object.freeze(args), span: mergeSpans(start, end) });
  }
  createExpression(): TinySolCreateExpression {
    const start = this.expect("create"); const interfaceName = this.identifier(); this.expect("("); const codeHash = this.expression(); const args: TinySolExpression[] = [];
    while (this.consume(",") !== undefined) args.push(this.expression()); const end = this.expect(")");
    return this.node({ kind: "CreateExpression", interfaceName: interfaceName.value, codeHash, arguments: Object.freeze(args), span: mergeSpans(start, end) });
  }
}

function locationOf(token: TinySolToken): { line: number; column: number; offset: number } {
  return { line: token.span.start.line, column: token.span.start.column, offset: token.span.start.byteOffset };
}

function logicalSourceName(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return "input.tiny.sol";
  return normalized.length === 0 ? "input.tiny.sol" : normalized;
}

export function parseTinySol(source: string | readonly TinySolToken[], options: { readonly sourceName?: string } = {}): TinySolProgram {
  const tokens = typeof source === "string" ? lexTinySol(source) : source;
  return new Parser(tokens, logicalSourceName(options.sourceName ?? "input.tiny.sol")).program();
}

export function tinySolAstJson(program: TinySolProgram): string {
  return `${JSON.stringify(program, null, 2)}\n`;
}
