interface CounterAPI {
  function increment(uint256) returns (uint256);
  function get() view returns (uint256);
}

interface ControlAPI {
  function setOrFail(bool, uint256) returns (uint256);
}

contract NestedCaller {
  function increment(account target, uint256 amount) returns (uint256) {
    return call CounterAPI.increment(target, amount);
  }

  function read(account target) view returns (uint256) {
    return staticcall CounterAPI.get(target);
  }

  function setOrFail(account target, bool ok, uint256 value) returns (uint256) {
    return call ControlAPI.setOrFail(target, ok, value);
  }
}
