# `@swaputer/indexer`

Reorg-safe reference indexer for the current Swaputer `Events`. It scans only configured Kernel addresses and the exact `Events(bytes32,uint64,bytes)` topic, delegates receipt decoding to `@swaputer-labs/receipt-codec`, and stores canonical plus orphaned raw history in SQLite. Stage 6C adds code-hash-bound verified and declared application-event decoding without changing raw chain history.

## Commands

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run migrate:test
npm run registry:check
npm run test:e2e
```

Initialize and inspect a database:

```sh
node dist/src/cli.js init --db ./swapvm.sqlite
node dist/src/cli.js status --db ./swapvm.sqlite
node dist/src/cli.js executions --db ./swapvm.sqlite
node dist/src/cli.js records --db ./swapvm.sqlite
node dist/src/cli.js deployments --db ./swapvm.sqlite
node dist/src/cli.js registry list --db ./swapvm.sqlite
node dist/src/cli.js registry verify --db ./swapvm.sqlite
node dist/src/cli.js decode rebuild --db ./swapvm.sqlite
node dist/src/cli.js events --db ./swapvm.sqlite --canonical-only
node dist/src/operations-cli.js health --db ./swapvm.sqlite --head 1000000
node dist/src/operations-cli.js backup --source ./swapvm.sqlite --destination ./swapvm.backup.sqlite
node dist/src/operations-cli.js restore --source ./swapvm.backup.sqlite --destination ./swapvm.restored.sqlite
```

Synchronize one Kernel:

```sh
node dist/src/cli.js sync \
  --rpc http://127.0.0.1:8545 \
  --chain-id 31337 \
  --kernel 0x0000000000000000000000000000000000000001 \
  --start-block 0 \
  --target-block 1000000 \
  --confirmations 12 \
  --chunk-size 1000 \
  --max-reorg-depth 64 \
  --db ./swapvm.sqlite
```

Omit `--target-block` to scan through the current chain head. A target below `--start-block` is rejected before scanning.

`SWAPVM_RPC_URL` may replace `--rpc`. RPC URLs are never persisted or included in structured errors. The CLI prints JSON with every chain quantity represented as a decimal string.

## Public API

- `SwapVMIndexer` and injectable `RpcTransport`;
- `HttpJsonRpcTransport` using the standard JSON-RPC methods required by Stage 6B;
- `parseEvents` and `decodeOuterData` for strict events validation;
- `openIndexerDatabase` and repeatable `migrate`;
- `getStatuses`, `listExecutions`, `listRecords` and `listDeployments`;
- `normalizeEventAbiDescriptor`, canonical descriptor serialization/hash and strict static-word decoding;
- verified reference installation/verification and declared-unverified registration;
- `rebuildDecodedEvents` and `listDecodedEvents` with chain/Kernel/World/block/codeHash/event-field filters;
- stable `IndexerErrorCode` and structured `IndexerError`.
- machine-readable `getIndexerHealth`, environment-name-only multi-RPC policy,
  idempotent graceful shutdown, and overwrite-refusing SQLite backup/restore.

`registry/reference-event-layouts.json` records layouts confirmed from the reference program LOG instructions. `scripts/generate-reference-registry.mjs` verifies every package/ABI hash, selector, event topic and interface ID before generating the built-in descriptors. Application records remain lossless raw data, even when no ABI exists or strict derived decoding fails.
