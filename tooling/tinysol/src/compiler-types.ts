import type { Bytes32, Bytes4, Hex } from "./bytes.js";
import type { AssemblyResult, SourceMapEntry } from "./assembler.js";
import type { ProgramPackageV1 } from "./package.js";

export const TINYSOL_LANGUAGE_VERSION = "1.1" as const;
export const TINYSOL_COMPILER_VERSION = "0.4.0" as const;
export const TINYSOL_OPTIMIZATION_PROFILE = "none" as const;

export const TINYSOL_LIMITS = Object.freeze({
  sourceBytes: 262_144,
  tokens: 65_536,
  astNodes: 32_768,
  nestingDepth: 64,
  expressionDepth: 64,
  parameters: 32,
  functions: 128,
  events: 128,
  stateVariables: 256,
  loopNesting: 16,
  diagnostics: 128,
  fixedArrayLength: 256,
  flattenedArrayWords: 65_536
} as const);

export interface SourcePosition {
  readonly offset: number;
  readonly byteOffset: number;
  readonly line: number;
  readonly column: number;
}

export interface SourceSpan {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export type TinySolTokenKind = "identifier" | "keyword" | "integer" | "bytes32" | "address" | "string" | "operator" | "punctuation" | "eof";

export interface TinySolToken {
  readonly kind: TinySolTokenKind;
  readonly value: string;
  readonly span: SourceSpan;
}

export const TINYSOL_INTEGER_WIDTHS = Object.freeze([
  8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128,
  136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 248, 256
] as const);
export type TinySolIntegerWidth = (typeof TINYSOL_INTEGER_WIDTHS)[number];
export type TinySolUnsignedType = `uint${TinySolIntegerWidth}`;
export type TinySolSignedType = `int${TinySolIntegerWidth}`;
export type TinySolIntegerType = TinySolUnsignedType | TinySolSignedType;
export type TinySolScalarType = TinySolIntegerType | "bool" | "bytes32" | "account" | "address";

export function tinySolIntegerInfo(type: TinySolScalarType): { readonly signed: boolean; readonly width: TinySolIntegerWidth } | undefined {
  const match = /^(u?)int(\d+)$/.exec(type);
  if (match === null) return undefined;
  const width = Number(match[2]) as TinySolIntegerWidth;
  if (!(TINYSOL_INTEGER_WIDTHS as readonly number[]).includes(width)) return undefined;
  return Object.freeze({ signed: match[1] !== "u", width });
}

export function tinySolIntegerBounds(type: TinySolIntegerType): { readonly minimum: bigint; readonly maximum: bigint } {
  const info = tinySolIntegerInfo(type)!;
  if (!info.signed) return Object.freeze({ minimum: 0n, maximum: (1n << BigInt(info.width)) - 1n });
  return Object.freeze({ minimum: -(1n << BigInt(info.width - 1)), maximum: (1n << BigInt(info.width - 1)) - 1n });
}
export type TinySolBoundedKind = "vector" | "bytes" | "string";
export interface TinySolScalarTypeNode { readonly kind: "ScalarType"; readonly name: TinySolScalarType; readonly userType?: string; readonly arrayLength?: number; readonly arrayDimensions?: readonly number[]; readonly boundedKind?: TinySolBoundedKind; readonly capacity?: number; readonly span: SourceSpan }
export interface TinySolMappingTypeNode { readonly kind: "MappingType"; readonly keyType: TinySolScalarTypeNode; readonly valueType: TinySolScalarTypeNode; readonly valueArrayLength?: number; readonly valueArrayDimensions?: readonly number[]; readonly span: SourceSpan }
export type TinySolTypeNode = TinySolScalarTypeNode | TinySolMappingTypeNode;

export interface TinySolParameter { readonly kind: "Parameter"; readonly name: string; readonly type: TinySolScalarTypeNode; readonly span: SourceSpan }
export interface TinySolEventParameter extends TinySolParameter { readonly indexed: boolean }

export interface TinySolStateVariable { readonly kind: "StateVariable"; readonly name: string; readonly type: TinySolTypeNode; readonly span: SourceSpan }
export interface TinySolConstantDeclaration { readonly kind: "ConstantDeclaration"; readonly name: string; readonly type: TinySolScalarTypeNode; readonly value: TinySolExpression; readonly span: SourceSpan }
export interface TinySolEnumDeclaration { readonly kind: "EnumDeclaration"; readonly name: string; readonly members: readonly { readonly name: string; readonly span: SourceSpan }[]; readonly span: SourceSpan }
export interface TinySolStructField { readonly kind: "StructField"; readonly name: string; readonly type: TinySolScalarTypeNode; readonly mappingType?: TinySolMappingTypeNode; readonly span: SourceSpan }
export interface TinySolStructDeclaration { readonly kind: "StructDeclaration"; readonly name: string; readonly fields: readonly TinySolStructField[]; readonly span: SourceSpan }
export interface TinySolEventDeclaration { readonly kind: "EventDeclaration"; readonly name: string; readonly parameters: readonly TinySolEventParameter[]; readonly span: SourceSpan }
export interface TinySolErrorDeclaration { readonly kind: "ErrorDeclaration"; readonly name: string; readonly parameters: readonly TinySolParameter[]; readonly span: SourceSpan }
export interface TinySolConstructorDeclaration { readonly kind: "ConstructorDeclaration"; readonly parameters: readonly TinySolParameter[]; readonly body: TinySolBlock; readonly span: SourceSpan }
export type TinySolFunctionVisibility = "external" | "internal";
export interface TinySolFunctionDeclaration { readonly kind: "FunctionDeclaration"; readonly name: string; readonly visibility: TinySolFunctionVisibility; readonly parameters: readonly TinySolParameter[]; readonly returns: readonly TinySolScalarTypeNode[]; readonly view: boolean; readonly body: TinySolBlock; readonly span: SourceSpan }
export interface TinySolInterfaceFunction { readonly kind: "InterfaceFunction"; readonly name: string; readonly parameters: readonly TinySolScalarTypeNode[]; readonly returns: readonly TinySolScalarTypeNode[]; readonly view: boolean; readonly span: SourceSpan }
export interface TinySolInterfaceConstructor { readonly kind: "InterfaceConstructor"; readonly parameters: readonly TinySolScalarTypeNode[]; readonly span: SourceSpan }
export interface TinySolInterfaceDeclaration { readonly kind: "InterfaceDeclaration"; readonly name: string; readonly constructor?: TinySolInterfaceConstructor; readonly functions: readonly TinySolInterfaceFunction[]; readonly span: SourceSpan }

export interface TinySolProgram { readonly kind: "Program"; readonly interfaces: readonly TinySolInterfaceDeclaration[]; readonly contract: TinySolContractDeclaration; readonly span: SourceSpan; readonly sourceName: string }
export interface TinySolContractDeclaration { readonly kind: "ContractDeclaration"; readonly name: string; readonly constants: readonly TinySolConstantDeclaration[]; readonly enums: readonly TinySolEnumDeclaration[]; readonly structs: readonly TinySolStructDeclaration[]; readonly stateVariables: readonly TinySolStateVariable[]; readonly events: readonly TinySolEventDeclaration[]; readonly errors: readonly TinySolErrorDeclaration[]; readonly constructor?: TinySolConstructorDeclaration; readonly functions: readonly TinySolFunctionDeclaration[]; readonly span: SourceSpan }

export interface TinySolBlock { readonly kind: "Block"; readonly statements: readonly TinySolStatement[]; readonly span: SourceSpan }
export interface TinySolVariableDeclaration { readonly kind: "VariableDeclaration"; readonly name: string; readonly type: TinySolScalarTypeNode; readonly initializer?: TinySolExpression; readonly span: SourceSpan }
export type TinySolAssignmentOperator = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=";
export interface TinySolAssignment { readonly kind: "Assignment"; readonly operator?: TinySolAssignmentOperator; readonly target: TinySolAssignableExpression; readonly value: TinySolExpression; readonly span: SourceSpan }
export interface TinySolDeleteStatement { readonly kind: "DeleteStatement"; readonly target: TinySolAssignableExpression; readonly span: SourceSpan }
export interface TinySolTupleBinding { readonly name: string; readonly type?: TinySolScalarTypeNode; readonly span: SourceSpan }
export interface TinySolTupleAssignment { readonly kind: "TupleAssignment"; readonly bindings: readonly TinySolTupleBinding[]; readonly value: TinySolFunctionCallExpression | TinySolExternalCallExpression; readonly span: SourceSpan }
export interface TinySolIfStatement { readonly kind: "IfStatement"; readonly condition: TinySolExpression; readonly consequent: TinySolBlock; readonly alternate?: TinySolBlock; readonly span: SourceSpan }
export interface TinySolWhileStatement { readonly kind: "WhileStatement"; readonly condition: TinySolExpression; readonly body: TinySolBlock; readonly span: SourceSpan }
export interface TinySolForStatement { readonly kind: "ForStatement"; readonly initializer?: TinySolVariableDeclaration | TinySolAssignment | TinySolExpressionStatement; readonly condition?: TinySolExpression; readonly update?: TinySolAssignment | TinySolExpressionStatement; readonly body: TinySolBlock; readonly span: SourceSpan }
export interface TinySolBreakStatement { readonly kind: "BreakStatement"; readonly span: SourceSpan }
export interface TinySolContinueStatement { readonly kind: "ContinueStatement"; readonly span: SourceSpan }
export interface TinySolReturnStatement { readonly kind: "ReturnStatement"; readonly values: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolRequireStatement { readonly kind: "RequireStatement"; readonly condition: TinySolExpression; readonly span: SourceSpan }
export interface TinySolRevertStatement { readonly kind: "RevertStatement"; readonly errorName?: string; readonly arguments?: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolEmitStatement { readonly kind: "EmitStatement"; readonly eventName: string; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolExpressionStatement { readonly kind: "ExpressionStatement"; readonly expression: TinySolExpression; readonly span: SourceSpan }
export type TinySolStatement = TinySolBlock | TinySolVariableDeclaration | TinySolAssignment | TinySolDeleteStatement | TinySolTupleAssignment | TinySolIfStatement | TinySolWhileStatement | TinySolForStatement | TinySolBreakStatement | TinySolContinueStatement | TinySolReturnStatement | TinySolRequireStatement | TinySolRevertStatement | TinySolEmitStatement | TinySolExpressionStatement;

export interface TinySolLiteralExpression { readonly kind: "LiteralExpression"; readonly literalKind: "integer" | "bytes32" | "address" | "account" | "bool"; readonly value: string; readonly span: SourceSpan }
export interface TinySolIdentifierExpression { readonly kind: "IdentifierExpression"; readonly name: string; readonly span: SourceSpan }
export interface TinySolContextExpression { readonly kind: "ContextExpression"; readonly path: string; readonly span: SourceSpan }
export interface TinySolIndexExpression { readonly kind: "IndexExpression"; readonly object: TinySolIdentifierExpression | TinySolIndexExpression | TinySolMemberExpression; readonly index: TinySolExpression; readonly span: SourceSpan }
export interface TinySolMemberExpression { readonly kind: "MemberExpression"; readonly object: TinySolIdentifierExpression | TinySolIndexExpression | TinySolMemberExpression; readonly member: string; readonly span: SourceSpan }
export interface TinySolStructLiteralExpression { readonly kind: "StructLiteralExpression"; readonly structName: string; readonly fields: readonly { readonly name: string; readonly value: TinySolExpression; readonly span: SourceSpan }[]; readonly span: SourceSpan }
export interface TinySolArrayLiteralExpression { readonly kind: "ArrayLiteralExpression"; readonly elements: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolStringLiteralExpression { readonly kind: "StringLiteralExpression"; readonly value: string; readonly span: SourceSpan }
export interface TinySolMethodCallExpression { readonly kind: "MethodCallExpression"; readonly object: TinySolIdentifierExpression | TinySolIndexExpression | TinySolMemberExpression; readonly method: string; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolLocalArrayIndexExpression { readonly kind: "LocalArrayIndexExpression"; readonly baseName: string; readonly length: number; readonly elementType: TinySolScalarType; readonly index: TinySolExpression; readonly span: SourceSpan }
export interface TinySolNestedArrayIndexExpression { readonly kind: "NestedArrayIndexExpression"; readonly object: TinySolIdentifierExpression; readonly indices: readonly TinySolExpression[]; readonly dimensions: readonly number[]; readonly elementType: TinySolScalarType; readonly span: SourceSpan }
export interface TinySolLocalNestedArrayIndexExpression { readonly kind: "LocalNestedArrayIndexExpression"; readonly baseName: string; readonly indices: readonly TinySolExpression[]; readonly dimensions: readonly number[]; readonly elementType: TinySolScalarType; readonly span: SourceSpan }
export interface TinySolNestedStorageIndexExpression { readonly kind: "NestedStorageIndexExpression"; readonly object: TinySolIdentifierExpression; readonly key: TinySolExpression; readonly indices: readonly TinySolExpression[]; readonly dimensions: readonly number[]; readonly elementType: TinySolScalarType; readonly span: SourceSpan }
export interface TinySolUnaryExpression { readonly kind: "UnaryExpression"; readonly operator: "!" | "~" | "-"; readonly operand: TinySolExpression; readonly span: SourceSpan }
export interface TinySolBinaryExpression { readonly kind: "BinaryExpression"; readonly operator: string; readonly left: TinySolExpression; readonly right: TinySolExpression; readonly span: SourceSpan }
export interface TinySolConditionalExpression { readonly kind: "ConditionalExpression"; readonly condition: TinySolExpression; readonly consequent: TinySolExpression; readonly alternate: TinySolExpression; readonly span: SourceSpan }
export interface TinySolCastExpression { readonly kind: "CastExpression"; readonly type: TinySolScalarTypeNode; readonly value: TinySolExpression; readonly span: SourceSpan }
export interface TinySolExternalCallExpression { readonly kind: "ExternalCallExpression"; readonly callKind: "call" | "staticcall"; readonly interfaceName: string; readonly functionName: string; readonly target: TinySolExpression; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolFunctionCallExpression { readonly kind: "FunctionCallExpression"; readonly functionName: string; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolCreateExpression { readonly kind: "CreateExpression"; readonly interfaceName: string; readonly codeHash: TinySolExpression; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export type TinySolAssignableExpression = TinySolIdentifierExpression | TinySolIndexExpression | TinySolLocalArrayIndexExpression | TinySolNestedArrayIndexExpression | TinySolLocalNestedArrayIndexExpression | TinySolNestedStorageIndexExpression | TinySolMemberExpression;
export type TinySolExpression = TinySolLiteralExpression | TinySolIdentifierExpression | TinySolContextExpression | TinySolIndexExpression | TinySolLocalArrayIndexExpression | TinySolNestedArrayIndexExpression | TinySolLocalNestedArrayIndexExpression | TinySolNestedStorageIndexExpression | TinySolMemberExpression | TinySolStructLiteralExpression | TinySolArrayLiteralExpression | TinySolStringLiteralExpression | TinySolMethodCallExpression | TinySolUnaryExpression | TinySolBinaryExpression | TinySolConditionalExpression | TinySolCastExpression | TinySolExternalCallExpression | TinySolFunctionCallExpression | TinySolCreateExpression;

export interface TinySolDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly span?: SourceSpan;
  readonly sourceName: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

export interface ResolvedTinySol { readonly program: TinySolProgram; readonly diagnostics: readonly TinySolDiagnostic[] }
export interface TypedTinySol extends ResolvedTinySol { readonly expressionTypes: ReadonlyMap<TinySolExpression, TinySolScalarType>; readonly staticFunctions: ReadonlySet<string> }

export interface TinySolAbiFunction { readonly name: string; readonly signature: string; readonly selector: Bytes4; readonly inputs: readonly TinySolScalarType[]; readonly outputs: readonly TinySolScalarType[]; readonly view: boolean }
export interface TinySolAbiError { readonly name: string; readonly signature: string; readonly selector: Bytes4; readonly inputs: readonly TinySolScalarType[] }
export interface TinySolAbi { readonly format: "TinySolABI"; readonly version: 1; readonly contract: string; readonly constructor: string; readonly functions: readonly TinySolAbiFunction[]; readonly events: readonly string[]; readonly errors?: readonly TinySolAbiError[]; readonly abiCanonical: string; readonly abiHash: Bytes32 }
export interface TinySolEventField { readonly name: string; readonly type: TinySolScalarType; readonly indexed: boolean; readonly position: number }
export interface TinySolEventDescriptor { readonly name: string; readonly signature: string; readonly topic0: Bytes32; readonly fields: readonly TinySolEventField[] }
export interface TinySolEventAbi { readonly format: "SwapVMEventABI"; readonly descriptorVersion: 1; readonly codeHash: Bytes32; readonly standard: string; readonly version: 1; readonly artifactAbiHash: Bytes32; readonly events: readonly TinySolEventDescriptor[] }
export interface TinySolStorageItem { readonly name: string; readonly type: string; readonly declarationIndex: number; readonly slot?: Bytes32; readonly namespace?: Bytes32; readonly keyType?: TinySolScalarType; readonly valueType?: TinySolScalarType; readonly elementType?: TinySolScalarType; readonly length?: number; readonly dimensions?: readonly number[]; readonly nestedMappingScheme?: "keccak256(keccak256(domain,key),index)" }
export interface TinySolStorageLayout { readonly format: "TinySolStorageLayout"; readonly version: 1; readonly contract: string; readonly scalarPacking: "none"; readonly mappingScheme: "keccak256(domain,key)"; readonly items: readonly TinySolStorageItem[]; readonly hash: Bytes32 }
export interface TinySolSourceMapEntry extends SourceMapEntry { readonly sourceSpan: SourceSpan }
export interface TinySolCompilerIdentity { readonly languageVersion: typeof TINYSOL_LANGUAGE_VERSION; readonly compilerVersion: typeof TINYSOL_COMPILER_VERSION; readonly compilerSourceFingerprint: Bytes32; readonly dependencyLockHash: string; readonly isaHash: Bytes32; readonly optimizationProfile: typeof TINYSOL_OPTIMIZATION_PROFILE; readonly status: "experimental-unaudited" }
export interface TinySolBuildManifest { readonly format: "TinySolBuildManifest"; readonly version: 1; readonly compiler: TinySolCompilerIdentity; readonly sourceHash: Bytes32; readonly abiHash: Bytes32; readonly storageLayoutHash: Bytes32; readonly eventDescriptorHash: Bytes32; readonly packageHash: Bytes32; readonly codeLength: number; readonly optimizationProfile: typeof TINYSOL_OPTIMIZATION_PROFILE }
export interface LoweredTinySol { readonly typed: TypedTinySol; readonly abi: TinySolAbi; readonly storageLayout: TinySolStorageLayout; readonly assembly: string; readonly assemblyLineSpans: ReadonlyMap<number, SourceSpan> }
export interface CompileTinySolOptions { readonly sourceName?: string; readonly includeSyntax?: boolean }
export interface CompileTinySolResult {
  readonly tokens?: readonly TinySolToken[];
  readonly ast?: TinySolProgram;
  readonly abi: TinySolAbi;
  readonly eventDescriptor: TinySolEventAbi;
  readonly descriptorHash: Bytes32;
  readonly storageLayout: TinySolStorageLayout;
  readonly assembly: string;
  readonly code: Uint8Array;
  readonly codeHex: Hex;
  readonly package: ProgramPackageV1;
  readonly packageBytes: Uint8Array;
  readonly codeHash: Bytes32;
  readonly sourceMap: readonly TinySolSourceMapEntry[];
  readonly manifest: TinySolBuildManifest;
  readonly compilerIdentity: TinySolCompilerIdentity;
  readonly assemblyResult: AssemblyResult;
}
