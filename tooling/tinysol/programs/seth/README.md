# sETH

`SETH` is the experimental MiniVM side of the SwapVM v1.2 atomic ETH bridge.
One sETH wei represents one native ETH wei held as explicit liability by one
immutable EVM `SwapVMSETHVault`.

The public bridge methods are deliberately narrow:

- `bridgeMint(to, amount)` is callable only when `tx.executor` is the immutable
  Vault and creates exactly `amount` sETH for `to`.
- `bridgeBurn(amount)` is callable only through that Vault and destroys exactly
  `amount` from the signed `tx.actor`.

Ordinary `transfer`, balance, supply and metadata methods remain available. The
program has no owner, upgrade, pause, arbitrary mint or arbitrary burn path.
The EVM Vault validates every signed payload and preserves the ETH/sETH supply
invariant around the Router call.
