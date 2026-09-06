contract MappingDemo {
  mapping(account => uint256) values;

  function set(account owner, uint256 value) {
    values[owner] = value;
  }

  function get(account owner) view returns (uint256) {
    return values[owner];
  }
}
