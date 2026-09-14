# Bounded indexed collection pattern

A collection declares an explicit compile-time capacity, a fixed key array, a length word,
an index mapping and one or more value mappings. Mutation must check `length < CAPACITY`
before inserting a new key. Removal swaps the last key into the removed position, updates its
index, clears membership, and decrements length. Reads expose `length`, `contains`, `get` and a
cursor/page-size pair; `IndexedCollection.pageEnd` validates the cursor and clamps the page end.

This is a storage pattern rather than a VM primitive. Capacity is visible in the fixed-array
storage layout, every dynamic array index is checked before `SLOAD` or `SSTORE`, and failed
mutations rely on SwapVM transaction atomicity. `examples/Voting.tiny.sol` is the executable
reference implementation of `length`, `contains`, `get`, `set`, `remove` and cursor-based reads.
