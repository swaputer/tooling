interface SRC20 {
  function totalSupply() view returns(uint256);
  function balanceOf(account) view returns(uint256);
  function transfer(account,uint256) returns(bool);
  function allowance(account,account) view returns(uint256);
  function approve(account,uint256) returns(bool);
  function transferFrom(account,account,uint256) returns(bool);
}
