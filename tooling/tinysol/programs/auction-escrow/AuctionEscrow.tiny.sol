interface SRC20 {
  function transfer(account, uint256) returns (bool);
  function transferFrom(account, account, uint256) returns (bool);
  function balanceOf(account) view returns (uint256);
}

contract AuctionEscrow {
  account token;
  address auction;
  uint256 accountedBalance;

  constructor(account token_, address auction_) {
    token = token_;
    auction = auction_;
    accountedBalance = 0;
  }

  function deposit(account from, uint256 amount) returns (uint256) {
    require(tx.executor == auction);
    uint256 balanceBefore = staticcall SRC20.balanceOf(token, this.id);
    require(call SRC20.transferFrom(token, from, this.id, amount));
    uint256 balanceAfter = staticcall SRC20.balanceOf(token, this.id);
    require(balanceAfter >= balanceBefore);
    require(balanceAfter - balanceBefore == amount);
    uint256 nextBalance = accountedBalance + amount;
    require(nextBalance >= accountedBalance);
    accountedBalance = nextBalance;
    return accountedBalance;
  }

  function release(account recipient, uint256 amount) returns (uint256) {
    require(tx.executor == auction);
    require(accountedBalance >= amount);
    uint256 balanceBefore = staticcall SRC20.balanceOf(token, this.id);
    require(balanceBefore >= amount);
    require(call SRC20.transfer(token, recipient, amount));
    uint256 balanceAfter = staticcall SRC20.balanceOf(token, this.id);
    require(balanceAfter <= balanceBefore);
    require(balanceBefore - balanceAfter == amount);
    accountedBalance = accountedBalance - amount;
    return accountedBalance;
  }

  function escrowBalance() view returns (uint256) {
    return staticcall SRC20.balanceOf(token, this.id);
  }

  function tokenAccount() view returns (account) {
    return token;
  }

  function trustedAuction() view returns (address) {
    return auction;
  }
}
