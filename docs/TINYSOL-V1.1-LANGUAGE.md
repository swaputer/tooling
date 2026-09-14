# TinySol language v1.1

TinySol v1.1 is a compiler-only extension of TinySol v1. It emits the unchanged
`ProgramPackageV1` format and SwapVM ISA v2 bytecode. It adds no runtime, opcode,
network lookup, wallet behavior or environment-dependent resolution.

## Compatibility

The `legacy-v1` profile freezes the pre-extension corpus in
`tooling/tinysol/fixtures/legacy-compatibility-v1.json`. Every frozen source must retain exact
package bytes, code hash, ABI canonical form, event descriptor and storage layout. npm package,
language, compiler and ISA versions are independent identifiers.

## Compile-time declarations

Typed contract constants are evaluated before semantic lowering and allocate no storage:

```solidity
const uint256 CAPACITY = 16;
const uint256 MASK = (1 << 4) - 1;
```

Constant expressions support literals, prior or later constants, unary operators, the normal
binary operators and compile-time conditional expressions. Decimal separators such as `1_000_000`
are accepted. Overflow, division or
modulo by zero, shifts outside `0..255`, undefined constants and cycles are compilation errors.

## Integer types and conversions

Unsigned and signed integers are available from 8 through 256 bits in 8-bit steps: `uint8`,
`uint16`, ..., `uint256` and `int8`, `int16`, ..., `int256`. There are no unsized `uint` or `int`
aliases. Every integer still occupies one 32-byte local, ABI or storage word; this release does not
pack narrow storage fields.

Integer literals may be assigned to any integer type that can represent their value. Values widen
implicitly only between integer types with the same signedness, such as `uint8` to `uint32`.
Narrowing and signedness changes require an explicit checked cast:

```solidity
uint16 widened = small;
uint8 narrowed = uint8(runtimeValue);
int24 signedValue = int24(runtimeValue);
```

An out-of-range constant is a compilation error. An out-of-range ABI word, explicit runtime cast,
narrow arithmetic result, compound assignment or return value reverts before it can be used or
stored. Mixed signed/unsigned arithmetic is rejected unless the programmer makes the conversion
explicit. Signed narrow ABI values use canonical 256-bit sign extension. Generated TypeScript
bindings represent every integer width as `bigint` and enforce the same input/output ranges.

Enums lower to `uint256` in member declaration order starting at zero:

```solidity
enum Status { Pending, Active, Closed }
Status status;
```

Enum ABI inputs are range-checked before the function body can read or write state. Enum fields in
struct ABI inputs receive the same check. Fixed enum arrays retain nominal element types through
lowering and check every input and returned element against the declared enum member count.

## Structs

Contract-scoped structs may contain scalar, enum, non-recursive struct and fixed-array fields:

```solidity
struct Position { account owner; uint256 amount; Status status; }
struct Pool { uint256[2] reserves; Status[2] states; Position[4] positions; }
Position current;
Position local = Position({ owner: msg.sender, amount: 1, status: Status.Active });
```

Parameters and returns flatten recursively in declaration order. `account` retains its canonical
`bytes32` signature name. State structs allocate one full storage word per scalar field; no field
packing occurs. Fixed-array fields allocate contiguous words and non-recursive struct-array fields
flatten field-first. Struct-valued mappings lower to one mapping domain per flattened field. Array
fields inside mapped structs use the explicit second-level scheme
`keccak256(keccak256(domain,key),index)`, where `index` is the checked row-major member offset, and
retain their declared bounds. Missing, duplicate or
unknown fields and recursive type graphs are rejected.

Structs may also contain mappings when the containing value is a direct state variable. Mapping
fields are storage-only: structs containing them cannot cross ABI boundaries, be local values, be
mapping values, or be elements of arrays. Nested direct state structs are supported and each mapping
field receives its own deterministic mapping namespace.

Structs have snapshot value semantics. Whole-value assignment reads and validates every source
field before committing any destination field, so overlapping expressions such as
`value = Pair({ x: value.y, y: value.x });` swap correctly. Nested member chains and nested
whole-value updates are supported. Dynamic mapping or fixed-array indexes used by a whole-struct
read, write or delete are evaluated once.

Internal and external calls may accept and return structs. A struct-returning call can initialize
or assign a local, be returned directly, or participate in tuple destructuring:

```solidity
Position local = makePosition(owner);
(Position quoted, uint256 fee) = quote(owner);
return readPosition(owner);
```

These forms remain statically flattened. For example, a two-field `Pair` parameter produces two
consecutive scalar argument words and the TinySol selector `turn(uint256,uint256)`.

## Expressions and state updates

Conditional expressions require a boolean condition and compatible branch types:

```solidity
uint256 selected = enabled ? configured : fallbackValue;
```

Integer scalar locals, state fields, mapping entries and fixed-array elements support `+=`, `-=`,
`*=`, `/=`, `%=`, `&=`, `|=`, `^=`, `<<=` and `>>=`. Postfix `++` and `--` are accepted as
statements and `for` updates; they do not produce an expression value. Compound updates evaluate a
mapping or array index once before loading and storing its element.

`break` and `continue` target the nearest enclosing `while` or `for`. A `continue` in a `for` loop
executes the update clause before testing the condition again. Using either statement outside a loop
is a compile-time `INVALID_OPERATION` error. Fixed scalar and struct arrays may be declared in a
`for` initializer; the compiler expands their storage before entering the loop while preserving the
initializer's loop-local lifetime.

`delete target;` writes the canonical zero value. Deleting a struct clears every flattened field;
deleting an out-of-range fixed-array element fails before any storage write. All state updates,
including `delete`, remain forbidden from `view` functions.

Multi-return calls can be destructured into newly declared or existing scalar and struct
locals/state variables:

```solidity
function quote(uint256 amount) internal view returns(uint256,uint256) {
  return amount, amount / 100;
}

(uint256 output, uint256 fee) = quote(input);
(lastOutput, lastFee) = quote(input);
```

Internal and external calls support this form. The arity and every field type are checked before
code generation. Scalar fixed arrays, `Struct[N]` and `Enum[N]` bindings work in mixed tuple
destructuring, including multidimensional fixed arrays and reassignment into existing bindings;
struct arrays expand field-first. Ordinary external function returns may contain multiple statically
encoded scalar words.

## Fixed arrays and bounded collections

Fixed arrays are written `T[N]`, where `1 <= N <= 256`. This release supports fixed arrays in
storage for scalar, enum and non-recursive struct element types. Dynamic indexes are checked before
every read or write; a literal out-of-range index fails at compile time. The layout sidecar records
the element type, length and base slot. Struct arrays use one contiguous field array per flattened
field. If nested struct composition introduces more fixed dimensions, the sidecar also records the
complete logical shape.

Built-in scalar arrays may declare multiple dimensions directly. As in Solidity,
`uint256[3][2] matrix` has two outer elements containing three inner elements, so `matrix[i][j]`
checks `i < 2` and `j < 3`. Nested literals use the same outer-to-inner shape, for example
`[[1,2,3],[4,5,6]]`. Storage, local values, struct fields, mapping values and static ABI/call
positions use row-major flattening. Scalar and enum arrays may expose a remaining fixed subarray,
so `uint256[3] row = matrix[i]`, `matrix[i] = row`, `return matrix[i]` and `delete matrix[i]` are
supported. Dynamic prefix indexes are evaluated once and every consumed dimension is bounds checked.

Built-in scalar, enum and non-recursive struct fixed arrays are also available as struct fields and in locals,
function/constructor parameters, returns, interface calls, events and named errors. Array literals,
whole-array copies, element assignment and `delete` are supported. Scalar arrays additionally allow
compound element updates:

```solidity
function rotate(uint256 index, uint256[3] input) view returns(uint256[3]) {
  uint256[3] output = [input[1], input[2], input[0]];
  output[index] += 1;
  return output;
}
```

Local arrays lower to contiguous compiler-managed memory words. A whole-array assignment first
evaluates every source element into temporaries, so overlapping copies and rotations do not observe
partial writes. Dynamic local indexes receive the same runtime bounds checks as storage arrays.

Arrays of structs use field-first flattening. For
`struct Pair { uint256 x; bool ok; }`, `Pair[2]` becomes
`uint256,uint256,bool,bool`, corresponding to `x[0], x[1], ok[0], ok[1]`. This order is used
consistently by locals, parameters, returns, internal/external calls, events, named errors and
generated bindings. Whole-array assignments retain snapshot value semantics across all fields.

An array-bearing struct may itself be placed in an outer fixed array. The compiler linearizes each
member array in row-major order while checking the outer and inner indexes independently. For
`Pool[3]` where `Pool` contains `uint256[2] reserves`, the flattened storage field is reported as
`uint256[2][3]`, has a physical length of six words and records `dimensions: [3,2]`. Whole outer-array
assignment and `delete` are supported, as are member expressions such as
`pools[poolIndex].reserves[reserveIndex]`.

Fixed arrays of array-bearing structs are supported as struct fields as well. This composition may
produce any static rank within the 65,536-word flattened-array limit: `Book[2]`, where `Book` contains `Pool[2]` and `Pool` contains
`uint256[2] reserves`, lowers that field to eight contiguous words with `dimensions: [2,2,2]`.
Every source index is checked against its own declared dimension and evaluated exactly once. The
same lowering is used for storage, locals, ABI values, calls and mapping values. A mapping hashes the
mapping key first and then hashes the row-major linearized member index as its second-level key.

Member arrays are indexed directly, including nested struct-array fields such as
`pool.positions[index].amount`. A whole struct containing arrays can be initialized, copied,
assigned, passed or returned; enum array fields preserve nominal typing and every element is range
checked at ABI trust boundaries.

At the current static ABI boundary, `T[N]` is deterministically flattened to `N` consecutive
scalar words. Therefore the example selector is based on
`rotate(uint256,uint256,uint256,uint256)`, and its return contains three `uint256` words. Interfaces
and generated bindings use that same flattened form. Flattened contract inputs/outputs are limited
to 32 words; outgoing interface calls are limited to 23 input and 8 output words by the current
compiler scratch-frame layout. Array-bearing structs may also be mapping values. Direct
multidimensional syntax supports scalar, enum and non-recursive struct element types, including
forms such as `Status[2][2]` and `Position[2][2]`.

Bounded vectors are written `T[<=N]`; bounded byte strings and UTF-8 text are written `bytes<N>`
and `string<N>`, where `1 <= N <= 256` is an explicit capacity:

```solidity
uint256[<=16] samples;
string<64> label;
mapping(account => bytes<32>) payloads;

samples.push(7);
samples[4] = 9; // grows length to five; skipped elements remain zero
samples.pop();
label = "TinySol";
```

`.length`, `.push(value)`, `.pop()`, whole-value assignment, `delete`, and indexed reads/writes are
supported. Reads require `index < length`; indexed writes require `index < capacity` and grow the
logical length to `index + 1`. Push at capacity and pop on an empty value revert. The representation
is a length word plus a fixed-capacity data array and therefore works without an ISA or package-format
change in storage, mapping values, struct fields, locals, parameters, returns and calls.

The ABI remains static: a `string<4>` is encoded as `uint256 length` followed by four `uint8` words.
External inputs and untrusted call returns require `length <= capacity`; scalar tail words after the
logical length must be zero. Selectors use the lowered static signature. These are bounded values,
not Solidity's dynamically encoded `bytes`/`string`; unbounded arrays and unbounded short data remain
unsupported. `stdlib/IndexedCollection.tiny.sol` remains useful for keyed membership and pagination.

## Projects, imports and libraries

`compileTinySolProject({ projectRoot, entry })` resolves `./` and `../` imports relative to the
importing file. npm-style bare specifiers are resolved only through `tinysol.lock.json`:

```json
{
  "version": 1,
  "imports": {
    "@tiny/math": {
      "path": "node_modules/@tiny/math/Math.tiny.sol",
      "sha256": "<64 lowercase hex characters>"
    }
  }
}
```

The resolved file must remain inside the real project root and its exact bytes must match the pinned
SHA-256 digest. The result exposes `moduleHashes` and `importLockHash` for build evidence. Absolute,
URL, unpinned package, symlink-escape and cyclic imports are rejected. Paths and line endings are
canonicalized; compiler output contains no absolute path.

Libraries contain pure functions only:

```solidity
library Math {
  function add(uint256 a, uint256 b) pure returns(uint256) { return a + b; }
}
```

Library calls such as `Math.add(a, b)` are statically linked to internal functions. There is no
dynamic loading or library state. The standard-library seed contains checked arithmetic,
owner/role predicates, checked AccountId/address conversions, Keccak and ECDSA recovery helpers,
bounded-pagination helpers and SRC20/SRC721 interfaces.

## Named errors

Named errors use the canonical four-byte Keccak selector followed by static 32-byte fields:

```solidity
error Unauthorized(account actor, uint256 role);
revert Unauthorized(msg.sender, ADMIN_ROLE);
```

The ABI artifact includes error signatures, selectors and field types only when a contract declares
errors, so the canonical ABI of legacy programs is unchanged. Reverts remain atomic and the
simulator exposes the exact revert data.

## Intrinsics

The following compiler intrinsics lower directly to existing ISA v2 operations or checked no-op
word conversions: `keccak256(bytes32) -> bytes32`,
`ecrecover(bytes32,uint256,bytes32,bytes32) -> account`,
`toAccount(address) -> account`, and `toAddress(account) -> address`. `toAddress` rejects tagged
non-EOA AccountIds rather than truncating them.

## Artifacts and frontend bindings

Compilation returns the existing package, ABI, event ABI, storage layout, assembly, source map and
manifest artifacts. `generateTypeScriptBindings(abi, eventAbi)` emits framework-neutral typed
calldata encoders, result decoders, read/write client helpers, event decoders and named-error
selectors. Generated bindings never store keys or sign transactions; the caller supplies a client
and wallet integration.

The formatter normalizes line endings, trailing whitespace and final newline without changing
semantics. All compiler failures use stable machine-readable codes with source locations.

## Resource and security rules

Consensus limits remain 16,384 code bytes, 65,536 memory bytes, 1,024 stack words and the existing
execution-byte budget. Source remains limited to 262,144 bytes, each fixed-array dimension to 256
elements, and each recursively flattened static array to 65,536 words.
Bounds and enum checks occur before state access. Failed execution cannot commit partial storage,
deployments or events. Compiler resolution is deterministic and offline.

Unsupported features include unbounded dynamic allocation, unbounded arrays, Solidity dynamic-ABI
`string`/`bytes`, nested mapping values, inheritance, modifiers, arbitrary EVM calls, delegatecall,
assembly, try/catch, overloads, runtime signature strings, URL or absolute-path imports, unpinned
package imports and dynamic libraries. Use the explicit-capacity `T[<=N]`, `string<N>` and `bytes<N>`
forms when variable logical length is required.
