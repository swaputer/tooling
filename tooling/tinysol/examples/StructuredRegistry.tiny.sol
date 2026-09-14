contract StructuredRegistry {
  const uint256 CAPACITY = 8;
  enum Status { Pending, Active, Closed }
  struct Record { account owner; uint256 value; Status status; }

  Record[8] records;

  event RecordUpdated(uint256 indexed index, account indexed owner, uint256 value, Status status);

  function set(uint256 index, Record record) {
    require(index < CAPACITY);
    records[index] = record;
    emit RecordUpdated(index, record.owner, record.value, record.status);
  }

  function get(uint256 index) view returns(Record) {
    require(index < CAPACITY);
    return records[index];
  }
}
