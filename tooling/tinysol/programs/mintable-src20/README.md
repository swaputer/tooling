# MintableSRC20

`MintableSRC20` is an experimental, non-reference TinySol program for SwapVM. It does not modify or replace the immutable canonical `SRC20-v1` package.

Token parameters:

- name: `Mintable SRC20`
- symbol: `mSRC20`
- decimals: `18`
- fixed amount per successful `mint(bytes32)`: `1,000 * 10^18`
- hard total-supply cap: `10,000,000 * 10^18`
- initial supply: `0`

Any VM actor may call `mint(to)`, and `to` may be any nonzero tagged SwapVM `AccountId`. An EVM address must first be converted to the Kernel's canonical EOA AccountId representation. A successful mint emits the virtual event `Transfer(bytes32,bytes32,uint256)` from the zero AccountId. Minting above the cap or to the zero AccountId reverts atomically.

The program also supports `approve(spender, amount)`, `allowance(owner, spender)`, and `transferFrom(from, to, amount)` for the v1.2 escrow market. TinySol v1 has no nested mappings, so each owner has one active approved spender and allowance; approving another spender replaces the previous spender. This is an application-program limitation, not canonical `SRC20-v1` behavior.

The event descriptor is application-declared and therefore must remain `declared_unverified`; it is not a canonical SRC reference event merely because it has a Transfer-shaped signature.

Generated package identity:

- package/code hash: `0xaf15e40fe9fc1181a7143abb413562d69e1ab49a655209ac966204646c85c14b`
- ABI hash: `0xf6518e2d6671c42f1fa921077ac82214ca58214f9c72b8fee0444176e8416476`
- event descriptor hash: `0xc86ac4440cafd650d68a9d536c915452347b521ad97e5c304cc6510a8fbdb342`
- compiler status: `experimental-unaudited`

The seven generated artifacts (`.svm`, ABI, event descriptor, storage layout, manifest, assembly, and source map) are committed beside the source. Recompile them with the pinned TinySol CLI and compare the hashes before deployment.

## Base Sepolia deployments

The current v1.2 escrow-capable package was deployed through the real `SwapVMRouter.buyVMExactInput` and official Uniswap v4 PoolManager/PositionManager path as experimental contract AccountId `0x01784c2662ebe10347da4a91d31e098defc323fc7ee8b38747235bccac0085c2`. It is bound to escrow market `0xa3a7AeE97552B0546EC00401C8b795eA0BdfcBa1`. A public mint created 1,000 tokens; completed buy and sell self-tests left 1,000 tokens with the deployer, zero in escrow, zero allowance, and zero market liabilities. Evidence is recorded in `deployments/base-sepolia/swapvm-v1.2-final-market.json`.

The earlier AccountId `0x012928db8f5a86bc849ed1a66d4ff19bb5af3a9a49688aa9d6d060f41f82d8d8` is a historical pre-escrow package without `approve`/`transferFrom`; it is not used by the final v1.2 market.

This public test does not change the program's `experimental-unaudited` status and is not a recommendation to assign economic value to it.
