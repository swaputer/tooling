library CheckedMath {
  function add(uint256 a, uint256 b) pure returns(uint256) {
    uint256 result = a + b;
    require(result >= a);
    return result;
  }

  function sub(uint256 a, uint256 b) pure returns(uint256) {
    require(a >= b);
    return a - b;
  }

  function mul(uint256 a, uint256 b) pure returns(uint256) {
    uint256 result = a * b;
    require(a == 0 || result / a == b);
    return result;
  }
}
