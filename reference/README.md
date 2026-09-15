# SwapVM v1 reference packages

The four JSON files in this directory are the canonical Stage-4/5 reference artifacts. Each contains the exact ABI descriptor, function selectors, event topics, `abiHash`, MiniVM code, complete `ProgramPackageV1` bytes and whole-package `codeHash`.

Regenerate them deterministically from the reviewed assembler source with:

```sh
python3 script/generate_reference_programs.py
```

`abiHash` is Keccak-256 of the exact UTF-8 bytes in `abiCanonical`. `codeHash` is Keccak-256 of the exact `package` bytes. `SwaputerProgramRegistry` hard-codes both hashes and the interface ID, so matching only a claimed selector set is insufficient for verification.

Published v1 interfaces:

- SRC-165: `supportsInterface(bytes4)`;
- SRC-20 interface ID `0x2633673d`, with fixed-word `bytes32` name/symbol returns and constructor `(name, symbol, decimals, initialSupply, owner)`;
- SRC-721 interface ID `0xfd386dba`, with fixed-word `bytes32` name/symbol/token-URI-hash returns and constructor `(name, symbol, tokenId, owner, tokenURIHash)`;
- SRC-1155 interface ID `0xb9544cff`, with `balanceOf`, operator approval, single transfer and fixed-word URI-hash lookup, and constructor `(uriHash, id, amount, owner)`.
- CPAMM interface ID `0x94baf55f`, with one-time pair creation, proportional LP shares, exact-input swaps, reserve queries and a constructor with no arguments.

All mini-account arguments and indexed account fields use the frozen tagged `bytes32 AccountId`, never EVM `address`. The SRC-1155 v1 reference deliberately has no batch ABI; any batch extension has a different ABI/interface/code hash. Minting occurs only in each immutable asset reference constructor. The CPAMM calls SRC-20 programs through ordinary metered MiniVM `CALL`, and the Kernel provides neither an asset ledger nor a privileged AMM path.
