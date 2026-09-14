# Migrating to `@swaputer-labs/tinysol` 0.4

Version 0.4 is source-compatible with valid TinySol v1 programs. Existing programs retain their
package bytes and artifact identities under the frozen `legacy-v1` compatibility gate. No SwapVM
ISA, Kernel, package, storage namespace, event or receipt migration is required.

New projects may opt into language v1.1 syntax directly. Use `compileTinySolProject` or CLI
`--project-root` when the entry contains imports. Relative files remain project-root confined.
npm-style bare specifiers additionally require an exact project-relative path and SHA-256 in
`tinysol.lock.json`; URL and absolute-path imports remain rejected.

The integer type surface now includes `uint8` through `uint256` and `int8` through `int256` in
8-bit steps. Narrow values retain one-word storage layout, so changing an existing state field from
`uint256` to `uintN` does not pack or relocate neighboring fields, but it does change ABI and
storage-layout identities and adds runtime range checks. Same-signed values widen implicitly;
narrowing or signedness changes require an explicit checked cast such as `uint24(value)`.

Structs and enums use static ABI flattening. Frontends should consume the generated TypeScript
bindings instead of hand-building flattened tuples. Struct values may now cross internal/external
call boundaries, initialize or assign locals, be returned directly, and participate in tuple
destructuring. Whole-struct assignments snapshot every source field before writing the destination,
which removes field-order aliasing in overlapping copies. Built-in scalar fixed arrays now work in
locals, parameters, returns and external calls, and are flattened into consecutive scalar ABI
words. This changes a source signature such as `f(uint256[2])` into the TinySol canonical selector
`f(uint256,uint256)`; inspect generated bindings when migrating a hand-built caller. Non-recursive
`Struct[N]` values now work in locals and static ABI positions, including internal/external calls,
returns and tuple destructuring. Their ABI order is field-first: a two-element `{ x, ok }` struct
array becomes `x[0], x[1], ok[0], ok[1]`. `Enum[N]` values now use the same local, ABI, call,
return and tuple paths while retaining nominal type checks and per-element range guards. Fixed-array
struct fields now work for built-in scalar, enum and non-recursive struct elements, including member
indexing, whole-struct assignment and static ABI flattening. Array-bearing structs can also be mapping
values; their array elements use a second deterministic storage hash and retain bounds checks.
Array-bearing structs may now also appear inside an outer fixed array. Their member arrays use
row-major linearization with independent outer/inner bounds checks, and storage sidecars expose both
the physical word length and logical dimensions. Whole outer-array assignment and `delete` retain
snapshot semantics. Struct fields that are arrays of structs whose element type itself contains an
array are now supported too, including recursively composed static dimensions in storage, mappings,
locals and ABI values. Every dimension receives an independent bounds check and the layout sidecar
records the full outer-to-inner dimension list. Each dimension remains capped at 256 elements;
recursively composed shapes are capped at 65,536 flattened words and fail with `RESOURCE_LIMIT`
before allocation when that budget is exceeded. Scalar, enum and non-recursive struct arrays now
also accept direct multidimensional syntax such as `uint256[3][2]` and `Position[2][2]`; storage,
mapping values, struct fields, locals and static ABI/calls all use row-major flattening, while every
source dimension is checked separately. Scalar, enum and struct arrays additionally support remaining
fixed-subarray reads, writes, returns, call arguments and `delete`; dynamic prefix indexes are
evaluated once. Fixed arrays may now appear in `for` initializers, and loops support nearest-target
`break` and `continue`.

Bounded vectors, byte strings and UTF-8 text are opt-in source types: `T[<=N]`, `bytes<N>` and
`string<N>`. They lower to a length word and a fixed-capacity data array, with `.length`, `push`,
`pop`, checked indexing and capacity-checked indexed expansion. Their ABI is deliberately static
(`length` plus `N` element words), so adding one changes selectors and generated bindings. This is
not Solidity dynamic ABI encoding and does not introduce unbounded allocation.

Direct state structs may contain storage-only mapping fields. Such structs cannot be passed,
returned, constructed as local values, nested in mappings, or used as array elements.

Named errors change revert payloads only where explicitly used. Legacy `require` and bare `revert`
continue to return empty revert data. Review generated error selectors before release.

Conditional expressions, integer compound assignments, statement-form postfix `++`/`--` and
`delete` are source additions only. Existing scalar `=` assignments retain their previous lowering
and byte output. Compound updates to mappings and fixed arrays perform the bounds/key calculation
once; whole-struct storage operations also evaluate their index once. Internal and external calls
with multiple scalar, fixed-array or flattened-struct return values may be consumed through tuple destructuring;
existing scalar single-return call encoding is unchanged.

Before upgrading a production build, run `npm run compatibility:check`, rebuild the project twice,
compare package hashes, inspect the storage sidecar and review generated bindings. Publishing is a
separate manual action and is not performed by the release preparation scripts.

## Package coordination

TinySol `0.4.0` is the only new package release required by this language change. The existing
`@swaputer-labs/receipt-codec@0.1.2` remains compatible because bounded values do not alter
`VMReceiptV1`. The existing `@swaputer-labs/cli@0.1.2` can verify transactions from `0.4.0`-compiled
programs because it authenticates the Kernel receipt and program identity rather than interpreting
source syntax. Its private `0.1.3-dev.0` browser work is a separate release concern.

The public registry records TinySol `0.4.0`. Its timestamp, tarball hash, registry shasum and
integrity are recorded separately in `release/npm/tinysol-0.4.0-publication.json`; the immutable
September 6 three-package publication evidence remains unchanged.

## Base Sepolia evidence

The bounded collection lowering was exercised against the active Base Sepolia SwapVM deployment.
The proof records successful DEPLOY and CALL receipts, a matching onchain program code hash, and an
independent `Kernel.staticCall` readback of UTF-8 text, bytes, a bounded vector, bounded struct fields,
and a bounded value stored through a struct mapping field. See the protocol repository's
`deployments/base-sepolia/tinysol-new-capabilities-20260914.json` evidence file.
