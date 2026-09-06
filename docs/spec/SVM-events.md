# SVM Events

## Status

This document defines the public terminology and wire identifier used by the
current Swaputer protocol.

## Public terminology

Protocol documentation, APIs, indexer schemas, user interfaces, and diagrams use
**Events** for records emitted by SVM programs. The outer Solidity event emitted by
the Kernel is:

```solidity
event Events(bytes32 indexed worldId, uint64 indexed executionHeight, bytes payload);
```

Its Ethereum topic is:

```text
0x602812b230e5dc416bb4163643fb95093808246664e5b824bf2849ffb8c33d04
```

`payload` remains the canonical encoded SVM receipt. Renaming the outer event does
not change the receipt encoding, record ordering, rollback behavior, or event
authentication rules.

## Ethereum terminology that remains unchanged

The following names belong to Ethereum and are not renamed:

- JSON-RPC `eth_getLogs`;
- transaction receipt `logs`;
- receipt `logIndex`;
- EVM `LOG0` through `LOG4` instructions.

Implementations may expose these raw fields when presenting Ethereum provenance,
but must use **Events** for the SVM application model.

## Deployment identity

The Solidity event signature is part of the Kernel runtime identity. Every
deployment using `Events` must publish a matching deployment manifest and Kernel
code hash. Indexers start from that deployment's configured start block and do not
interpret data emitted by obsolete deployments.
