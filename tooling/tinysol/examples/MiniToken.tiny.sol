contract MiniToken {
  event Transfer(account indexed from, account indexed to, uint256 amount);
  uint256 totalSupply;
  mapping(account => uint256) balance;

  constructor(uint256 supply, account owner) {
    totalSupply = supply;
    balance[owner] = supply;
  }

  function transfer(account to, uint256 amount) returns (bool) {
    require(balance[msg.sender] >= amount);
    balance[msg.sender] = balance[msg.sender] - amount;
    balance[to] = balance[to] + amount;
    emit Transfer(msg.sender, to, amount);
    return true;
  }

  function balanceOf(account owner) view returns (uint256) {
    return balance[owner];
  }

  function supply() view returns (uint256) {
    return totalSupply;
  }
}
