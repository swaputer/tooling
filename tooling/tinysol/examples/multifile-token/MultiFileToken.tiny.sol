import "./TokenMath.tiny.sol";

contract MultiFileToken {
  error Unauthorized(account actor);
  error InsufficientBalance(account actor, uint256 available, uint256 required);

  account owner;
  uint256 totalSupply;
  mapping(account => uint256) balances;

  event Transfer(account indexed from, account indexed to, uint256 amount);

  constructor() { owner = msg.sender; }

  function supply() view returns(uint256) { return totalSupply; }
  function balanceOf(account accountId) view returns(uint256) { return balances[accountId]; }

  function mint(account recipient, uint256 amount) returns(uint256) {
    if (msg.sender != owner) { revert Unauthorized(msg.sender); }
    balances[recipient] = TokenMath.add(balances[recipient], amount);
    totalSupply = TokenMath.add(totalSupply, amount);
    emit Transfer(toAccount(0x0000000000000000000000000000000000000000), recipient, amount);
    return totalSupply;
  }

  function transfer(account recipient, uint256 amount) returns(bool) {
    uint256 available = balances[msg.sender];
    if (available < amount) { revert InsufficientBalance(msg.sender, available, amount); }
    balances[msg.sender] = available - amount;
    balances[recipient] = TokenMath.add(balances[recipient], amount);
    emit Transfer(msg.sender, recipient, amount);
    return true;
  }
}
