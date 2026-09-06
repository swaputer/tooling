# SwapVM v1.1 — Frozen Buy-to-Execute Protocol Specification

Status: **protocol semantics frozen for implementation**  
Target: Uniswap v4 Hook  
Working name: **SwapVM / Swap Computer**

This document freezes v1 protocol behavior. Deployment-specific economic values are supplied by an immutable deployment manifest. A frozen specification is not a security audit; production deployment still requires the verification gates in Section 28.

> Buying the World Token executes the computer. Selling never executes code.

## 1. Executive summary

SwapVM turns one Uniswap v4 `ETH/TOKEN` pool into an isolated, Turing-complete microcomputer:

- the v4 pool is one independent **World**;
- only an exact-input `ETH -> TOKEN` buy can execute the VM;
- every successful buy is one atomic **World Transaction**;
- a buy may deploy or call one root mini-contract;
- the root contract may synchronously call other mini-contracts;
- users can deploy mini-programs that implement fungible tokens, NFTs, markets and arbitrary applications;
- token/NFT behavior lives in user mini-contract code rather than privileged built-in asset modules;
- program-defined assets exist only inside their World and can mutate only during a buy;
- the real pool `TOKEN` is the VM gas currency;
- VM gas equals actual mini-bytecode bytes executed across the full call tree;
- the actual fee is deducted from the TOKEN bought and permanently burned;
- `TOKEN -> ETH` sells never execute the VM, never burn VM gas and never accept VM instructions;
- Ethereum computation still consumes ordinary chain gas;
- any VM, burn or settlement failure reverts the entire buy.

The core rule is:

```text
Buy ETH -> TOKEN
    -> execute MiniVM
    -> count executed bytes
    -> burn executedBytes * byteGasPrice TOKEN
    -> deliver remaining TOKEN to buyer

Sell TOKEN -> ETH
    -> ordinary v4 swap
    -> no MiniVM
    -> no VM TOKEN burn
```

## 2. Economic formula

For each successful VM buy:

```text
vmGasBurn = executedBytes * WorldConfig.byteGasPrice
netTokenOutput = grossTokenOutput - vmGasBurn
```

Rules:

- `byteGasPrice` is immutable TOKEN smallest units per execution byte;
- unexecuted deployed code is free in TOKEN terms;
- loop bodies count again on every iteration;
- constructor and nested mini-contract execution count;
- calldata size, storage size and code size do not receive separate TOKEN fees;
- actual computation and storage still consume Ethereum gas;
- a sell has `executedBytes = 0` and `vmGasBurn = 0`.

## 3. Design goals

SwapVM v1.1 MUST:

1. make an actual `ETH -> TOKEN` buy the only entry into mutable VM state;
2. charge the real TOKEN by actual executed mini-bytecode bytes;
3. remain Turing-complete at the language and ISA level;
4. preserve atomicity among buy, VM state and TOKEN burn;
5. make the maximum potential TOKEN burn known before submission;
6. allow mini-contract deployment and synchronous composition;
7. isolate all code, state and mini-assets by v4 `PoolId`;
8. keep the sell path independent from the VM and always available when v4 itself is live;
9. keep deployed mini-contract code immutable;
10. prevent user bytecode from calling arbitrary external EVM contracts;
11. let token, NFT and AMM semantics be implemented by ordinary mini-contract programs rather than Kernel asset primitives.

## 4. Explicit non-goals

v1.1 does not provide:

- VM execution during `TOKEN -> ETH` sells;
- exact-output VM buys;
- direct mutable `execute`, `mint`, `transfer` or `deploy` EVM methods;
- a flat TOKEN execution fee;
- TOKEN pricing by deployed code, calldata or storage size;
- asynchronous tasks, `yield` or continuations;
- arbitrary external EVM calls, `DELEGATECALL` or `SELFDESTRUCT`;
- upgradeable mini-contracts;
- cross-World calls or asset bridges;
- ERC wrappers for mini-assets;
- a privileged built-in FT, NFT or AMM ledger;
- Kernel guarantees that an arbitrary user token follows a published standard;
- secure randomness from public block fields;
- real-asset lending or external protocol integrations.

## 5. Core invariants

### 5.1 Buy-gated mutation

User-visible VM state may change only inside `afterSwap` when all are true:

```text
direction       = ETH -> TOKEN
swap type       = exact input
gross output    > 0 TOKEN
exact ETH input <= uint128.max
World           = initialized and sealed
```

Sell callbacks must return without touching VM code, VM storage, mini-assets, nonce or execution height.

### 5.2 One buy, one root transaction

Each buy contains either:

- a canonical one-byte `NOP`; or
- one authenticated root `DEPLOY` or `CALL`.

The root program may synchronously call other mini-contracts. Their bytes join the same shared meter.

### 5.3 Atomicity

These all commit or all revert:

1. v4 buy accounting;
2. TOKEN gas collection and burn;
3. nonce and execution-height changes;
4. VM deployment/storage;
5. mini-asset and mini-AMM changes;
6. logs.

### 5.4 Byte-gas integrity

```text
0 < executedBytes <= byteGasLimit
maxGasExposure = byteGasLimit * byteGasPrice
actualBurn     = executedBytes * byteGasPrice
maxGasExposure <= int128.max
grossTokenOutput >= maxGasExposure + minNetTokenOut
```

For signed VM actions, the maximum-exposure precondition ensures that every metered path up to the signed limit can pay its burn while preserving the signed minimum net output. A canonical unsigned NOP buy instead requires `grossTokenOutput > byteGasPrice`; its Router remains responsible for ordinary swap slippage protection.

### 5.5 World isolation

Programs in World A cannot read, write, call or transfer assets in World B. Every key is namespaced by `worldId = PoolId`.

### 5.6 Exit safety

No mini-program is consulted on sells. A malicious or non-terminating program cannot block a holder from using the ordinary v4 `TOKEN -> ETH` path.

## 6. Architecture

```text
User / SwapVMRouter
    |
    | exact-input ETH -> TOKEN + VMEnvelope + byteGasLimit
    v
Uniswap v4 PoolManager
    |
    +--> native v4 swap
    |
    +--> afterSwap
         - reject VM execution unless direction is ETH -> TOKEN exact input
         - obtain actual gross TOKEN output
         - ensure output covers signed maximum gas exposure
         - verify VMEnvelope
         - build BuyReceipt
         - execute MiniVM and count executed bytes
         - calculate and take actual TOKEN fee
         - burn actual TOKEN fee
         - return delta so buyer receives net TOKEN
         - commit or revert atomically

TOKEN -> ETH sell
    -> afterSwap detects sell direction
    -> returns zero VM delta immediately
    -> no envelope parsing, VM state or TOKEN burn
```

Components:

```text
SwapVMHook
    - PoolManager-only callback gate
    - buy/sell direction gate
    - gross-output and maximum-exposure checks
    - call into the bound SwapVMKernel
    - output TOKEN take, burn and afterSwap delta

SwapVMKernel
    - Hook-only mutable execution entry
    - EIP-712 actor, nonce and execution-height state
    - bytecode validation and immutable code registry
    - MiniVM interpreter and executed-byte meter
    - World/contract namespaced storage
    - public read-only staticCall entry
    - aggregate VMReceipt builder and single VMLog emitter

Offchain components
    - canonical Router
    - TinySol compiler/simulator
    - ABI and reference-program registry
    - VMLog indexer
```

The Hook and Kernel are separate, non-proxy contracts. Their addresses, runtime code hashes and protocol versions are bound into the World before its first swap. v1 has no admin upgrade path; changed code creates a new World.

## 7. World model

```solidity
struct WorldConfig {
    bytes32 worldId;             // v4 PoolId
    address poolManager;
    address hook;
    address kernel;
    address gasToken;            // TOKEN
    bytes32 hookCodeHash;
    bytes32 kernelCodeHash;
    bytes32 isaHash;
    uint16 vmVersion;            // 1
    uint8 receiptVersion;        // 1
    uint128 byteGasPrice;        // TOKEN units per executed byte
    uint32 maxByteGasLimit;      // protocol ceiling per buy
    uint24 outerLpFee;
    uint16 maxCodeBytes;
    uint16 maxCallDepth;
    uint32 maxMemoryBytes;
    uint32 maxTotalMemoryBytes;
    uint16 maxStackWords;
    bool sealed;
}
```

Requirements:

- pair is native ETH and an approved immutable Gas Token;
- `byteGasPrice > 0`;
- `maxByteGasLimit > 0`;
- World config is sealed before the first swap;
- gas price is immutable for the World;
- Hook, Kernel, Gas Token and their code hashes are immutable for the World;
- `vmVersion == 1` and `receiptVersion == 1`;
- `uint256(maxByteGasLimit) * byteGasPrice <= uint256(type(int128).max)`;
- new gas economics require a new pool/World.

v1 hard ceilings:

```text
maxByteGasLimit = 1,000,000 executed bytes
maxCodeBytes    = 16,384 per mini-contract
maxCallDepth    = 32
maxMemoryBytes  = 65,536 per frame
maxTotalMemoryBytes = 262,144 across the active call tree
maxStackWords   = 1,024 per frame
```

These are v1 hard ceilings. A deployment manifest MAY choose lower values after chain-specific benchmarks but never higher values. Only `executedBytes` determines TOKEN burn; structural ceilings exist for interpreter safety.

## 8. Hook permissions

v1.1 requires only:

- `afterSwap`;
- `afterSwapReturnDelta`.

It does not need:

- `beforeSwap`;
- `beforeSwapReturnDelta`;
- dynamic v4 LP fees.

This is a material simplification over bidirectional VM execution: the fee is known after execution and is always charged in the exact-input buy's output TOKEN.

## 9. Executed-byte meter

Before dispatching an instruction:

```text
instructionBytes = 1 opcode byte + immediate bytes
executedBytes += instructionBytes
require(executedBytes <= byteGasLimit)
```

Examples:

```text
ADD                 = 1 byte
JUMPI               = 1 byte
PUSH1 0x2a          = 2 bytes
PUSH32 <32 bytes>   = 33 bytes
SYSCALL <id>        = canonical syscall encoding length
```

A five-byte loop body executed 100 times adds 500 bytes.

Included:

- root program;
- every loop iteration;
- all nested mini-contracts;
- constructor execution;
- compiler-generated dispatch/guards;
- canonical NOP;
- native syscall instruction encodings.

Not separately included:

- unexecuted code;
- unread calldata;
- storage or memory size;
- Hook/PoolManager EVM bytecode;
- event bytes;
- real TOKEN burn logic.

Those still consume Ethereum gas.

The byte meter is shared across the complete root call tree and never resets on child call/return.

## 10. Byte-gas limit

Every VM buy declares and signs:

```solidity
uint32 byteGasLimit;
uint128 minNetTokenOut;
```

Maximum TOKEN exposure:

```text
maxGasExposure = byteGasLimit * byteGasPrice
```

The Hook rejects:

- zero limits;
- limits above `WorldConfig.maxByteGasLimit`;
- multiplication overflow;
- `maxGasExposure > type(int128).max`;
- `maxGasExposure + minNetTokenOut` overflow;
- gross TOKEN output below `maxGasExposure + minNetTokenOut`.

If execution crosses the limit, the VM throws `OutOfByteGas` and the full buy reverts. No TOKEN burn survives the reverted transaction.

## 11. Buy-side fee settlement

Let:

```text
G = gross TOKEN output from v4
L = byteGasLimit
P = byteGasPrice
B = executedBytes
M = L * P       // maximum exposure
F = B * P       // actual burn
N = signed minimum net TOKEN output
```

`G` is the checked absolute value of the exact-input swap's positive output-side caller delta before the Hook adjustment; it must fit `uint128`. The Hook derives direction and the output currency from the actual `PoolKey` and `SwapParams`, never from envelope claims.

Pre-execution:

```text
require(M <= int128.max)
require(G >= M + N)
```

Post-execution:

```text
require(F <= M)
require(G - F >= N)
Hook calls PoolManager.take(output TOKEN, Hook, F)
Hook calls GasToken.burn(F) from its own balance
Hook returns positive afterSwap unspecified-currency delta F
Buyer gets:    G - F TOKEN
Unused limit:  no TOKEN taken, therefore no refund needed
```

The Hook uses v4 custom accounting to take the actual output fee and return an `afterSwap` delta that reduces the buyer's TOKEN claim by exactly `F`. Every cast to the v4 delta type is checked. PoolManager transient deltas MUST settle to zero before the enclosing unlock completes.

The buyer does not need to own TOKEN before execution; freshly purchased output pays the byte gas.

## 12. Sell behavior

For every `TOKEN -> ETH` swap:

```text
VMEnvelope        = forbidden/ignored by router, rejected if non-empty at Hook
VM execution      = none
executedBytes     = 0
TOKEN VM burn     = 0
VM nonce          = unchanged
executionHeight   = unchanged
mini state        = unchanged
```

The Hook returns zero delta and leaves ordinary v4 sell accounting untouched.

The normative router rejects attempts to attach a VM action to a sell before sending the transaction.

## 13. Gas Token requirements

The real Gas Token MUST:

- be a conventional fixed-decimal ERC-20;
- let the Hook burn tokens held by the Hook;
- reduce `totalSupply` on burn;
- not rebase or charge transfer fees;
- not invoke arbitrary callbacks;
- not permit freezing of Hook transfers;
- remain immutable after World creation.

The v1 Gas Token implementation and supply policy are immutable, use 18 decimals, contain no proxy/admin/pause/blacklist/rebase/fee logic, and emit the conventional ERC-20 `Transfer` log when burning. That ERC-20 log is not a SwapVM application receipt.

Normative interface:

```solidity
function burn(uint256 amount) external;
```

Sending to a dead address is not a normative burn because `totalSupply` may remain unchanged.

## 14. Outer swap modes

### Buy path

VM execution requires:

```text
direction = ETH -> TOKEN
type      = exact input
```

Exact-output buys revert with `ExactOutputVMUnsupported`.

### Sell path

Sells never execute VM code. The protocol and canonical Router support ordinary v4 exact-input and exact-output sells. In both modes the Hook checks direction, rejects non-empty VM instructions, returns zero delta and does not enter the Kernel.

## 15. World execution height and BuyReceipt

The VM clock advances only after a successful VM buy:

```text
executionHeight += 1
```

Sells do not advance World time.

The Kernel exposes:

```solidity
struct BuyReceipt {
    bytes32 worldId;
    uint64 executionHeight;
    bytes32 actor;               // AccountId; zero for unsigned NOP
    uint128 ethAmountIn;
    uint128 grossTokenOut;
    uint128 tokenGasBurned;
    int24 tickAfter;
    uint128 liquidityAfter;
    uint64 chainBlockNumber;
    uint64 chainTimestamp;
}
```

`tokenGasBurned` becomes final after execution and is available to return hooks/events; programs that require it during execution may read the gas price and current byte meter instead.

Public price, timestamp and block fields are adversarial inputs, not secure randomness.

### 15.1 Unified AccountId

Every VM principal is one 32-byte `AccountId`. This lets EOAs and mini-contracts own the same SRC assets and participate in AMMs.

```text
EOA AccountId:       0x00 || 11 zero bytes || 20-byte EVM address
contract AccountId:  0x01 || first31(keccak256("SwapVM.CREATE.v1", worldId, creator, creatorNonce, codeHash))
Kernel AccountId:    0xff || 30 zero bytes || 0x01
zero AccountId:      32 zero bytes; absence only, never a deployable contract
```

The tag byte is consensus-critical. Mini-contract derivation MUST force the `0x01` tag rather than using a raw hash. SRC balances, owners, approvals and AMM reserve accounts use `AccountId`. At the root frame, `CALLER` is the recovered actor AccountId; in nested frames it is the calling mini-contract AccountId. `ADDRESS` is the active contract AccountId, and `TXACTOR` remains the recovered root actor through the complete call tree.

## 16. VM envelope and authentication

```solidity
enum RootOp { NOP, DEPLOY, CALL }

struct VMEnvelope {
    RootOp op;
    bytes32 worldId;
    address actor;
    bytes32 targetOrCodeHash;
    bytes payload;
    uint32 byteGasLimit;
    uint128 minNetTokenOut;
    uint64 nonce;
    uint64 deadline;
    address recipient;
    address authorizedExecutor;
    bytes signature;
}
```

Enum values are `NOP=0`, `DEPLOY=1`, `CALL=2`. Signed `NOP` envelopes are rejected; NOP is represented only by empty `hookData`. For `CALL`, `targetOrCodeHash` is the target contract AccountId and `payload` is its calldata. For `DEPLOY`, `targetOrCodeHash` is the package `codeHash` and payload is encoded in network byte order as:

```text
packageLength       uint32
programPackage      bytes[packageLength]
constructorCalldata remaining bytes
```

The declared package must consume exactly `packageLength` bytes and pass all ProgramPackageV1 and bytecode validation rules before any constructor instruction executes.

EIP-712 domain:

```text
name              = "SwapVM"
version           = "1.1"
chainId           = block.chainid
verifyingContract = SwapVMKernel address
salt              = worldId
```

The exact v1 signed struct is:

```text
VMAction(
  uint8 op,
  bytes32 worldId,
  address actor,
  bytes32 targetOrCodeHash,
  bytes32 payloadHash,
  uint32 byteGasLimit,
  uint128 minNetTokenOut,
  uint128 exactEthAmountIn,
  uint160 sqrtPriceLimitX96,
  address recipient,
  address router,
  address authorizedExecutor,
  uint64 nonce,
  uint64 deadline
)
```

`payloadHash = keccak256(payload)`. The Hook recomputes the PoolId, exact ETH input and price limit from the actual callback; the immutable canonical Router binds the recipient and exposes the original executor. `router` must equal the callback `sender`. If `authorizedExecutor != address(0)`, the canonical Router requires it to equal its external caller. A zero executor authorizes permissionless relay through that exact Router.

`actor` is an explicit signed EOA and must not be zero. The Kernel recovers the signature and requires `recoveredSigner == actor` before reading or updating a nonce. The VM AccountId is derived only from that verified actor, never from whichever address a changed digest happens to recover and never from the Hook callback sender. Nonces are sequential per `(worldId, actor)` and commit only on success. The v1.1 domain and type hash intentionally invalidate all v1.0 signed actions; unsigned NOP behavior is unchanged.

Empty `hookData` is normalized to the canonical one-byte `STOP` program with `byteGasLimit = 1`, zero actor and no nonce change. It still advances execution height and emits one aggregate VM receipt. Every `DEPLOY` or `CALL` requires a valid signature. v1 accepts canonical low-`s` ECDSA signatures from EOAs only; ERC-1271 is deferred to a later protocol version because it would introduce an external verification call.

## 17. MiniVM execution model

### 17.1 Turing completeness

The VM supports:

- backward jumps;
- loops and recursion;
- dynamic ephemeral memory;
- persistent storage;
- synchronous mini-contract calls;
- contract creation.

There is no continuation. Execution ends at `STOP`, `RETURN`, `REVERT`, `OutOfByteGas` or Ethereum out of gas.

### 17.2 Machine shape

```text
word size:       256 bits
architecture:    stack machine
code:            immutable, content-addressed
stack:           per call frame, maximum 1,024 words
memory:          byte-addressed, ephemeral
storage:         persistent, World/contract namespaced
calls:           synchronous
byte meter:      shared across the root call tree
```

All integers are 256-bit. Unsigned arithmetic wraps modulo `2^256`; signed operations use two's-complement. Division or modulo by zero returns zero. Memory is zero-initialized, expands in bytes, and is bounded both per frame and across the active call tree. Stack underflow/overflow, out-of-bounds memory, invalid jump destinations and truncated immediates are exceptional halts that revert the complete root execution.

### 17.3 Failure semantics

Any invalid opcode/jump, stack error, memory/call-depth violation, unauthorized syscall, explicit revert, out-of-byte-gas, Ethereum OOG or TOKEN burn failure reverts the entire buy.

Child failure propagates to the root. v1.1 has no catchable child revert or partial journal.

### 17.4 ISA families

```text
Arithmetic:  ADD SUB MUL DIV MOD EXP
Comparison:  LT GT EQ ISZERO
Bitwise:     AND OR XOR NOT SHL SHR
Stack:       PUSH POP DUP SWAP
Memory:      MLOAD MSTORE MSTORE8 MSIZE
Control:     JUMP JUMPI JUMPDEST PC STOP
Input:       CALLDATALOAD CALLDATASIZE CALLDATACOPY
Output:      RETURNDATASIZE RETURNDATACOPY RETURN REVERT
Storage:     SLOAD SSTORE
Crypto:      KECCAK256 ECRECOVER
Calls:       CALL STATICCALL CREATE
Logs:        LOG0 LOG1 LOG2 LOG3 LOG4
Context:     ADDRESS CALLER TXACTOR WORLDID EXECUTIONHEIGHT
Buy:         ETHIN TOKENOUT TICK LIQUIDITY
Kernel:      no privileged asset or AMM syscalls
```

VM `CALL` and `CREATE` operate only on mini-contracts. User bytecode cannot issue arbitrary EVM calls, EVM create, delegatecall or selfdestruct.

A `STATICCALL` frame and all of its descendants forbid `SSTORE`, `CREATE` and `LOG0..LOG4`. Attempting any forbidden operation reverts the complete buy.

### 17.5 Frozen v1 execution rules

- opcode encoding is one opcode byte followed by the opcode's fixed immediate bytes;
- `PUSH0` is one byte; `PUSH1..PUSH32` are one opcode plus 1..32 immediate bytes;
- `DUP1..DUP16`, `SWAP1..SWAP16` and `LOG0..LOG4` follow their numbered stack arity;
- `JUMP` and `JUMPI` accept only byte offsets containing a `JUMPDEST` opcode boundary in the current code;
- calldata loads beyond the end return zero-padded bytes; copies beyond the end copy zeroes;
- return-data access outside the most recent child result reverts;
- `CALL`/`STATICCALL` retain the child's complete return data, copy the first `min(outputSize, returnDataSize)` bytes to the requested output memory, and leave any remaining requested output region unchanged;
- `SLOAD`/`SSTORE` access only `(worldId, ADDRESS, slot)`;
- `CALL` and `STATICCALL` accept only a tagged contract AccountId in the same World;
- child frames receive fresh zeroed memory and a fresh stack, share the root byte meter, and preserve `TXACTOR`;
- `CREATE` accepts an already-registered `codeHash` plus constructor calldata, increments the creator's creation nonce only on root success, runs the constructor, and returns the derived AccountId;
- `ECRECOVER` uses Ethereum secp256k1 rules and returns a tagged EOA AccountId or zero on invalid input;
- the validator rejects unknown opcodes and malformed instruction boundaries before first execution;
- VM version 1 opcode values, immediates, stack effects and static permissions are frozen in `SwapVM-ISA-v1.json`. `isaHash` is the Keccak-256 hash of that file's exact UTF-8 bytes: `0x2f0059846af771cb9f77e74d5f728744a9b8dbe69313d146b8a5e7fdcbe7c118`. The hash is embedded in the Kernel and TinySol toolchain and sealed into every v1 World.

### 17.6 Public read-only execution

The Kernel exposes:

```solidity
function staticCall(
    bytes32 worldId,
    bytes32 target,
    bytes calldata input,
    uint32 byteLimit
) external view returns (bytes memory output, uint32 executedBytes);
```

Rules:

- `byteLimit` must be nonzero and no greater than the World's `maxByteGasLimit`;
- the root caller is the tagged EOA form of EVM `msg.sender` and `TXACTOR` equals that caller;
- the complete call tree is static: `SSTORE`, `CREATE` and `LOG0..LOG4` revert;
- it does not require a buy, consume a nonce, advance execution height, burn TOKEN or emit `VMLog`;
- it is intended primarily for `eth_call`, wallets, indexers and conformance tests;
- its result is authoritative for current VM state at the queried block.

## 18. Mini-contract model

```text
contractId = 0x01 || first31(keccak256("SwapVM.CREATE.v1", worldId, creator, creatorNonce, codeHash))
storage[worldId][contractId][slot] -> bytes32
```

`creator` is an AccountId. The Kernel stores a monotonically increasing `creatorNonce[worldId][creator]`; failed deployments do not consume it.

The immutable deployment package is:

```text
ProgramPackageV1
  magic             bytes4 = 0x53564d31  // "SVM1"
  vmVersion         uint16 = 1
  constructorEntry  uint16
  runtimeEntry      uint16
  codeLength        uint16
  abiHash           bytes32
  code              bytes[codeLength]

codeHash = keccak256(canonical ProgramPackageV1 bytes)
```

Offsets are byte offsets into `code` and must point to opcode boundaries. Root `DEPLOY` carries the package plus constructor calldata and verifies `targetOrCodeHash == codeHash`. Internal `CREATE` can instantiate only a code hash already registered in the same World. Normal `CALL` begins at `runtimeEntry`; construction begins at `constructorEntry`.

`constructorEntry` and `runtimeEntry` must both be less than `codeLength`; programs without constructor logic point `constructorEntry` at a canonical `STOP`. The package must contain exactly `codeLength` code bytes and no trailing bytes.

Deployment occurs only through a buy's signed `DEPLOY` action:

1. validate code;
2. derive ID;
3. store immutable code;
4. execute and meter constructor;
5. commit only if buy, execution and burn succeed.

VM `CALL` switches to the callee storage namespace. `DELEGATECALL` does not exist. Code cannot be upgraded; new logic gets a new ID.

## 19. TinySol

TinySol is Solidity-like syntax targeting SwapVM bytecode rather than EVM bytecode.

Frozen v1 source surface:

```text
contract / constructor / function
mapping
uint256 / int256 / bool / account / address / bytes32
if / else / for / while
return / revert / require
mini-contract calls
event declarations / emit
```

Context:

```text
msg.sender
tx.actor
world.id
world.executionHeight
buy.ethIn
buy.grossTokenOut
buy.tickAfter
block.number
block.timestamp
gas.bytePrice
gas.bytesUsed
gas.bytesRemaining
```

Compiler-generated dispatch and safety checks count as executed bytecode. Compiler, validator, disassembler, simulator and onchain interpreter must agree exactly on both result and byte count.

TinySol v1 uses `account` for the 32-byte tagged AccountId and reserves `address` for 20-byte EVM addresses used only at the envelope/tooling boundary. `msg.sender`, `tx.actor`, SRC balances, NFT owners and mini-contract references are `account` values.

## 20. Program-defined asset standards

SwapVM does not contain a privileged token ledger. A mini token or NFT is an ordinary immutable mini-contract whose own storage defines balances, ownership, approvals, supply and metadata.

Example fungible-token storage:

```text
TokenContract.storage:
    totalSupply
    balance[AccountId]
    allowance[AccountId owner][AccountId spender]
```

Example NFT storage:

```text
NFTContract.storage:
    ownerOf[tokenId]
    balanceOf[AccountId]
    approval[tokenId]
    operatorApproval[AccountId owner][AccountId operator]
    metadataHash[tokenId]
```

The platform publishes interface standards rather than Kernel opcodes:

```text
SRC-20   fungible mini-token
SRC-721  non-fungible mini-token
SRC-1155 multi-token / semi-fungible asset
SRC-165  interface discovery
```

The canonical SRC-20 v1 interface exposes:

```text
name()
symbol()
decimals()
totalSupply()
balanceOf(account)
allowance(owner, spender)
transfer(to, amount)
approve(spender, amount)
transferFrom(from, to, amount)
```

The canonical SRC-721 v1 interface exposes:

```text
name()
symbol()
ownerOf(tokenId)
balanceOf(owner)
approve(operator, tokenId)
setApprovalForAll(operator, approved)
transferFrom(from, to, tokenId)
tokenURI(tokenId)
```

Mint, burn, supply caps, bonding curves, royalties, soulbound behavior and access control are program logic. The VM Kernel does not decide them.

Canonical SRC-20 state changes emit virtual `Transfer(account,account,uint256)` and `Approval(account,account,uint256)` records. Canonical SRC-721 state changes emit virtual `Transfer(account,account,uint256)`, `Approval(account,account,uint256)` and `ApprovalForAll(account,account,bool)` records. These are inner VM records inside the single aggregate `VMLog`, never separate Ethereum logs. Exact interface selectors, return encodings and conformance vectors are published with the SRC reference packages and identified by immutable `abiHash` and `codeHash`.

Consequences:

- any user can deploy a custom token/NFT implementation during a VM buy;
- a token transfer is a normal mini-contract `CALL`, so all executed token code is byte-metered;
- every state change still requires an outer ETH -> TOKEN buy;
- two contracts may use the same name/symbol; the canonical identity is `contractId`;
- malicious programs can lie about balances or standards, just as arbitrary EVM contracts can;
- wallets and indexers must distinguish verified standard implementations from unknown code.

## 21. Program-defined AMMs and applications

Mini AMMs are also ordinary deployable mini-contracts rather than a trusted Kernel module.

A standard constant-product reference program can implement:

```text
createPair(token0, token1, fee)
addLiquidity(amount0, amount1, minShares)
removeLiquidity(shares, min0, min1)
swapExactIn(tokenIn, amountIn, minOut)
getReserves()
```

The AMM calls SRC-20 contracts through VM `CALL`/`STATICCALL` and stores its own reserves and LP-share accounting. Its math and token calls are ordinary bytecode and therefore contribute to executed-byte gas.

Users may deploy other program types without changing the Kernel:

- alternative AMM curves;
- auctions and launch mechanisms;
- games and crafting systems;
- generative NFT collections;
- governance and multisig programs;
- lending or derivative experiments using only World-internal program state.

The platform SHOULD publish audited reference programs and immutable code hashes. It MUST NOT treat unknown programs as safe merely because they expose the same interface selectors.

## 22. Real TOKEN versus mini-assets

```text
Real TOKEN
- purchased from the outer v4 pool
- pays actual executed-byte gas
- is burned from buy output
- is never controlled by mini-contracts
- can be sold normally without VM execution

Mini-assets
- are storage and behavior owned by user-deployed mini-contracts
- are created/transferred only through mini-contract calls during buys
- can trade through user-deployed AMM programs
- cannot replace the real TOKEN gas payment
```

## 23. Events and observability

Each successful VM execution emits exactly one **SwapVM application receipt log**. That single `VMLog` is a container holding every virtual log produced by the root call, nested calls, constructors and Kernel during that execution.

```solidity
event VMLog(
    bytes32 indexed worldId,
    uint64 indexed executionHeight,
    bytes payload
);
```

There are no separate Ethereum events for SRC transfers, NFT operations, mini-AMM swaps, deployments or execution receipts. There are also not multiple `VMLog` entries for multiple mini-program events. One successful buy-side VM execution produces one `VMLog`; a sell or reverted execution produces none. The enclosing Ethereum transaction may still contain unrelated protocol logs, including PoolManager's swap log and the real Gas Token's ERC-20 burn `Transfer`; the SwapVM indexer ignores them.

`payload` uses the versioned `VMReceipt` binary codec. Version 1 is encoded in network byte order:

```text
VMReceiptV1
  version       uint8       = 1
  flags         uint8       = 0 in v1
  recordCount   uint16
  records       VMRecord[recordCount]

VMRecord
  recordLength  uint32      number of bytes following this field
  emitter       bytes32     active mini-contract ID
  topicCount    uint8       0..4
  topics        bytes32[topicCount]
  dataLength    uint32
  data          bytes[dataLength]
```

For every record, the decoder MUST verify:

```text
recordLength = 32 + 1 + (32 * topicCount) + 4 + dataLength
```

The record's position in `records` is its canonical `vmLogIndex`. The interpreter injects `emitter` from the active call frame, so user bytecode cannot impersonate another mini-contract. Topics and data are supplied by virtual `LOG0..LOG4`; topic 0 is normally the hash of the TinySol event signature.

The Kernel owns a reserved, impossible-to-deploy `KERNEL_EMITTER_ID`. Execution summaries, mini-contract deployments and other protocol records are encoded as ordinary `VMRecord` entries under that emitter. Consequently, even Kernel activity introduces no additional Ethereum event type.

Every receipt contains exactly one final Kernel execution-summary record. A deployment additionally contains one Kernel deployment record. Their v1 topic-0 selectors are:

```text
keccak256("WorldExecution(bytes32,bytes32,uint32,uint256,uint256,uint256)")
keccak256("MiniContractDeployed(bytes32,bytes32,bytes32)")
```

The execution record data encodes `(actor, rootTarget, executedBytes, tokenBurned, grossTokenOut, netTokenOut)` in canonical 32-byte VM words. The deployment record data encodes `(contractId, creator, codeHash)`. Kernel selectors and record layouts are part of receipt version 1.

SRC-20 `Transfer`, SRC-721 `Transfer`, AMM `Swap`, game events and arbitrary application events exist only as records inside `payload`. Their meaning comes from `(worldId, emitter, immutable codeHash, topics, ABI)`, not from the outer Ethereum event ABI.

### 23.1 Emission pipeline and atomicity

1. At execution start, the Kernel creates one bounded in-memory receipt builder.
2. Each virtual `LOG0..LOG4` appends one `VMRecord` in actual execution order, including records from nested calls and constructors.
3. Kernel records are appended through the same builder under `KERNEL_EMITTER_ID`.
4. After successful VM termination, the Kernel appends the final execution-summary record, seals the header and emits exactly one Ethereum `VMLog(worldId, executionHeight, payload)`.
5. The Hook then completes TOKEN fee collection/burn and swap settlement.
6. If any later step reverts, Ethereum removes the single `VMLog` together with all Kernel state changes and the TOKEN burn.

The canonical emitter is the World's registered `SwapVMKernel` address. The Kernel accepts execution only from its bound `SwapVMHook`; the Hook accepts the callback only from its configured PoolManager. Keeping receipt construction and emission inside the Kernel avoids returning a potentially large log buffer across an external call.

Logs are not persisted again inside general VM storage. Ethereum receipt logs are the append-only history for indexers; mini-contract storage remains the authoritative current state. A program that needs history-dependent behavior onchain must explicitly store the necessary counters, roots or aggregates because VM programs cannot read historical receipt logs.

### 23.2 Metering and limits

- the `LOGn` opcode and every instruction used to build its arguments count toward executed-byte TOKEN gas;
- log payload length does not add synthetic executed bytes; Ethereum memory/log gas prices the underlying resource;
- maximum 4 mini topics per record;
- maximum 4,096 data bytes per record;
- maximum 64 records per VM execution, including Kernel records;
- maximum 65,536 encoded `payload` bytes per VM execution;
- exceeding any event bound reverts the complete buy.

`recordCount` must be at least one because the Kernel execution summary is mandatory. Flags unknown to receipt version 1, unsupported versions, inconsistent counts, any trailing bytes or any record whose declared length does not consume exactly its encoded bytes are invalid.

The constants are consensus parameters and MUST be frozen in `WorldConfig` or protocol code before deployment.

### 23.3 Indexer contract

An indexer:

1. scans only registered `SwapVMKernel` addresses for the single Ethereum `VMLog` signature;
2. filters outer logs by indexed `worldId`;
3. decodes the versioned `VMReceipt` payload and validates every length/count bound;
4. expands the receipt into ordered virtual records using the array position as `vmLogIndex`;
5. obtains each emitter's immutable `codeHash` from the Kernel deployment record;
6. resolves a verified ABI/interface declaration for `(worldId, emitter, codeHash)`;
7. decodes each record's topics and data under that ABI;
8. stores application-level indexes for emitter, selector, addresses, token IDs and other decoded fields;
9. orders executions by `(blockNumber, transactionIndex, logIndex)` and records within them by `vmLogIndex`;
10. handles chain reorganizations using `blockHash` and a confirmation policy.

Application selectors are deliberately not exposed as Ethereum topics. An RPC provider cannot directly filter for a virtual `Transfer` or `Swap`; the SwapVM indexer ingests the one receipt per execution and builds those secondary indexes itself.

The globally unique record key is:

```text
keccak256(chainId, kernelAddress, blockHash, transactionHash, logIndex, vmLogIndex)
```

An inner event selector is only a claim made by a program. A malicious mini-contract can append a `Transfer`-shaped record, so indexers and wallets MUST bind decoding and trust labels to the exact emitter and immutable code hash. SRC compliance requires both a registered immutable code hash and conformance tests proving that all standardized state changes emit their required virtual records. If an event-derived view disagrees with `staticCall` at the same block, the VM state result is authoritative.

Before signing, the Router/UI must display:

- estimated executed bytes;
- byte-gas limit;
- byte-gas price;
- maximum TOKEN exposure;
- estimated actual burn;
- gross and estimated net TOKEN output.

## 24. Failure table

| Condition | Result |
|---|---|
| VM action attached to sell | Revert/reject |
| Exact-output VM buy | Revert |
| Zero/excessive byte-gas limit | Revert |
| Gross output below maximum gas exposure | Revert |
| Invalid signature/nonce/buy binding | Revert |
| Invalid bytecode/jump/opcode | Revert |
| Executed bytes exceed limit | Revert with `OutOfByteGas` |
| Mini-contract/child call reverts | Revert buy |
| Ethereum OOG | Revert buy |
| TOKEN take/burn fails | Revert buy |
| Empty buy hookData | Execute one-byte NOP |
| Successful VM buy | Burn actual byte gas and deliver net TOKEN |
| Ordinary sell | No VM, no byte gas, zero Hook delta |

## 25. Security boundaries

### External calls

User bytecode cannot call EVM addresses. Hook dependencies are limited to the audited PoolManager, immutable Gas Token and fixed Kernel-controlled code storage.

### Reentrancy

- callback callable only by configured PoolManager;
- World-scoped VM reentrancy guard;
- Gas Token with no callbacks;
- Mini AMM syscalls never call user programs;
- cross-World reentrancy forbidden.

### Meter integrity

- add instruction length before execution;
- use checked arithmetic;
- one shared meter across nested calls and constructors;
- never reset on child return;
- immutable ISA/syscall encodings per World;
- independent simulator must match onchain byte counts.

### Buy-output solvency

- check maximum exposure before executing user code;
- actual burn cannot exceed signed limit;
- net output is exactly gross output minus actual burn;
- all PoolManager deltas settle to zero;
- no sell-side TOKEN reserve or refund exists.

### Exit safety

- sell direction branches out before envelope decoding and interpreter entry;
- user code cannot install sell restrictions;
- VM failure cannot affect unrelated sells;
- Gas Token itself must not contain transfer traps or pausing authority.

## 26. Required components

```text
SwapVMHook
- direction gate
- afterSwap output fee and burn
- signed minimum-net and delta-bound checks
- authenticated Kernel entry

SwapVMKernel
- mutable execution callable only by the bound Hook
- actor/nonces/execution height
- namespaced program state
- aggregate receipt construction and single VMLog emission
- public staticCall

WorldFactory
- Gas Token deployment
- immutable WorldConfig
- pool initialization and sealing

MiniVMInterpreter
- validator
- stack/memory/calls
- executed-byte meter
- deterministic ISA v1 implementation used by Kernel

MiniVMCodeStore
- immutable content-addressed code

StandardProgramRegistry
- interface identifiers and audited reference code hashes
- no authority over user-deployed program state

ReferencePrograms
- SRC-20 / SRC-721 / SRC-1155
- constant-product AMM
- standard library and conformance tests

SwapVMRouter
- exact-input VM buys
- gas-limit/output solvency checks
- ordinary sells without VM payload
- envelope and signature handling

TinySol toolchain
- compiler, ABI, validator, disassembler
- local execution simulator and byte estimator

VM event indexer
- canonical Kernel `VMLog` receipt scanner
- strict versioned receipt decoder
- Kernel deployment/code-hash resolver
- ABI registry and application-event decoder
- reorg-safe derived views
```

## 27. Transaction lifecycles

### VM buy

```text
1. User chooses ETH input, target action and byteGasLimit.
2. User signs VMEnvelope bound to the buy.
3. Router submits exact-input ETH -> TOKEN swap.
4. PoolManager computes gross TOKEN output.
5. afterSwap verifies output covers maximum byte gas.
6. Hook verifies callback pool, signed minimum net output and callback-bound buy fields.
7. Kernel verifies actor signature, deadline and nonce.
8. Kernel executes, counts bytes, commits tentative VM changes and emits one aggregate VMLog.
9. Hook calculates the checked TOKEN burn.
10. Hook takes and burns that amount and returns the positive output-token delta.
11. Buyer receives the remainder through the canonical Router.
12. PoolManager settlement, VM state, nonce, height, burn and VMLog commit atomically.
```

### NOP buy

```text
1. User buys TOKEN with empty VM payload.
2. Kernel executes one-byte STOP.
3. Hook burns exactly one byte-gas unit.
4. Kernel emits one receipt whose only virtual record is the Kernel execution summary.
5. Buyer receives gross output minus one byte-gas unit.
```

### Sell

```text
1. User submits TOKEN -> ETH swap without VM payload.
2. Hook detects sell direction and returns zero immediately.
3. PoolManager performs an ordinary v4 sell.
4. No VM state, nonce, height or TOKEN supply changes occur through SwapVM.
```

## 28. Testable invariants

Deployment is blocked until tests prove:

1. only exact-input ETH -> TOKEN buys enter the interpreter;
2. sells never mutate VM state or burn VM TOKEN gas;
3. `tokenBurned = executedBytes * byteGasPrice` on success;
4. loops, constructors and child calls meter correctly;
5. failed buys burn no TOKEN and commit no VM state;
6. net TOKEN output equals gross minus actual burn;
7. no success exceeds signed byte-gas limit;
8. exact-output VM buys revert;
9. World namespaces cannot cross;
10. canonical SRC reference implementations enforce their documented mint/burn permissions;
11. canonical AMM reference programs conserve token balances and reserves;
12. replayed envelopes fail;
13. router identity cannot impersonate actor;
14. child failure reverts parent and Kernel changes;
15. user bytecode cannot encode arbitrary EVM calls;
16. PoolManager deltas settle to zero;
17. simulator/onchain results and byte counts match;
18. canonical NOP is exactly one executed byte;
19. a malicious program cannot affect an unrelated sell;
20. the real Gas Token supply decreases by exactly actual burn.
21. each successful VM execution emits exactly one Ethereum `VMLog` from the registered Kernel;
22. zero or multiple virtual events never change the one-receipt rule;
23. the interpreter, not user bytecode, determines `worldId`, `emitter`, `executionHeight` and record order;
24. failed buys and ordinary sells leave no `VMLog` receipt;
25. record order preserves emission order across nested calls and constructors;
26. malformed lengths, unsupported versions and event count/topic/payload limit violations are rejected;
27. decoding then re-encoding a valid receipt produces identical bytes;
28. `maxGasExposure`, actual burn and returned Hook delta never exceed `int128.max`;
29. every signed success preserves `minNetTokenOut` and every NOP success has positive net output;
30. EOA, contract, Kernel and zero AccountId namespaces cannot collide;
31. mini-contract AccountIds can own, approve and exchange canonical SRC assets;
32. `staticCall` cannot mutate state, emit a receipt, advance height, consume nonce or burn TOKEN;
33. Hook and Kernel code hashes match the sealed WorldConfig and neither is a proxy;
34. exactly one Kernel execution-summary record exists in every valid VMReceipt;
35. unrelated PoolManager and ERC-20 logs cannot be mistaken for VMReceipt records;
36. EIP-712 signatures fail when actor or any pool, payload, input, recipient, router, executor, price-limit, nonce, deadline or gas field changes;
37. a changed digest can never be accepted under a newly recovered fresh actor, including at nonce zero;
38. v1.0 action signatures are invalid under the v1.1 domain and type hash.

Required verification:

- instruction-level unit tests;
- Foundry fuzzing for direction, delta signs, output fees and envelope decoding;
- stateful invariants across buys, sells, deployments, assets and AMMs;
- differential interpreter tests;
- adversarial loop/recursion/malformed-code tests;
- event-envelope, nested-emitter, rollback, limit and indexer reorg tests;
- AccountId collision/property tests and contract-owned SRC asset tests;
- staticCall/state-call differential tests;
- dependency-code-hash and non-proxy deployment assertions;
- external review of custom accounting and AMM math.

## 29. Implementation order

### Stage 1: buy-only byte-gas Hook

- one ETH/TOKEN World;
- pin exact v4-core and v4-periphery dependency commits;
- NOP buy only;
- one-byte meter;
- afterSwap TOKEN take and real burn;
- normal sell bypass;
- prove positive unspecified-currency delta, supply, settlement and exit invariants.

### Stage 2: metered VM kernel

- EIP-712 envelope/nonce;
- tagged AccountId model;
- bytecode validator;
- stack, memory, storage and control flow;
- shared executed-byte meter;
- public staticCall and state/view differential tests;
- differential byte-count tests.

### Stage 3: composition/deployment

- swap-gated DEPLOY;
- CALL/STATICCALL/CREATE;
- canonical ProgramPackageV1 and creator nonces;
- immutable code store;
- nested metering.

### Stage 4: programmable asset standards

- SRC-165 interface discovery;
- SRC-20, SRC-721 and SRC-1155 reference mini-programs;
- verified code-hash registry and conformance suite.

### Stage 5: programmable AMMs

- reference constant-product AMM mini-program;
- token-call, reserve and LP-share invariant tests;
- no privileged AMM Kernel path.

### Stage 6: aggregate receipt, indexer and TinySol

- exactly one canonical Ethereum `VMLog` receipt per successful execution;
- versioned `VMReceipt` codec and bounded Kernel receipt builder;
- nested-log ordering, malformed-payload and rollback tests;
- reorg-safe reference indexer and verified ABI registry;
- compiler, event ABI, simulator and byte estimation.

### Stage 7: release gate

- stateful fuzzing;
- independent audit;
- bug bounty;
- small-cap experimental deployment only after all invariants hold.

## 30. Frozen v1.1 decisions

```text
World topology:         one v4 pool = one isolated World
Protocol topology:      immutable Hook + immutable Kernel per deployment
VM trigger:             ETH -> TOKEN buy only
VM buy mode:            exact input only
Sell behavior:          ordinary v4 swap; no VM and no VM burn
VM fee unit:            actual executed mini-bytecode byte
VM fee formula:         executedBytes * immutable byteGasPrice
Maximum exposure:       signed byteGasLimit * byteGasPrice
Net-output protection:  signed minNetTokenOut after actual burn
Fee source:             actual TOKEN buy output
Loops/nested calls:     repeated/shared byte metering
Constructor:            metered
Unused code:            not charged
Calldata/storage:       no separate TOKEN fee
Actual resource meter:  Ethereum gas
VM expressiveness:      Turing-complete
Continuation:           none
Programs:               immutable
VM accounts:            tagged 32-byte AccountId
Root authentication:    EIP-712 low-s EOA signatures bound to explicit actor
Smart-wallet signing:   not in v1
Mini-assets:            user-deployed programs internal to one World
Token/NFT Kernel:       none; standards are mini-contract interfaces
Mini AMM Kernel:        none; AMMs are deployable mini-programs
External EVM calls:     forbidden to user bytecode
Read-only access:       public Kernel staticCall; no buy/burn/log/state
NOP buy:                one STOP byte; zero actor; no nonce change
Failure:                revert buy, burn and all VM state
SwapVM receipt count:   exactly one VMLog per successful VM execution
Ethereum event ABI:     VMLog(worldId, executionHeight, payload)
Application events:     ordered VMRecords inside one versioned payload
Event history:          Ethereum receipt logs, not duplicated in VM storage
Event emitter:          registered SwapVMKernel address
Application filtering:  secondary indexes built after payload decoding
Infrastructure:         sealed code hashes; no proxies or admin upgrades
```

## 31. Immutable deployment manifest

The protocol has no remaining semantic choices for v1. Every deployed World publishes one machine-readable manifest containing:

```text
chainId
PoolManager address and code hash
Hook address and code hash
Kernel address and code hash
Gas Token address, code hash, decimals, total supply and distribution commitment
PoolKey / worldId
vmVersion / isaHash / receiptVersion
byteGasPrice / maxByteGasLimit
code, stack, memory, call-depth and receipt ceilings
TinySol compiler version and hash
canonical Router address and code hash
reference SRC and AMM code hashes
deployment block and source-control commit
```

Values such as TOKEN supply, `byteGasPrice`, outer LP fee, reference mini-AMM fee and deployment chain are World economics rather than unresolved protocol behavior. They are chosen before pool initialization, checked against v1 hard bounds, sealed, and never changed. Metadata and application ABI formats belong to their SRC/application standards and cannot alter Kernel consensus semantics.

## 32. References

- Uniswap v4 Hooks: https://developers.uniswap.org/docs/protocols/v4/concepts/hooks
- v4 custom accounting/hook fees: https://developers.uniswap.org/docs/protocols/v4/guides/custom-accounting
- v4 Hook security framework: https://developers.uniswap.org/docs/protocols/v4/security
- v4 Core Hooks library: https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol
- Ethereum code-size limit: https://eips.ethereum.org/EIPS/eip-170
- Frozen SwapVM ISA v1: `SwapVM-ISA-v1.json` (`isaHash = 0x2f0059846af771cb9f77e74d5f728744a9b8dbe69313d146b8a5e7fdcbe7c118`)

## 33. One-sentence specification

> SwapVM is a Turing-complete microcomputer that executes only when a user buys its World Token, charges gas by actually executed mini-bytecode bytes, and lets users deploy their own token, NFT, AMM and application programs without privileged built-in asset logic.
