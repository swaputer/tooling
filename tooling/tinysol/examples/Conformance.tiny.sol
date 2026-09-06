contract Conformance {
  event AbiRoundTrip(account indexed owner, address recipient, bytes32 note, bool enabled, uint256 value);

  uint256 scalar;
  mapping(account => uint256) balances;

  constructor(uint256 initial) {
    scalar = initial;
    balances[msg.sender] = initial + 1;
  }

  function arithmetic(uint256 left, uint256 right) view returns (uint256) {
    return (left + right) * 3 - 2;
  }

  function controlFlow(uint256 value, bool doubleResult) returns (uint256) {
    uint256 i = 0;
    while (i < 2) {
      value = value + i + 1;
      i = i + 1;
    }
    if (doubleResult) {
      value = value * 2;
    }
    scalar = value;
    return scalar;
  }

  function addSeven(uint256 value) internal returns (uint256) {
    return value + 7;
  }

  function internalCall(uint256 value) returns (uint256) {
    scalar = addSeven(value);
    return scalar;
  }

  function abiRoundTrip(account owner, address recipient, bytes32 note, bool enabled, uint256 value) returns (uint256) {
    require(enabled);
    balances[owner] = value;
    emit AbiRoundTrip(owner, recipient, note, enabled, value);
    return balances[owner];
  }

  function balanceOf(account owner) view returns (uint256) {
    return balances[owner];
  }

  function getScalar() view returns (uint256) {
    return scalar;
  }
}
