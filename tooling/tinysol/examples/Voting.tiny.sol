contract Voting {
  const uint256 CAPACITY = 16;
  const uint256 ADMIN_ROLE = 1;

  struct Proposal { account creator; uint256 votes; bool open; }

  uint256[16] proposalIds;
  uint256 proposalCount;
  mapping(uint256 => bool) present;
  mapping(uint256 => uint256) positionPlusOne;
  mapping(uint256 => Proposal) proposals;
  mapping(account => uint256) roles;

  event ProposalSet(uint256 indexed id, account indexed creator, bool open);
  event ProposalRemoved(uint256 indexed id);

  constructor() { roles[msg.sender] = ADMIN_ROLE; }

  function length() view returns(uint256) { return proposalCount; }
  function contains(uint256 id) view returns(bool) { return present[id]; }

  function get(uint256 id) view returns(Proposal) {
    require(present[id]);
    return proposals[id];
  }

  function set(uint256 id, Proposal proposal) {
    require((roles[msg.sender] & ADMIN_ROLE) == ADMIN_ROLE);
    if (!present[id]) {
      require(proposalCount < CAPACITY);
      proposalIds[proposalCount] = id;
      positionPlusOne[id] = proposalCount + 1;
      present[id] = true;
      proposalCount = proposalCount + 1;
    }
    proposals[id] = proposal;
    emit ProposalSet(id, proposal.creator, proposal.open);
  }

  function remove(uint256 id) {
    require((roles[msg.sender] & ADMIN_ROLE) == ADMIN_ROLE);
    require(present[id]);
    uint256 index = positionPlusOne[id] - 1;
    uint256 lastIndex = proposalCount - 1;
    uint256 lastId = proposalIds[lastIndex];
    proposalIds[index] = lastId;
    positionPlusOne[lastId] = index + 1;
    present[id] = false;
    positionPlusOne[id] = 0;
    proposalCount = lastIndex;
    emit ProposalRemoved(id);
  }

  function page(uint256 cursor, uint256 pageSize) view returns(uint256,uint256,uint256,uint256) {
    require(cursor <= proposalCount);
    require(pageSize <= 2);
    uint256 first = 0;
    uint256 second = 0;
    uint256 next = cursor;
    if (pageSize > 0 && next < proposalCount) { first = proposalIds[next]; next = next + 1; }
    if (pageSize > 1 && next < proposalCount) { second = proposalIds[next]; next = next + 1; }
    return first, second, next, proposalCount;
  }
}
