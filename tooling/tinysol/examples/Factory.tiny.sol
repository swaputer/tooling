interface CounterPackage {
  constructor(uint256);
  function get() view returns (uint256);
}

contract Factory {
  event Created(account indexed child, bytes32 codeHash);

  function spawn(bytes32 codeHash, uint256 initial) returns (account) {
    account child = create CounterPackage(codeHash, initial);
    emit Created(child, codeHash);
    return child;
  }
}
