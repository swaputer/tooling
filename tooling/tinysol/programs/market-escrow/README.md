# MarketEscrow

`MarketEscrow` is an experimental, unaudited TinySol helper for the v1.2 local
market line. It is not a canonical reference package.

The program holds SRC20 balances inside the MiniVM, not in an EVM ERC-20. The
EVM market is allowed to trigger exactly two methods by submitting signed VM
actions through the canonical Router with `authorizedExecutor == market`:

- `deposit(from, amount)` pulls tokens from `from` into `self.account` through
  `SRC20.transferFrom`. The seller must approve the escrow MiniVM account first.
- `release(to, amount)` sends escrowed tokens to `to` through `SRC20.transfer`.

The `tx.executor` check depends on the v1.2 executor-context opcodes. A direct
Router call or a different EVM contract cannot satisfy the market binding.
