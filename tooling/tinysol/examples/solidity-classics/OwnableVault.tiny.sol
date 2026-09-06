interface VaultSRC20 {
  function transfer(account, uint256) returns (bool);
  function transferFrom(account, account, uint256) returns (bool);
  function balanceOf(account) view returns (uint256);
}

contract OwnableVault {
  event Deposited(account indexed depositor, uint256 amount);
  event Withdrawn(account indexed recipient, uint256 amount);
  event OwnershipTransferred(account indexed previousOwner, account indexed newOwner);

  account token;
  account owner;
  account zeroAccount;

  constructor(account token_, account owner_) {
    require(token_ != zeroAccount);
    require(owner_ != zeroAccount);
    token = token_;
    owner = owner_;
  }

  function deposit(uint256 amount) external returns (uint256) {
    require(amount > 0);
    require(call VaultSRC20.transferFrom(token, msg.sender, this.id, amount));
    emit Deposited(msg.sender, amount);
    return staticcall VaultSRC20.balanceOf(token, this.id);
  }

  function withdraw(account recipient, uint256 amount) external returns (uint256) {
    require(msg.sender == owner);
    require(recipient != zeroAccount);
    require(amount > 0);
    require(call VaultSRC20.transfer(token, recipient, amount));
    emit Withdrawn(recipient, amount);
    return staticcall VaultSRC20.balanceOf(token, this.id);
  }

  function transferOwnership(account newOwner) external returns (bool) {
    require(msg.sender == owner);
    require(newOwner != zeroAccount);
    account previousOwner = owner;
    owner = newOwner;
    emit OwnershipTransferred(previousOwner, newOwner);
    return true;
  }

  function balance() external view returns (uint256) {
    return staticcall VaultSRC20.balanceOf(token, this.id);
  }

  function ownerAccount() external view returns (account) {
    return owner;
  }
}
