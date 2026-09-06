contract Counter {
  uint256 value;

  constructor(uint256 initial) {
    value = initial;
  }

  function increment(uint256 amount) returns (uint256) {
    value = value + amount;
    return value;
  }

  function get() view returns (uint256) {
    return value;
  }
}
