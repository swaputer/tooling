# Foundry golden receipts

The `raw/*.json` files are emitted from real deterministic Foundry executions by `test/utils/ReceiptFixture.sol`. They independently flatten every record's emitter, topics and data. The public fixture files in this directory materialize those arrays into readable record objects.

Regenerate every fixture without RPC access using:

```sh
SWAPVM_WRITE_RECEIPT_FIXTURES=1 forge test \
  --match-test 'test_stage6A_fixture|test_authenticatedCallExecutesMetersStoresBurnsAndAdvancesNonce|test_stage3DeployValidatesPackageRunsConstructorAndEmitsTwoRecords' \
  -vv
cd tooling/receipt-codec
npm run generate:fixtures
```

Normal Foundry runs regenerate the raw JSON in memory and compare it byte-for-byte with the committed files. TypeScript build/typecheck verifies that every materialized fixture still matches its raw Foundry source.
