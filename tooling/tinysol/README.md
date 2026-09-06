# SwapVM TinySol toolchain

This Node.js workspace contains the complete Stage 6D toolchain plus the local v1.2 executor-context extension: ISA/package tooling, the experimental TinySol v1 compiler, a deterministic local MiniVM and concrete-path byte-fee estimator. High-level source is lowered to deterministic `.svasm`; the assembler remains the only byte encoder. Simulation consumes explicit snapshots and never calls RPC or Solidity. The source workspace remains private to prevent accidental publication; the repository's controlled npm release process generates the reviewed public package.

The compiler library is also consumed by the in-browser TinySol Studio in the
`swaputer/explorer` repository (`apps/mint-ui`), whose build supplies the small
Node compatibility layer needed for hashing and UTF-8 byte lengths.

## Installation

Use the library from an ES module:

```sh
npm install @swaputer-labs/tinysol
```

Or run/install the offline CLI:

```sh
npx @swaputer-labs/tinysol --help
npm install --global @swaputer-labs/tinysol
tinysol --help
```

Requires Node.js 22 or newer. The compiler and simulator do not require an RPC
endpoint or wallet.

## Library example

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

const result = compileTinySol(source, { sourceName: "Counter.tiny.sol" });
console.log(result.codeHash);
console.log(result.packageBytes);
```

`compileTinySol` returns the deterministic package, code hash, ABI, event
descriptor, storage layout, assembly, source map and compiler identity. It does
not deploy or sign the result.

## Commands

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run isa:check
npm run references:check
npm run corpus:check
npm run compiler-identity:check
npm run fixtures:check
npm run examples:check
npm run simulator:fixtures:check
npm run programs:check
npm audit
```

`programs:check` recompiles the committed `MintableSRC20`, `MarketEscrow` and `SETH`
application sources in memory and rejects any drift in their package, ABI,
event, storage, manifest, assembly, or source-map artifacts.

The installed binary supports:

```text
tinysol isa check
tinysol asm --input program.svasm --output program.svm [--manifest program.manifest.json]
tinysol disasm --input program.svm --output program.svasm
tinysol validate --input program.svm
tinysol inspect --input program.svm --json
tinysol hash --input program.svm
tinysol check --input Contract.tiny.sol
tinysol ast --input Contract.tiny.sol --json
tinysol compile --input Contract.tiny.sol --output Contract.svm \
  --abi Contract.abi.json --events Contract.events.json \
  --storage-layout Contract.storage.json --manifest Contract.manifest.json \
  --assembly Contract.svasm --source-map Contract.map.json
tinysol simulate --input simulation.json
tinysol estimate --input estimate.json
```

Outputs are not overwritten unless `--force` is explicit, and an input path can never be used as its output path. The CLI uses no wallet, RPC or chain state.

Compiler outputs are preflighted and written as one artifact set. A lexical, parse, resolution or type error leaves no package or partial sidecar. The public compiler API exports `lexTinySol`, `parseTinySol`, `resolveTinySol`, `typeCheckTinySol`, `lowerTinySol`, `compileTinySol`, `checkTinySol` and `formatDiagnostics`, plus readonly syntax/artifact types. See the [TinySol v1 language reference](https://github.com/swaputer/tooling/blob/main/docs/TINYSOL-V1-LANGUAGE.md) for the grammar and exact restrictions.

## Assembly format

One instruction is written per line. Mnemonics are case-insensitive; canonical disassembly emits uppercase mnemonics and LF line endings. `;`, `#` and `//` begin comments outside quoted strings.

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

Supported directives are `.constructor`, `.runtime`, `.abi-hash`, `.abi-canonical`, `.code` and `.pushlabel`. `.abi-canonical` accepts a JSON-quoted exact UTF-8 string. `.pushlabel` always emits `PUSH2` plus a two-byte big-endian relocation. Labels mark existing opcode boundaries and never insert bytes. Explicit `PUSH1..PUSH32` widths and leading zero bytes are preserved.

The assembler result includes code, entries, ABI hash, package bytes/hash, ISA hash, source map, diagnostics and a deterministic sidecar manifest. ISA/tool version and source maps are never inserted into the frozen package wire encoding.

## Validation boundary

`validateCode` implements only production Solidity `_validateCode`: nonempty code, the 16,384-byte maximum, known opcodes and complete fixed-width immediates. `validateProgramPackage` additionally enforces the exact 44-byte header, version, declared length and entrypoint boundaries. `analyzeCode` is a separate advisory API; for example, absence of a halt is a warning rather than a consensus rejection.

The four files in `fixtures/reference/` are mechanically generated, lossless assembly forms of the existing immutable reference packages. `fixtures/differential-corpus.json` covers all 256 opcode bytes, every truncated PUSH width, code-size boundaries, malformed packages and the four reference packages. Ordinary checks never regenerate either fixture set; regeneration requires the explicit scripts.

The nine sources under `examples/` and their `fixtures/compiler/*.json` outputs exercise the v1 language and real MiniVM execution. `MiniToken` and `MiniNFT` are custom compiler demonstrations. Their descriptors must be registered as `declared_unverified`; they are not the immutable reference SRC packages even when they emit a Transfer-shaped record.

The public simulator API exports `simulateMiniVM`, `simulateMiniVMCode`, `estimateMiniVMFee`, immutable snapshot/result types, stable `MiniVMErrorCode` values and consensus limits. Successful concrete estimates report exact executed bytes, actual burn, maximum exposure and net output. Reverted or incomplete simulations are explicitly unavailable and never signable. v1.2 simulation inputs may include `context.tx.router`, `context.tx.executor` and `context.tx.recipient` as EVM addresses; omitted fields default to zero for older fixtures. See the [MiniVM simulator reference](https://github.com/swaputer/protocol/blob/main/docs/STAGE6D3.md) for the state schema, differential corpus and acceptance boundary.

## License

The files distributed in this npm package are available under the MIT License.
Only this package's allowlisted files are included in its npm archive.
