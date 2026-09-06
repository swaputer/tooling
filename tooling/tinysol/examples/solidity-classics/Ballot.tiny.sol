contract Ballot {
  event VoteCast(account indexed voter, uint256 indexed proposalId);

  uint256 proposalCount;
  mapping(uint256 => uint256) proposalVotes;
  mapping(account => bool) voted;

  constructor(uint256 proposals) {
    require(proposals > 1);
    proposalCount = proposals;
  }

  function vote(uint256 proposalId) external returns (uint256) {
    require(proposalId < proposalCount);
    require(!voted[msg.sender]);
    voted[msg.sender] = true;
    proposalVotes[proposalId] = proposalVotes[proposalId] + 1;
    emit VoteCast(msg.sender, proposalId);
    return proposalVotes[proposalId];
  }

  function votes(uint256 proposalId) external view returns (uint256) {
    require(proposalId < proposalCount);
    return proposalVotes[proposalId];
  }

  function hasVoted(account voter) external view returns (bool) {
    return voted[voter];
  }
}
