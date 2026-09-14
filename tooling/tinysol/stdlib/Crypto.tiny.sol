library Crypto {
  function hashWord(bytes32 value) pure returns(bytes32) {
    return keccak256(value);
  }

  function recover(bytes32 digest, uint256 v, bytes32 r, bytes32 s) pure returns(account) {
    return ecrecover(digest, v, r, s);
  }
}
