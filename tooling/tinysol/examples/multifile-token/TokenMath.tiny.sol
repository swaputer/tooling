library TokenMath {
  function add(uint256 a, uint256 b) pure returns(uint256) {
    uint256 result = a + b;
    require(result >= a);
    return result;
  }
}
