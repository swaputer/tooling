contract ContextDemo {
  function actors() view returns (account, account) {
    return msg.sender, tx.actor;
  }

  function worldValues() view returns (bytes32, uint256, uint256, uint256, int256) {
    return world.id, world.executionHeight, buy.ethIn, buy.grossTokenOut, buy.tickAfter;
  }

  function chainValues() view returns (uint256, uint256, uint256, uint256, uint256) {
    return block.number, block.timestamp, gas.bytePrice, gas.bytesUsed, gas.bytesRemaining;
  }

  function evmValues() view returns (address, address, address) {
    return tx.router, tx.executor, tx.recipient;
  }

  function echoAddress(address value) view returns (address) {
    return value;
  }
}
