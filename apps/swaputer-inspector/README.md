# Swaputer Inspector

`Swaputer Inspector` is a read-only Chrome Manifest V3 extension. On supported
Base Sepolia transaction-detail pages it verifies the transaction receipt using
an independent RPC, proves that its exact block and transaction envelope remain
canonical and finalized with at least one observed confirmation, then adds a
compact `Swaputer ✓` control beside the
transaction hash. Clicking the control opens an extension-owned side panel; no
decoded execution UI is injected into the explorer page.

## Security boundary

The explorer DOM is used only to discover a candidate transaction hash. Before
showing the verified label, the extension independently checks:

- Base Sepolia chain ID `84532`;
- exact canonical block hash, transaction envelope, finalized head and a
  one-confirmation minimum;
- the immutable Kernel address and runtime bytecode hash from the checked-in
  deployment evidence;
- exact `Events(bytes32,uint64,bytes)` topic and three-topic shape;
- the configured World ID and canonical indexed `uint64` height;
- canonical outer ABI encoding; and
- strict `VMReceiptV1` decoding through `@swaputer-labs/receipt-codec`.

It requests no wallet, account, signing, private-key, or transaction-writing
permission. It does not treat explorer-rendered content as trusted data.

## Supported pages

- `https://sepolia.basescan.org/tx/*`
- `https://base-sepolia.blockscout.com/tx/*`
- `https://sepolia-explorer.base.org/tx/*`

The release is currently bound to the active, unaudited experimental Base
Sepolia v1.2 release descriptor shared with `@swaputer-labs/cli`. It must not be
described as audited, secure, production-ready, or a mainnet release.

## Commands

```sh
npm ci
npm run build
npm run typecheck
npm test
```

The unpacked extension is emitted to `apps/swaputer-inspector/dist`.

For local visual development:

```sh
npm run dev
```

Open `http://127.0.0.1:4175/sidepanel.html` and use the verified sample control,
or append `?tx=0x...`.

## Installation

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked** and select `apps/swaputer-inspector/dist`.
5. Open a supported Base Sepolia transaction detail page.

After rebuilding an already loaded unpacked extension, click **Reload** on the
`Swaputer Inspector` card in `chrome://extensions`, then reload the explorer
transaction page. Chrome keeps the previous service worker and content script
until the unpacked extension/page is reloaded.

## Troubleshooting

- A verified label that does not open the panel indicates an outdated extension
  service worker. Version `0.1.1` opens the panel in the original click gesture
  before awaiting asynchronous storage work.
- `Open failed` on the label is an actionable extension error rather than a
  silent click. Reload the unpacked extension and inspect its service-worker
  console for the stable failure marker.
- No label on a known transaction usually means the explorer tab predates the
  latest content-script reload. Reload the explorer page after reloading the
  extension.

## Product naming

User-facing copy uses `Swaputer`. The current Ethereum Mainnet protocol identifiers are `Events`,
`VMReceiptV1`, and `SwaputerKernel`.
