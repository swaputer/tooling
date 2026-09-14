library Auth {
  function isOwner(account actor, account owner) pure returns(bool) {
    return actor == owner;
  }

  function hasRole(uint256 roles, uint256 mask) pure returns(bool) {
    return (roles & mask) == mask;
  }
}
