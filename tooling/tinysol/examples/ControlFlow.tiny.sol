contract ControlFlow {
  uint256 stored;

  function arithmetic(uint256 value) returns (uint256) {
    uint256 i = 0;
    while (i < 3) {
      value = value + 1;
      i = i + 1;
    }
    for (uint256 j = 0; j < 2; j = j + 1) {
      value = value * 2;
    }
    if (value > 10) {
      return value;
    } else {
      return 10;
    }
  }

  function signedMath(int256 value) view returns (int256, bool) {
    return value / -2, value < -1;
  }

  function logic(bool left, bool right) view returns (bool) {
    return left && right || !left;
  }

  function setOrFail(bool ok, uint256 value) returns (uint256) {
    stored = value;
    require(ok);
    return stored;
  }

  function getStored() view returns (uint256) {
    return stored;
  }
}
