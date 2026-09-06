contract MintableSRC20 {
  event Transfer(account indexed from, account indexed to, uint256 amount);
  event Approval(account indexed owner, account indexed spender, uint256 amount);

  uint256 issued;
  mapping(account => uint256) balances;
  mapping(account => account) approvedSpenders;
  mapping(account => uint256) approvedAmounts;
  account zeroAccount;

  constructor() {
    issued = 0;
  }

  function mint(account to) returns (uint256) {
    require(to != zeroAccount);
    require(issued <= 9999000000000000000000000);
    issued = issued + 1000000000000000000000;
    balances[to] = balances[to] + 1000000000000000000000;
    emit Transfer(zeroAccount, to, 1000000000000000000000);
    return 1000000000000000000000;
  }

  function transfer(account to, uint256 amount) returns (bool) {
    require(to != zeroAccount);
    require(balances[msg.sender] >= amount);
    balances[msg.sender] = balances[msg.sender] - amount;
    balances[to] = balances[to] + amount;
    emit Transfer(msg.sender, to, amount);
    return true;
  }

  function approve(account spender, uint256 amount) returns (bool) {
    require(spender != zeroAccount);
    approvedSpenders[msg.sender] = spender;
    approvedAmounts[msg.sender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function allowance(account owner, account spender) view returns (uint256) {
    if (approvedSpenders[owner] != spender) {
      return 0;
    }
    return approvedAmounts[owner];
  }

  function transferFrom(account from, account to, uint256 amount) returns (bool) {
    require(to != zeroAccount);
    require(approvedSpenders[from] == msg.sender);
    require(approvedAmounts[from] >= amount);
    require(balances[from] >= amount);
    approvedAmounts[from] = approvedAmounts[from] - amount;
    balances[from] = balances[from] - amount;
    balances[to] = balances[to] + amount;
    emit Transfer(from, to, amount);
    return true;
  }

  function balanceOf(account owner) view returns (uint256) {
    return balances[owner];
  }

  function totalSupply() view returns (uint256) {
    return issued;
  }

  function mintAmount() view returns (uint256) {
    return 1000000000000000000000;
  }

  function cap() view returns (uint256) {
    return 10000000000000000000000000;
  }

  function decimals() view returns (uint256) {
    return 18;
  }

  function name() view returns (bytes32) {
    return 0x4d696e7461626c65205352433230000000000000000000000000000000000000;
  }

  function symbol() view returns (bytes32) {
    return 0x6d53524332300000000000000000000000000000000000000000000000000000;
  }
}
