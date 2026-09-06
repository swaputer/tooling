contract MiniNFT {
  event Transfer(account indexed from, account indexed to, uint256 tokenId);
  mapping(uint256 => account) ownerOfToken;
  account zeroAccount;

  constructor(account zero) {
    zeroAccount = zero;
  }

  function mint(account to, uint256 tokenId) {
    ownerOfToken[tokenId] = to;
    emit Transfer(zeroAccount, to, tokenId);
  }

  function ownerOf(uint256 tokenId) view returns (account) {
    return ownerOfToken[tokenId];
  }
}
