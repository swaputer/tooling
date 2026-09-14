library Accounts {
  function fromAddress(address value) pure returns(account) {
    return toAccount(value);
  }

  function toEvmAddress(account value) pure returns(address) {
    return toAddress(value);
  }
}
