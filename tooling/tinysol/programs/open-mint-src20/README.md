# OpenMintSRC20

`OpenMintSRC20` is the standard package deployed by the Swaputer SRC20 creator. Every token uses the same audited-by-hash bytecode while its name, symbol, hard cap, and amount per mint are supplied as constructor arguments.

Constructor:

```text
constructor(bytes32 name, bytes32 symbol, uint256 cap, uint256 mintAmount)
```

Both supply values use 18 decimals. The constructor rejects a zero mint amount and a cap smaller than one mint. The package supports public minting plus the transfer, approval, and delegated-transfer functions needed by the SRC20 market.

Package/code hash: `0xaedd7bd1543d57afaeb94f6b46e28ba4c1ef7cdd2ad4affca011b17056036869`

