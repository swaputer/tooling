contract SETH {
  event Transfer(account indexed from, account indexed to, uint256 amount);

  uint256 issued;
  mapping(account => uint256) balances;
  address trustedVault;
  account zeroAccount;
  address zeroAddress;

  constructor(address vault_) {
    require(vault_ != zeroAddress);
    trustedVault = vault_;
    issued = 0;
  }

  function move(account from, account to, uint256 amount) internal returns (bool) {
    require(to != zeroAccount);
    require(amount > 0);
    require(balances[from] >= amount);
    balances[from] = balances[from] - amount;
    balances[to] = balances[to] + amount;
    emit Transfer(from, to, amount);
    return true;
  }

  function bridgeMint(account to, uint256 amount) returns (uint256) {
    require(tx.executor == trustedVault);
    require(to != zeroAccount);
    require(amount > 0);
    uint256 nextIssued = issued + amount;
    uint256 nextBalance = balances[to] + amount;
    require(nextIssued >= issued);
    require(nextBalance >= balances[to]);
    issued = nextIssued;
    balances[to] = nextBalance;
    emit Transfer(zeroAccount, to, amount);
    return issued;
  }

  function bridgeBurn(uint256 amount) returns (uint256) {
    require(tx.executor == trustedVault);
    require(amount > 0);
    require(balances[tx.actor] >= amount);
    balances[tx.actor] = balances[tx.actor] - amount;
    issued = issued - amount;
    emit Transfer(tx.actor, zeroAccount, amount);
    return issued;
  }

  function transfer(account to, uint256 amount) returns (bool) {
    return move(msg.sender, to, amount);
  }

  function balanceOf(account owner) view returns (uint256) {
    return balances[owner];
  }

  function totalSupply() view returns (uint256) {
    return issued;
  }

  function vault() view returns (address) {
    return trustedVault;
  }

  function decimals() view returns (uint256) {
    return 18;
  }

  function name() view returns (bytes32) {
    return 0x53776170564d2042726964676564204554480000000000000000000000000000;
  }

  function symbol() view returns (bytes32) {
    return 0x7345544800000000000000000000000000000000000000000000000000000000;
  }
}
