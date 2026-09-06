contract EventDemo {
  event Changed(account indexed actor, uint256 value, bool enabled);
  uint256 current;

  function set(uint256 value, bool enabled) {
    current = value;
    emit Changed(msg.sender, value, enabled);
  }

  function get() view returns (uint256) {
    return current;
  }
}
