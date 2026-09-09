# `@swaputer-labs/tinysol`

Compiler, assembler, simulator and offline CLI for the TinySol language.
TinySol programs compile deterministically to SwapVM Mini Contract packages;
the same input and compiler version always produce the same bytecode and hashes.

The package does not connect to an RPC endpoint, load a wallet, sign
transactions or deploy contracts.

## Installation

```sh
npm install @swaputer-labs/tinysol@0.3.2
```

The current public release is `0.3.2`. It requires Node.js 22 or newer and uses
ES modules.

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

## CLI

Run without installing globally:

```sh
npx @swaputer-labs/tinysol@0.3.2 --help
```

Or install the `tinysol` command:

```sh
npm install --global @swaputer-labs/tinysol@0.3.2
tinysol --help
```

Available commands:

```text
tinysol check --input Contract.tiny.sol
tinysol ast --input Contract.tiny.sol --json
tinysol compile --input Contract.tiny.sol --output Contract.svm \
  --abi Contract.abi.json --events Contract.events.json \
  --storage-layout Contract.storage.json --manifest Contract.manifest.json \
  --assembly Contract.svasm --source-map Contract.map.json
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

The installed package includes TinySol examples under `examples/`, including
Counter, MiniToken, MiniNFT, mappings, events, nested calls and several familiar
contract patterns.

## License

MIT
