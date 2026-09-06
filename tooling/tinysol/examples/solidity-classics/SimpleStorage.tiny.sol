contract SimpleStorage {
  event ValueChanged(account indexed actor, uint256 previousValue, uint256 newValue);

  uint256 storedValue;

  function set(uint256 newValue) external returns (uint256) {
    uint256 previousValue = storedValue;
    storedValue = newValue;
    emit ValueChanged(msg.sender, previousValue, newValue);
    return storedValue;
  }

  function get() external view returns (uint256) {
    return storedValue;
  }
}
