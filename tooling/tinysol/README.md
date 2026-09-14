# `@swaputer-labs/tinysol`

Compiler, assembler, simulator and offline CLI for the TinySol language.
TinySol programs compile deterministically to SwapVM Mini Contract packages;
the same input and compiler version always produce the same bytecode and hashes.

The package does not connect to an RPC endpoint, load a wallet, sign
transactions or deploy contracts.

## Version identities

TinySol publishes several independent version identifiers:

- the npm package version identifies the JavaScript distribution and may change for packaging or tooling updates;
- the language version identifies accepted source semantics and compatibility rules;
- the compiler version identifies a concrete compiler implementation release;
- the SwapVM ISA version identifies the frozen bytecode instruction set consumed by the protocol.

They must not be treated as interchangeable. The `legacy-v1` compatibility profile is frozen in
`fixtures/legacy-compatibility-v1.json`; it records the pre-extension compiler identity and asserts
byte-exact program packages plus canonical ABI, event and storage artifacts without changing SwapVM ISA v2.

## Installation and release status

```sh
npm install @swaputer-labs/tinysol@0.3.2
```

The last recorded public release is `0.3.2`; it does not contain the language v1.1 additions below.
This source tree and its reviewed tarball are prepared as `0.4.0`, but the preparation workflow does
not publish it. Repository maintainers can test that exact candidate without implying registry
availability:

```sh
npm install ./artifacts/npm-tinysol-0.4.0/swaputer-labs-tinysol-0.4.0.tgz
```

Both lines require Node.js 22 or newer and use ES modules. After `0.4.0` is separately published and
verified, consumers may replace the local tarball path with the exact registry identity.

## Compile a contract

```ts
import { compileTinySol } from "@swaputer-labs/tinysol";

const source = `
contract Counter {
  uint256 value;

  function increment(uint256 amount) returns (uint256) {
    value = value + amount;
    return value;
  }
}
`;

const result = compileTinySol(source, {
  sourceName: "Counter.tiny.sol"
});

console.log(result.codeHash);
console.log(result.packageBytes);
console.log(result.abi);
```

`compileTinySol` returns the package bytes, code hash, ABI, event descriptor,
storage layout, assembly, source map and compiler identity. Compilation is
atomic: invalid source throws a stable `ToolchainError` without returning a
partial artifact set.

## Check source without compiling

```ts
import {
  checkTinySol,
  formatDiagnostics,
  isToolchainError
} from "@swaputer-labs/tinysol";

try {
  const checked = checkTinySol(source, {
    sourceName: "Counter.tiny.sol"
  });
  console.log(checked.program.contract.name);
} catch (error) {
  if (!isToolchainError(error)) throw error;
  console.error(formatDiagnostics(error));
}
```

The public compiler pipeline also exports `lexTinySol`, `parseTinySol`,
`resolveTinySol`, `typeCheckTinySol` and `lowerTinySol`, together with readonly
syntax and artifact types.

## Language v1.1 extensions

The compiler supports typed constants, enums, snapshot-value structs with declaration-order ABI
flattening, fixed storage
arrays, named errors, bounded indexed-collection patterns, conditional expressions, integer
compound assignments, statement-form `++`/`--`, typed `delete`, scalar/array/struct multi-return destructuring,
local/ABI scalar, enum and non-recursive struct fixed arrays, fixed-array struct fields, array literals and every `uint8`...`uint256` /
`int8`...`int256` width in 8-bit steps. Narrowing and signedness
changes use checked explicit casts such as `uint24(value)`; same-signed widening is implicit.
Narrow integers remain one 32-byte word and do not enable storage packing. New constructs lower
entirely to the existing SwapVM ISA v2. Structs can cross internal and external call boundaries,
be returned directly, and be copied or updated through nested member paths without partial-value
aliasing. ABI arrays and structs flatten to consecutive scalar words. Member arrays such as
`pool.reserves[i]` and `pool.positions[i].amount` are bounds checked. Scalar, enum and non-recursive
struct arrays support direct multidimensional syntax such as `uint256[3][2]` and `Position[2][2]`,
including storage, mapping values, struct fields, locals and static ABI/calls. Scalar and enum
multidimensional arrays also expose fixed subarray reads, writes, returns, call arguments and
`delete`, with each dynamic prefix index evaluated once. `break` and `continue` are supported in nested
`while`/`for` loops, and fixed arrays may be declared in `for` initializers. Bounded vectors use
`T[<=N]`; bounded byte and UTF-8 string values use `bytes<N>` and `string<N>`. They provide
`.length`, `.push(value)`, `.pop()`, checked reads and capacity-checked implicit expansion on indexed writes.
These types work in storage, mappings, struct fields, locals and the static ABI. Array-bearing structs can be mapping values through
deterministic bounded second-level storage hashing or elements of outer fixed arrays through row-major
linearization with independent bounds checks. Struct fields may be fixed arrays of array-bearing structs;
recursively composed static dimensions use the same lowering across storage, mappings, locals and ABI.
Each dimension is limited to 256 elements and the recursively flattened shape to 65,536 words.
Arrays of structs flatten field-first (all elements of the first flattened field, then all elements of the next);
enum arrays retain nominal type checks and receive a range check for every element.

See `docs/TINYSOL-V1.1-LANGUAGE.md` for the complete syntax, lowering and security rules and
`docs/TINYSOL-0.4-MIGRATION.md` for upgrade guidance.

## Multi-file projects and libraries

```ts
import { compileTinySolProject } from "@swaputer-labs/tinysol";

const result = await compileTinySolProject({
  projectRoot: "/absolute/project/root",
  entry: "src/Token.tiny.sol"
});
```

Local relative imports inside `projectRoot` are resolved directly. npm-style bare imports are accepted
only through an exact `tinysol.lock.json` entry containing a project-relative path and SHA-256 digest;
the result reports the lock and per-module hashes. URL, absolute, unpinned package,
symlink-escape and cyclic imports are rejected. `pure` library functions are statically linked;
there is no dynamic loader or mutable library state. Repeated clean builds are byte-identical.

The `stdlib/` seed includes checked math, ownership/roles, AccountId/address conversion, hashing,
signature recovery, bounded pagination and SRC20/SRC721 interfaces.

## TypeScript frontend bindings

```ts
import { generateTypeScriptBindings } from "@swaputer-labs/tinysol";

const source = generateTypeScriptBindings(result.abi, result.eventDescriptor);
```

Bindings contain typed calldata/result helpers, framework-neutral read/write client methods, event
decoders and named-error selectors. They never hold private keys or sign without the caller's
wallet. CLI compilation accepts `--bindings Token.bindings.ts` to write this eighth artifact.

## CLI

After installing the reviewed `0.4.0` tarball in a project, run its local CLI:

```sh
npx tinysol --help
```

Or install that candidate tarball globally:

```sh
npm install --global ./artifacts/npm-tinysol-0.4.0/swaputer-labs-tinysol-0.4.0.tgz
tinysol --help
```

Available commands:

```text
tinysol check --input Contract.tiny.sol
tinysol ast --input Contract.tiny.sol --json
tinysol format --input Contract.tiny.sol --output Contract.formatted.tiny.sol
tinysol compile --input Contract.tiny.sol --output Contract.svm \
  --abi Contract.abi.json --events Contract.events.json \
  --storage-layout Contract.storage.json --manifest Contract.manifest.json \
  --assembly Contract.svasm --source-map Contract.map.json \
  --bindings Contract.bindings.ts
tinysol asm --input program.svasm --output program.svm \
  --manifest program.manifest.json
tinysol disasm --input program.svm --output program.svasm
tinysol validate --input program.svm
tinysol inspect --input program.svm --json
tinysol hash --input program.svm
tinysol simulate --input simulation.json
tinysol estimate --input estimate.json
tinysol isa check
```

Existing output files are never replaced unless `--force` is supplied. An input
path cannot also be used as an output path.

## Assemble a program

Assembly uses one instruction per line. Mnemonics are case-insensitive;
canonical disassembly emits uppercase mnemonics and LF line endings. `;`, `#`
and `//` begin comments outside quoted strings.

```text
.constructor constructor
.runtime runtime
.abi-hash 0x0123...64-hex-digits
.code

constructor:
PUSH1 0x00
STOP

runtime:
JUMPDEST
.pushlabel runtime
JUMP
```

Supported directives are `.constructor`, `.runtime`, `.abi-hash`,
`.abi-canonical`, `.code` and `.pushlabel`. Labels mark opcode boundaries and
never insert bytes. Explicit `PUSH1..PUSH32` widths and leading zero bytes are
preserved.

The assembler returns code, entry points, ABI and package hashes, package bytes,
source map, diagnostics and a deterministic sidecar manifest.

## Validate and inspect bytecode

```ts
import {
  analyzeCode,
  disassemble,
  validateCode,
  validateProgramPackage
} from "@swaputer-labs/tinysol";

validateCode(codeBytes);
validateProgramPackage(packageBytes);

const assembly = disassemble(codeBytes);
const analysis = analyzeCode(codeBytes);
```

`validateCode` checks the production bytecode boundary: non-empty code, the
16,384-byte limit, known opcodes and complete fixed-width immediates.
`validateProgramPackage` additionally checks the package header, declared
length and entry-point boundaries. `analyzeCode` provides advisory diagnostics
that are not consensus rules.

## Simulate and estimate fees

The simulator consumes an explicit state snapshot and never reads chain state.

```ts
import {
  estimateMiniVMFee,
  simulateMiniVM
} from "@swaputer-labs/tinysol";

const result = simulateMiniVM(simulationInput);
const estimate = estimateMiniVMFee(estimateInput);
```

Successful simulations return deterministic output, storage changes and event
records. Failed executions expose a stable `MiniVMErrorCode` and do not return
partial committed state. Fee estimates distinguish executed-byte burn from
maximum exposure and are unavailable for reverted or incomplete simulations.

Simulation inputs may include `context.tx.router`, `context.tx.executor` and
`context.tx.recipient` as EVM addresses. Omitted transaction-context fields
default to the zero address.

## Examples

The installed package includes TinySol examples under `examples/`, including legacy `Counter`,
`StructuredRegistry` (enum + struct + fixed array), `Voting` (roles + bounded pagination), and
`multifile-token/MultiFileToken` (imports + library + named errors + committed TypeScript bindings).

## License

MIT
