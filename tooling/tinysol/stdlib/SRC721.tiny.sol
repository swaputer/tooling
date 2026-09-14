interface SRC721 {
  function ownerOf(uint256) view returns(account);
  function balanceOf(account) view returns(uint256);
  function approve(account,uint256) returns(bool);
  function transferFrom(account,account,uint256) returns(bool);
}
