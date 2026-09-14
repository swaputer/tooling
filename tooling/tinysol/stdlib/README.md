# TinySol standard-library seed

These modules are deterministic source modules, not dynamically loaded runtime code.
Libraries contain pure functions only and are statically linked by `compileTinySolProject`.

- `CheckedMath` provides checked unsigned add, subtract and multiply helpers.
- `Auth` provides owner and bit-mask role predicates.
- `Accounts` provides checked EVM-address/AccountId conversions.
- `Crypto` exposes the frozen `KECCAK256` and `ECRECOVER` intrinsics.
- `IndexedCollection` provides checked cursor/page-end arithmetic for the bounded collection pattern.
- `SRC20` and `SRC721` provide canonical interface declarations.

The collection helpers are added with bounded collections; no helper in this directory allocates
unbounded storage or performs network, wallet or environment-dependent work.
