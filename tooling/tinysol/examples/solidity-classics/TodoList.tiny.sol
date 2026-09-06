contract TodoList {
  event TaskCreated(uint256 indexed taskId, bytes32 text);
  event TaskToggled(uint256 indexed taskId, bool completed);

  uint256 taskCount;
  mapping(uint256 => bytes32) taskText;
  mapping(uint256 => bool) taskCompleted;
  bytes32 emptyText;

  function createTask(bytes32 text) external returns (uint256) {
    require(text != emptyText);
    uint256 taskId = taskCount;
    taskText[taskId] = text;
    taskCompleted[taskId] = false;
    taskCount = taskCount + 1;
    emit TaskCreated(taskId, text);
    return taskId;
  }

  function toggle(uint256 taskId) external returns (bool) {
    require(taskId < taskCount);
    bool completed = !taskCompleted[taskId];
    taskCompleted[taskId] = completed;
    emit TaskToggled(taskId, completed);
    return completed;
  }

  function get(uint256 taskId) external view returns (bytes32, bool) {
    require(taskId < taskCount);
    return taskText[taskId], taskCompleted[taskId];
  }

  function count() external view returns (uint256) {
    return taskCount;
  }
}
