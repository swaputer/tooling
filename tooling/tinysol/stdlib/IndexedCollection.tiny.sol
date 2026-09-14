library IndexedCollection {
  function pageEnd(uint256 length, uint256 cursor, uint256 pageSize, uint256 capacity) pure returns(uint256) {
    require(length <= capacity);
    require(cursor <= length);
    uint256 end = cursor + pageSize;
    require(end >= cursor);
    if (end > length) { return length; }
    return end;
  }
}
