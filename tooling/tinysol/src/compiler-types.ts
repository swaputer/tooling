import type { Bytes32, Bytes4, Hex } from "./bytes.js";
import type { AssemblyResult, SourceMapEntry } from "./assembler.js";
import type { ProgramPackageV1 } from "./package.js";

export const TINYSOL_LANGUAGE_VERSION = "1" as const;
export const TINYSOL_COMPILER_VERSION = "0.2.0-experimental" as const;
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
  diagnostics: 128
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

export type TinySolTokenKind = "identifier" | "keyword" | "integer" | "bytes32" | "address" | "operator" | "punctuation" | "eof";

export interface TinySolToken {
  readonly kind: TinySolTokenKind;
  readonly value: string;
  readonly span: SourceSpan;
}

export type TinySolScalarType = "uint256" | "int256" | "bool" | "bytes32" | "account" | "address";
export interface TinySolScalarTypeNode { readonly kind: "ScalarType"; readonly name: TinySolScalarType; readonly span: SourceSpan }
export interface TinySolMappingTypeNode { readonly kind: "MappingType"; readonly keyType: TinySolScalarTypeNode; readonly valueType: TinySolScalarTypeNode; readonly span: SourceSpan }
export type TinySolTypeNode = TinySolScalarTypeNode | TinySolMappingTypeNode;

export interface TinySolParameter { readonly kind: "Parameter"; readonly name: string; readonly type: TinySolScalarTypeNode; readonly span: SourceSpan }
export interface TinySolEventParameter extends TinySolParameter { readonly indexed: boolean }

export interface TinySolStateVariable { readonly kind: "StateVariable"; readonly name: string; readonly type: TinySolTypeNode; readonly span: SourceSpan }
export interface TinySolEventDeclaration { readonly kind: "EventDeclaration"; readonly name: string; readonly parameters: readonly TinySolEventParameter[]; readonly span: SourceSpan }
export interface TinySolConstructorDeclaration { readonly kind: "ConstructorDeclaration"; readonly parameters: readonly TinySolParameter[]; readonly body: TinySolBlock; readonly span: SourceSpan }
export type TinySolFunctionVisibility = "external" | "internal";
export interface TinySolFunctionDeclaration { readonly kind: "FunctionDeclaration"; readonly name: string; readonly visibility: TinySolFunctionVisibility; readonly parameters: readonly TinySolParameter[]; readonly returns: readonly TinySolScalarTypeNode[]; readonly view: boolean; readonly body: TinySolBlock; readonly span: SourceSpan }
export interface TinySolInterfaceFunction { readonly kind: "InterfaceFunction"; readonly name: string; readonly parameters: readonly TinySolScalarTypeNode[]; readonly returns: readonly TinySolScalarTypeNode[]; readonly view: boolean; readonly span: SourceSpan }
export interface TinySolInterfaceConstructor { readonly kind: "InterfaceConstructor"; readonly parameters: readonly TinySolScalarTypeNode[]; readonly span: SourceSpan }
export interface TinySolInterfaceDeclaration { readonly kind: "InterfaceDeclaration"; readonly name: string; readonly constructor?: TinySolInterfaceConstructor; readonly functions: readonly TinySolInterfaceFunction[]; readonly span: SourceSpan }

export interface TinySolProgram { readonly kind: "Program"; readonly interfaces: readonly TinySolInterfaceDeclaration[]; readonly contract: TinySolContractDeclaration; readonly span: SourceSpan; readonly sourceName: string }
export interface TinySolContractDeclaration { readonly kind: "ContractDeclaration"; readonly name: string; readonly stateVariables: readonly TinySolStateVariable[]; readonly events: readonly TinySolEventDeclaration[]; readonly constructor?: TinySolConstructorDeclaration; readonly functions: readonly TinySolFunctionDeclaration[]; readonly span: SourceSpan }

export interface TinySolBlock { readonly kind: "Block"; readonly statements: readonly TinySolStatement[]; readonly span: SourceSpan }
export interface TinySolVariableDeclaration { readonly kind: "VariableDeclaration"; readonly name: string; readonly type: TinySolScalarTypeNode; readonly initializer?: TinySolExpression; readonly span: SourceSpan }
export interface TinySolAssignment { readonly kind: "Assignment"; readonly target: TinySolAssignableExpression; readonly value: TinySolExpression; readonly span: SourceSpan }
export interface TinySolIfStatement { readonly kind: "IfStatement"; readonly condition: TinySolExpression; readonly consequent: TinySolBlock; readonly alternate?: TinySolBlock; readonly span: SourceSpan }
export interface TinySolWhileStatement { readonly kind: "WhileStatement"; readonly condition: TinySolExpression; readonly body: TinySolBlock; readonly span: SourceSpan }
export interface TinySolForStatement { readonly kind: "ForStatement"; readonly initializer?: TinySolVariableDeclaration | TinySolAssignment | TinySolExpressionStatement; readonly condition?: TinySolExpression; readonly update?: TinySolAssignment | TinySolExpressionStatement; readonly body: TinySolBlock; readonly span: SourceSpan }
export interface TinySolReturnStatement { readonly kind: "ReturnStatement"; readonly values: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolRequireStatement { readonly kind: "RequireStatement"; readonly condition: TinySolExpression; readonly span: SourceSpan }
export interface TinySolRevertStatement { readonly kind: "RevertStatement"; readonly span: SourceSpan }
export interface TinySolEmitStatement { readonly kind: "EmitStatement"; readonly eventName: string; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolExpressionStatement { readonly kind: "ExpressionStatement"; readonly expression: TinySolExpression; readonly span: SourceSpan }
export type TinySolStatement = TinySolBlock | TinySolVariableDeclaration | TinySolAssignment | TinySolIfStatement | TinySolWhileStatement | TinySolForStatement | TinySolReturnStatement | TinySolRequireStatement | TinySolRevertStatement | TinySolEmitStatement | TinySolExpressionStatement;

export interface TinySolLiteralExpression { readonly kind: "LiteralExpression"; readonly literalKind: "integer" | "bytes32" | "address" | "bool"; readonly value: string; readonly span: SourceSpan }
export interface TinySolIdentifierExpression { readonly kind: "IdentifierExpression"; readonly name: string; readonly span: SourceSpan }
export interface TinySolContextExpression { readonly kind: "ContextExpression"; readonly path: string; readonly span: SourceSpan }
export interface TinySolIndexExpression { readonly kind: "IndexExpression"; readonly object: TinySolIdentifierExpression; readonly index: TinySolExpression; readonly span: SourceSpan }
export interface TinySolUnaryExpression { readonly kind: "UnaryExpression"; readonly operator: "!" | "~" | "-"; readonly operand: TinySolExpression; readonly span: SourceSpan }
export interface TinySolBinaryExpression { readonly kind: "BinaryExpression"; readonly operator: string; readonly left: TinySolExpression; readonly right: TinySolExpression; readonly span: SourceSpan }
export interface TinySolExternalCallExpression { readonly kind: "ExternalCallExpression"; readonly callKind: "call" | "staticcall"; readonly interfaceName: string; readonly functionName: string; readonly target: TinySolExpression; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolFunctionCallExpression { readonly kind: "FunctionCallExpression"; readonly functionName: string; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export interface TinySolCreateExpression { readonly kind: "CreateExpression"; readonly interfaceName: string; readonly codeHash: TinySolExpression; readonly arguments: readonly TinySolExpression[]; readonly span: SourceSpan }
export type TinySolAssignableExpression = TinySolIdentifierExpression | TinySolIndexExpression;
export type TinySolExpression = TinySolLiteralExpression | TinySolIdentifierExpression | TinySolContextExpression | TinySolIndexExpression | TinySolUnaryExpression | TinySolBinaryExpression | TinySolExternalCallExpression | TinySolFunctionCallExpression | TinySolCreateExpression;

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
export interface TinySolAbi { readonly format: "TinySolABI"; readonly version: 1; readonly contract: string; readonly constructor: string; readonly functions: readonly TinySolAbiFunction[]; readonly events: readonly string[]; readonly abiCanonical: string; readonly abiHash: Bytes32 }
export interface TinySolEventField { readonly name: string; readonly type: TinySolScalarType; readonly indexed: boolean; readonly position: number }
export interface TinySolEventDescriptor { readonly name: string; readonly signature: string; readonly topic0: Bytes32; readonly fields: readonly TinySolEventField[] }
export interface TinySolEventAbi { readonly format: "SwapVMEventABI"; readonly descriptorVersion: 1; readonly codeHash: Bytes32; readonly standard: string; readonly version: 1; readonly artifactAbiHash: Bytes32; readonly events: readonly TinySolEventDescriptor[] }
export interface TinySolStorageItem { readonly name: string; readonly type: string; readonly declarationIndex: number; readonly slot?: Bytes32; readonly namespace?: Bytes32; readonly keyType?: TinySolScalarType; readonly valueType?: TinySolScalarType }
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
