# TinySol v1 language and compiler specification

TinySol v1 is an experimental, unaudited tooling language for producing SwapVM `ProgramPackageV1` bytecode. The original Stage 6 line targeted frozen ISA v1; the current local v1.2 extension targets ISA v2, which preserves v1 opcodes and adds three read-only transaction-context opcodes. This document specifies the compiler surface; it does not alter the frozen v1.1 files, package encoding, receipt format or historical deployed behavior.

## Lexical grammar and limits

Source is UTF-8 text, but identifiers are restricted to ASCII `[A-Za-z_][A-Za-z0-9_]*`. Keywords cannot be identifiers. LF and CRLF are normalized before compilation. `//` line comments and non-nesting `/* ... */` comments are discarded. Control characters other than horizontal tab and line endings, malformed surrogate input, Unicode identifiers/confusables and unterminated comments are errors.

Decimal integers and `0x` hexadecimal integers are supported. Exactly 40 hexadecimal digits form an `address` literal and exactly 64 form a `bytes32` literal; other hexadecimal widths form an integer. `true` and `false` are boolean literals. Source spans contain UTF-16 offset, UTF-8 byte offset, one-based line and one-based column.

The compiler limits source to 262,144 bytes, 65,536 tokens, 32,768 AST nodes, 64 nested syntactic levels, 64 expression levels, 32 parameters per declaration, 128 functions, 128 events, 256 state variables, 16 loop levels and 128 diagnostics. Generated code remains subject to the consensus 16,384-byte maximum.

## Grammar

The following EBNF is normative for the implemented surface (`scalar` is one of the six scalar types):

```text
program        = interfaceDecl* contractDecl EOF ;
interfaceDecl  = "interface" ident "{" (interfaceCtor | interfaceFn)* "}" ;
interfaceCtor  = "constructor" "(" typeList? ")" ";" ;
interfaceFn    = "function" ident "(" typeList? ")" "view"? returns? ";" ;
contractDecl   = "contract" ident "{" member* "}" ;
member         = stateDecl | eventDecl | constructorDecl | functionDecl ;
stateDecl      = (scalar | "mapping" "(" scalar "=>" scalar ")") ident ";" ;
eventDecl      = "event" ident "(" eventParams? ")" ";" ;
eventParam     = scalar "indexed"? ident ;
constructorDecl = "constructor" params block ;
functionDecl   = "function" ident ("external" | "internal")? params "view"? returns? block ;
params         = "(" (scalar ident ("," scalar ident)*)? ")" ;
returns        = "returns" "(" typeList? ")" ;
block          = "{" statement* "}" ;
statement      = block | localDecl | assignment ";" | ifStmt | whileStmt | forStmt
               | "return" expressionList? ";" | "require" "(" expression ")" ";"
               | "revert" ("(" ")")? ";" | "emit" ident arguments ";"
               | expression ";" ;
localDecl      = scalar ident ("=" expression)? ";" ;
ifStmt         = "if" "(" expression ")" block ("else" block)? ;
whileStmt      = "while" "(" expression ")" block ;
forStmt        = "for" "(" forInit? ";" expression? ";" forUpdate? ")" block ;
expression     = literal | ident | ident "[" expression "]" | context
               | unary expression | expression binary expression | "(" expression ")"
               | ("call" | "staticcall") ident "." ident "(" expression ("," expression)* ")"
               | "create" ident "(" expression ("," expression)* ")" ;
```

`interface` is compiler-only type-checking sugar. It emits no runtime object and adds no VM capability. Internal source-level helper functions are supported and callable only by name from this contract; only `external` functions are runtime entrypoints and runtime MiniVM calls use an interface declaration.

## Types and operations

- `uint256` uses modulo-`2^256` `ADD`, `SUB`, `MUL`, `DIV`, `MOD`, unsigned comparison and logical right shift. Division/modulo by zero follows MiniVM and returns zero.
- `int256` is a two's-complement word using `SDIV`, `SMOD`, `SLT`, `SGT` and `SAR`. A unary-negative integer literal is checked against the signed 256-bit boundary. The MiniVM result for minimum-int divided by `-1` is authoritative.
- `bool` is always compiler-generated or ABI-validated as zero or one. Conditions require `bool`; there is no integer truthiness. `&&` and `||` use branching and short-circuit.
- `bytes32` is distinct from integers.
- `account` is the tagged 32-byte SwapVM `AccountId`. It is the only legal MiniVM call target. Zero can be supplied explicitly as a canonical ABI word for mint/burn/absence semantics.
- `address` is a 20-byte EVM address represented in a 32-byte ABI word with twelve zero high bytes. It may be stored, returned or compared but cannot be converted to `account` or used as a call target.
- `mapping(K => V)` is storage-only, where `K` and `V` are scalar. It cannot be local, copied or returned. Nested mapping is rejected in v1.

Binary operands must have the same type, except that an in-range positive integer literal may be checked in an `int256` context. There are no implicit `account`/`address`, word/integer or signed/unsigned conversions and no source-level casts in v1. Function overloading, declaration shadowing, recursion and implicit capture are rejected or absent by grammar.

## Resolution, control flow and errors

Contract, interface, event, state, parameter and function names are resolved before lowering. Duplicate declarations, unknown names, selector/topic collisions, bad assignment/return arity, missing returns and invalid static operations stop compilation before a package exists. Errors expose stable codes and source locations; diagnostics never rely on prose comparison.

`if`/`else`, `while` and `for` lower to real `JUMPDEST` targets through the Stage 6D1 fixed-width relocation path. Loops execute dynamically and are not unrolled. `require(false)` and `revert` issue MiniVM `REVERT`; child failure propagates and rolls back the root execution. No catch mechanism exists.

Locals occupy deterministic, unpacked 32-byte memory words from offset zero. Compiler regions are disjoint: mapping hash scratch begins at `0x1000`, nested call buffers at `0x2000`, event data at `0x4000` and return data at `0x5000`. Statement boundaries have an empty operand stack and branch joins have a proven identical stack shape.

## ABI and dispatcher

Constructor calldata is exactly one 32-byte static word per argument and has no selector. Runtime calldata is exactly a four-byte Keccak selector followed by one 32-byte word per argument. `account` canonical signatures use `bytes32`; all other scalar names use their ABI names. Return values are consecutive 32-byte words.

Generated code checks exact calldata length, validates `bool <= 1` and `address <= 2^160-1`, and reverts for an unknown selector. ABI JSON is recursively key-sorted and hashed as exact UTF-8: `abiHash = keccak256(abiCanonical UTF-8 bytes)`.

## Storage layout

Every state declaration has a stable declaration index. A scalar uses the full word at the numeric slot equal to that index; there is no packing. A mapping uses:

```text
domain = keccak256("TinySol.storage.mapping.v1:<contract>:<name>:<declarationIndex>")
slot   = keccak256(domain || canonical32(key))
```

The layout sidecar records every slot/domain and its canonical layout hash. Local names do not affect it; state order and state names deliberately do. Sidecars are tooling metadata and do not change `ProgramPackageV1`.

## Context

The read-only paths map directly to MiniVM opcodes: `msg.sender`→`CALLER`, `this.id`→`ADDRESS`, `tx.actor`→`TXACTOR`, `world.id`→`WORLDID`, `world.executionHeight`→`EXECUTIONHEIGHT`, `buy.ethIn`→`ETHIN`, `buy.grossTokenOut`→`TOKENOUT`, `buy.tickAfter`→`TICK`, `block.number`→`NUMBER`, `block.timestamp`→`TIMESTAMP`, `gas.bytePrice`→`BYTEPRICE`, `gas.bytesUsed`→`BYTESUSED`, and `gas.bytesRemaining`→`BYTESREMAINING`. `buy.tickAfter` is `int256`; the others are `account`, `bytes32` or `uint256` as appropriate. `this.id` is the active mini-contract `AccountId`; it exposes the existing ISA `ADDRESS` opcode and is useful for escrow-style programs. The `BYTESUSED` value includes its own opcode.

In the v1.2 local extension, `tx.router`→`TXROUTER`, `tx.executor`→`TXEXECUTOR` and `tx.recipient`→`TXRECIPIENT`. These three values have TinySol type `address` and are emitted as low-160-bit EVM address words. They are read-only and inherited unchanged across nested MiniVM calls and creates.

## Events and Stage 6C descriptor

`emit` writes non-indexed fields as consecutive 32-byte data words and uses topic 0 as `keccak256(canonical signature)`. At most three user fields may be `indexed`, so the emitted `LOGn` has at most four total topics. Static fields keep every generated record below the 4,096-byte protocol limit.

The compiler emits a strict `SwapVMEventABI` descriptor v1 with contiguous indexed positions beginning at one and data positions beginning at zero. `account` appears as `bytes32` in signatures. Its `codeHash` is the compiled package hash and `artifactAbiHash` is the compiler ABI hash. Compiler descriptors are registered only as `declared_unverified`; a Transfer-shaped custom event never acquires SRC reference trust.

## Mini-contract calls and creation

Typed calls use compiler interfaces:

```text
call Counter.increment(target, amount)
staticcall Counter.get(target)
create Counter(codeHash, constructorArgument)
```

`target` must be `account`; `codeHash` must be `bytes32`. Inputs use the static ABI. This compiler release supports exactly one return word for a call expression and verifies that complete child return-data length is 32 bytes. Child revert propagates. `STATICCALL` requires an interface `view` function. `CREATE` accepts only a code hash already registered in the World and returns its contract `account`. There is no EVM call, value forwarding, delegatecall or runtime string signature.

A TinySol `view` function cannot write storage, emit, create or issue mutable `CALL`; it may issue only `STATICCALL` to an interface function declared `view`. The onchain MiniVM static check remains the security authority.

## Deterministic build and unsupported surface

The sole optimization profile is `none`. Lowering emits readable `.svasm`, and only the Stage 6D1 assembler encodes and validates bytes. Compiler identity contains language/compiler versions, exact ISA hash, a sorted compiler-source fingerprint, dependency-lock SHA-256 and `experimental-unaudited` status. The manifest additionally commits source, ABI, layout, descriptor and package hashes. It contains no timestamp, absolute path, host, user or random identifier.

TinySol v1 does not support dynamic arrays, strings, dynamic bytes, nested mappings, inheritance, modifiers, payable/value transfer, EVM calls, delegatecall, assembly, try/catch, exception recovery, upgrades, floating point, dynamic allocation, break/continue, function overloads or runtime signature strings. Exact concrete-path byte and TOKEN-fee estimation belongs to Stage 6D3.
