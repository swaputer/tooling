// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Stage 2/3 implementation of SwapVM ISA v2, preserving v1 opcodes and adding tx context reads.
/// @dev Virtual LOG opcodes are recognized by validation but execute in a later stage.
abstract contract SwapVMMiniVM {
    uint32 internal constant MAX_BYTE_GAS_LIMIT = 1_000_000;
    uint16 internal constant MAX_CODE_BYTES = 16_384;
    uint32 internal constant MAX_MEMORY_BYTES = 65_536;
    uint16 internal constant MAX_STACK_WORDS = 1_024;
    uint16 internal constant MAX_RECEIPT_RECORDS = 64;
    uint32 internal constant MAX_RECORD_DATA_BYTES = 4_096;
    uint32 internal constant MAX_RECEIPT_PAYLOAD_BYTES = 65_536;

    uint256 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant INTERNAL_KERNEL_EMITTER_ID =
        0xff00000000000000000000000000000000000000000000000000000000000001;
    bytes32 private constant INTERNAL_DEPLOYED_SELECTOR = keccak256("MiniContractDeployed(bytes32,bytes32,bytes32)");

    mapping(bytes32 worldId => mapping(bytes32 contractId => bytes32 codeHash)) internal _contractCodeHash;
    mapping(bytes32 worldId => mapping(bytes32 codeHash => PackageInfo packageInfo)) internal _programPackages;
    mapping(bytes32 worldId => mapping(bytes32 creator => uint64 nextNonce)) public creatorNonce;
    mapping(bytes32 worldId => mapping(bytes32 contractId => mapping(bytes32 slot => bytes32 value))) internal
        _programStorage;

    struct VMContext {
        bytes32 worldId;
        bytes32 addressId;
        bytes32 caller;
        bytes32 txActor;
        address txRouter;
        address txExecutor;
        address txRecipient;
        uint64 executionHeight;
        uint128 ethAmountIn;
        uint128 grossTokenOut;
        int24 tickAfter;
        uint128 liquidityAfter;
        uint128 byteGasPrice;
        uint64 chainBlockNumber;
        uint64 chainTimestamp;
    }

    struct RunResult {
        bytes output;
        uint32 executedBytes;
        bytes32[] targets;
        bytes32[] slots;
        bytes32[] values;
        Deployment[] deployments;
        bytes records;
        uint16 recordCount;
    }

    /// @dev Packed into two slots. The Blob runtime is STOP || package/code || packed JUMPDEST bitmap.
    struct PackageInfo {
        address blob;
        uint16 packageLength;
        uint16 codeOffset;
        uint16 codeLength;
        uint16 constructorEntry;
        uint16 runtimeEntry;
        uint16 jumpdestLength;
        bytes32 blobCodeHash;
    }

    struct Deployment {
        bytes32 contractId;
        bytes32 creator;
        bytes32 codeHash;
        uint64 nonceAfter;
    }

    struct FrameSeed {
        uint32 used;
        uint16 depth;
        uint32 ancestorMemory;
        bytes32[] targets;
        bytes32[] slots;
        bytes32[] values;
        Deployment[] deployments;
        bytes records;
        uint16 recordCount;
    }

    struct StorageJournal {
        bytes32[] targets;
        bytes32[] slots;
        bytes32[] values;
        uint256 count;
        uint256 capacity;
    }

    struct FrameInput {
        bytes code;
        bytes jumpdest;
        bytes input;
        uint32 byteLimit;
        bool staticMode;
        VMContext context;
        uint256 entry;
        FrameSeed seed;
    }

    struct CreateFrame {
        FrameInput frame;
        StorageJournal journal;
        bytes vmMemory;
        uint256 memorySize;
        uint32 used;
        bytes32 codeHash;
        uint256 inputOffset;
        uint256 inputSize;
    }

    error EmptyCode();
    error CodeTooLarge(uint256 length);
    error UnknownOpcode(uint8 opcode, uint256 pc);
    error TruncatedImmediate(uint256 pc, uint8 immediateBytes);
    error InvalidJumpDestination(uint256 destination);
    error MissingHalt();
    error OutOfByteGas(uint32 used, uint32 limit);
    error InvalidByteLimit(uint32 limit);
    error StackUnderflow();
    error StackOverflow();
    error MemoryOutOfBounds(uint256 offset, uint256 size);
    error ReturnDataOutOfBounds(uint256 offset, uint256 size);
    error StaticViolation(uint8 opcode);
    error Stage2OpcodeUnsupported(uint8 opcode);
    error VMExplicitRevert(bytes data);
    error ProgramNotFound(bytes32 worldId, bytes32 target);
    error ProgramAlreadyRegistered(bytes32 worldId, bytes32 target);
    error InvalidContractAccount(bytes32 target);
    error InvalidPackageLength(uint256 length);
    error InvalidPackageMagic(bytes4 magic);
    error InvalidPackageVersion(uint16 version);
    error InvalidPackageCodeLength(uint256 declared, uint256 actual);
    error InvalidPackageEntry(uint16 entry);
    error PackageHashMismatch(bytes32 expected, bytes32 actual);
    error PackageNotRegistered(bytes32 worldId, bytes32 codeHash);
    error CallDepthExceeded(uint16 depth);
    error TotalMemoryOutOfBounds(uint256 total);
    error CreatorNonceOverflow();
    error RecordDataTooLarge(uint256 length);
    error TooManyVMRecords(uint256 count);
    error ReceiptPayloadTooLarge(uint256 length);
    error CodeBlobDeploymentFailed(bytes32 codeHash);
    error CodeBlobMismatch(address blob, bytes32 expected, bytes32 actual);

    function _registerProgram(bytes32 worldId, bytes32 target, bytes memory code) internal {
        _requireContractAccount(target);
        if (_contractCodeHash[worldId][target] != bytes32(0)) revert ProgramAlreadyRegistered(worldId, target);
        bytes memory jumpdest = _packJumpdest(_validateCode(code));
        bytes32 codeHash = keccak256(code);
        PackageInfo storage existing = _programPackages[worldId][codeHash];
        if (existing.blob == address(0)) {
            (address blob, bytes32 blobCodeHash) = _writeCodeBlob(code, jumpdest, codeHash);
            _programPackages[worldId][codeHash] = PackageInfo({
                blob: blob,
                packageLength: uint16(code.length),
                codeOffset: 1,
                codeLength: uint16(code.length),
                constructorEntry: 0,
                runtimeEntry: 0,
                jumpdestLength: uint16(jumpdest.length),
                blobCodeHash: blobCodeHash
            });
        }
        _contractCodeHash[worldId][target] = codeHash;
    }

    function _registerPackage(bytes32 worldId, bytes memory packageBytes) internal returns (bytes32 codeHash) {
        codeHash = keccak256(packageBytes);
        if (_programPackages[worldId][codeHash].blob != address(0)) return codeHash;
        (uint16 constructorEntry, uint16 runtimeEntry,, bytes memory code) = _decodePackage(packageBytes);
        bytes memory jumpdest = _packJumpdest(_validateCode(code));
        (address blob, bytes32 blobCodeHash) = _writeCodeBlob(packageBytes, jumpdest, codeHash);
        _programPackages[worldId][codeHash] = PackageInfo({
            blob: blob,
            packageLength: uint16(packageBytes.length),
            codeOffset: 45,
            codeLength: uint16(code.length),
            constructorEntry: constructorEntry,
            runtimeEntry: runtimeEntry,
            jumpdestLength: uint16(jumpdest.length),
            blobCodeHash: blobCodeHash
        });
    }

    function _instantiatePackage(bytes32 worldId, bytes32 contractId, bytes32 codeHash) internal {
        _requireContractAccount(contractId);
        if (_contractCodeHash[worldId][contractId] != bytes32(0)) {
            revert ProgramAlreadyRegistered(worldId, contractId);
        }
        if (_programPackages[worldId][codeHash].blob == address(0)) revert PackageNotRegistered(worldId, codeHash);
        _contractCodeHash[worldId][contractId] = codeHash;
    }

    function _runProgram(
        bytes32 worldId,
        bytes32 target,
        bytes memory input,
        uint32 byteLimit,
        bool staticMode,
        VMContext memory context,
        bool constructorMode
    ) internal view returns (RunResult memory result) {
        bytes32[] memory empty = new bytes32[](0);
        Deployment[] memory noDeployments = new Deployment[](0);
        FrameSeed memory seed = FrameSeed({
            used: 0,
            depth: 1,
            ancestorMemory: 0,
            targets: empty,
            slots: empty,
            values: empty,
            deployments: noDeployments,
            records: bytes(""),
            recordCount: 0
        });
        return _runProgramNested(worldId, target, input, byteLimit, staticMode, context, constructorMode, seed);
    }

    function _runProgramNested(
        bytes32 worldId,
        bytes32 target,
        bytes memory input,
        uint32 byteLimit,
        bool staticMode,
        VMContext memory context,
        bool constructorMode,
        FrameSeed memory seed
    ) private view returns (RunResult memory result) {
        if (seed.depth > 32) revert CallDepthExceeded(seed.depth);
        _requireContractAccount(target);
        bytes32 codeHash = _contractCodeHash[worldId][target];
        if (codeHash == bytes32(0)) codeHash = _pendingCodeHash(seed.deployments, target);
        if (codeHash == bytes32(0)) revert ProgramNotFound(worldId, target);
        PackageInfo storage packageInfo = _programPackages[worldId][codeHash];
        if (packageInfo.blob == address(0)) revert PackageNotRegistered(worldId, codeHash);
        (bytes memory code, bytes memory jumpdest) = _loadProgram(packageInfo);
        context.addressId = target;
        uint256 entry = constructorMode ? packageInfo.constructorEntry : packageInfo.runtimeEntry;
        FrameInput memory frame = FrameInput({
            code: code,
            jumpdest: jumpdest,
            input: input,
            byteLimit: byteLimit,
            staticMode: staticMode,
            context: context,
            entry: entry,
            seed: seed
        });
        result = _runCode(frame);
    }

    function _runCode(FrameInput memory frame) internal view returns (RunResult memory result) {
        if (frame.byteLimit == 0 || frame.byteLimit > MAX_BYTE_GAS_LIMIT) {
            revert InvalidByteLimit(frame.byteLimit);
        }
        uint256[1024] memory stack;
        uint256 stackPointer;
        bytes memory vmMemory = new bytes(MAX_MEMORY_BYTES);
        uint256 memorySize;
        bytes memory returnData = new bytes(0);

        StorageJournal memory journal;
        journal.capacity = frame.seed.slots.length < 8 ? 8 : frame.seed.slots.length * 2;
        journal.targets = new bytes32[](journal.capacity);
        journal.slots = new bytes32[](journal.capacity);
        journal.values = new bytes32[](journal.capacity);
        journal.count = frame.seed.slots.length;
        for (uint256 i; i < journal.count; ++i) {
            journal.targets[i] = frame.seed.targets[i];
            journal.slots[i] = frame.seed.slots[i];
            journal.values[i] = frame.seed.values[i];
        }

        uint256 pc = frame.entry;
        uint32 used = frame.seed.used;
        bytes memory program = frame.code;
        while (pc < program.length) {
            uint256 instructionPc = pc;
            uint8 opcode = uint8(program[pc]);
            (, uint8 immediateBytes) = _opcodeInfo(opcode);
            uint32 instructionBytes = uint32(immediateBytes) + 1;
            uint256 nextUsed = uint256(used) + instructionBytes;
            if (nextUsed > frame.byteLimit) revert OutOfByteGas(uint32(nextUsed), frame.byteLimit);
            used = uint32(nextUsed);
            pc += instructionBytes;

            if (opcode == 0x00) {
                return _finish(
                    bytes(""),
                    used,
                    journal.targets,
                    journal.slots,
                    journal.values,
                    journal.count,
                    frame.seed.deployments,
                    frame.seed.records,
                    frame.seed.recordCount
                );
            } else if (opcode >= 0x60 && opcode <= 0x7f) {
                uint256 value;
                uint256 count = uint256(immediateBytes);
                assembly ("memory-safe") {
                    let shift := shl(3, sub(32, count))
                    value := shr(shift, mload(add(add(program, 0x21), instructionPc)))
                }
                stackPointer = _push(stack, stackPointer, value);
            } else if (opcode == 0x5f) {
                stackPointer = _push(stack, stackPointer, 0);
            } else if (opcode >= 0x80 && opcode <= 0x8f) {
                uint256 depth = uint256(opcode) - 0x7f;
                if (stackPointer < depth) revert StackUnderflow();
                stackPointer = _push(stack, stackPointer, stack[stackPointer - depth]);
            } else if (opcode >= 0x90 && opcode <= 0x9f) {
                uint256 depth = uint256(opcode) - 0x8f;
                if (stackPointer <= depth) revert StackUnderflow();
                uint256 other = stackPointer - 1 - depth;
                (stack[stackPointer - 1], stack[other]) = (stack[other], stack[stackPointer - 1]);
            } else if (
                opcode == 0x01 || opcode == 0x02 || opcode == 0x03 || opcode == 0x04 || opcode == 0x05 || opcode == 0x06
                    || opcode == 0x07 || opcode == 0x0a || (opcode >= 0x10 && opcode <= 0x14)
                    || (opcode >= 0x16 && opcode <= 0x18) || (opcode >= 0x1a && opcode <= 0x1d)
            ) {
                uint256 b;
                uint256 a;
                (b, stackPointer) = _pop(stack, stackPointer);
                (a, stackPointer) = _pop(stack, stackPointer);
                stackPointer = _push(stack, stackPointer, _binary(opcode, a, b));
            } else if (opcode == 0x08 || opcode == 0x09) {
                uint256 modulus;
                uint256 b;
                uint256 a;
                (modulus, stackPointer) = _pop(stack, stackPointer);
                (b, stackPointer) = _pop(stack, stackPointer);
                (a, stackPointer) = _pop(stack, stackPointer);
                stackPointer =
                    _push(stack, stackPointer, opcode == 0x08 ? addmod(a, b, modulus) : mulmod(a, b, modulus));
            } else if (opcode == 0x15 || opcode == 0x19) {
                uint256 value;
                (value, stackPointer) = _pop(stack, stackPointer);
                stackPointer = _push(stack, stackPointer, opcode == 0x15 ? (value == 0 ? 1 : 0) : ~value);
            } else if (opcode == 0x20) {
                uint256 offset;
                uint256 size;
                (offset, stackPointer) = _pop(stack, stackPointer);
                (size, stackPointer) = _pop(stack, stackPointer);
                uint256 end = _memoryEnd(offset, size, frame.seed.ancestorMemory);
                if (end > memorySize) memorySize = end;
                bytes32 hash;
                assembly ("memory-safe") {
                    hash := keccak256(add(add(vmMemory, 0x20), offset), size)
                }
                stackPointer = _push(stack, stackPointer, uint256(hash));
            } else if (opcode == 0x21) {
                uint256 s;
                uint256 r;
                uint256 v;
                uint256 hash;
                (s, stackPointer) = _pop(stack, stackPointer);
                (r, stackPointer) = _pop(stack, stackPointer);
                (v, stackPointer) = _pop(stack, stackPointer);
                (hash, stackPointer) = _pop(stack, stackPointer);
                address recovered;
                if ((v == 27 || v == 28) && s <= SECP256K1N_HALF) {
                    recovered = ecrecover(bytes32(hash), uint8(v), bytes32(r), bytes32(s));
                }
                stackPointer = _push(stack, stackPointer, uint160(recovered));
            } else if (opcode == 0x30) {
                stackPointer = _push(stack, stackPointer, uint256(frame.context.addressId));
            } else if (opcode == 0x33) {
                stackPointer = _push(stack, stackPointer, uint256(frame.context.caller));
            } else if (opcode == 0x35) {
                uint256 offset;
                (offset, stackPointer) = _pop(stack, stackPointer);
                stackPointer = _push(stack, stackPointer, _calldataWord(frame.input, offset));
            } else if (opcode == 0x36) {
                stackPointer = _push(stack, stackPointer, frame.input.length);
            } else if (opcode == 0x37) {
                uint256 destination;
                uint256 source;
                uint256 size;
                (destination, stackPointer) = _pop(stack, stackPointer);
                (source, stackPointer) = _pop(stack, stackPointer);
                (size, stackPointer) = _pop(stack, stackPointer);
                uint256 end = _memoryEnd(destination, size, frame.seed.ancestorMemory);
                if (end > memorySize) memorySize = end;
                _copyPadded(frame.input, source, vmMemory, destination, size);
            } else if (opcode == 0x3d) {
                stackPointer = _push(stack, stackPointer, returnData.length);
            } else if (opcode == 0x3e) {
                uint256 destination;
                uint256 source;
                uint256 size;
                (destination, stackPointer) = _pop(stack, stackPointer);
                (source, stackPointer) = _pop(stack, stackPointer);
                (size, stackPointer) = _pop(stack, stackPointer);
                if (source > returnData.length || size > returnData.length - source) {
                    revert ReturnDataOutOfBounds(source, size);
                }
                uint256 end = _memoryEnd(destination, size, frame.seed.ancestorMemory);
                if (end > memorySize) memorySize = end;
                assembly ("memory-safe") {
                    mcopy(add(add(vmMemory, 0x20), destination), add(add(returnData, 0x20), source), size)
                }
            } else if (opcode == 0x42) {
                stackPointer = _push(stack, stackPointer, frame.context.chainTimestamp);
            } else if (opcode == 0x43) {
                stackPointer = _push(stack, stackPointer, frame.context.chainBlockNumber);
            } else if (opcode == 0x50) {
                (, stackPointer) = _pop(stack, stackPointer);
            } else if (opcode == 0x51) {
                uint256 offset;
                (offset, stackPointer) = _pop(stack, stackPointer);
                uint256 end = _memoryEnd(offset, 32, frame.seed.ancestorMemory);
                if (end > memorySize) memorySize = end;
                stackPointer = _push(stack, stackPointer, uint256(_memoryWord(vmMemory, offset)));
            } else if (opcode == 0x52) {
                uint256 offset;
                uint256 value;
                (offset, stackPointer) = _pop(stack, stackPointer);
                (value, stackPointer) = _pop(stack, stackPointer);
                uint256 end = _memoryEnd(offset, 32, frame.seed.ancestorMemory);
                if (end > memorySize) memorySize = end;
                _storeWord(vmMemory, offset, bytes32(value));
            } else if (opcode == 0x53) {
                uint256 offset;
                uint256 value;
                (offset, stackPointer) = _pop(stack, stackPointer);
                (value, stackPointer) = _pop(stack, stackPointer);
                uint256 end = _memoryEnd(offset, 1, frame.seed.ancestorMemory);
                if (end > memorySize) memorySize = end;
                vmMemory[offset] = bytes1(uint8(value));
            } else if (opcode == 0x54) {
                uint256 slot;
                (slot, stackPointer) = _pop(stack, stackPointer);
                bytes32 value = _journalLoad(
                    frame.context.worldId,
                    frame.context.addressId,
                    bytes32(slot),
                    journal.targets,
                    journal.slots,
                    journal.values,
                    journal.count
                );
                stackPointer = _push(stack, stackPointer, uint256(value));
            } else if (opcode == 0x55) {
                if (frame.staticMode) revert StaticViolation(opcode);
                uint256 slot;
                uint256 value;
                (slot, stackPointer) = _pop(stack, stackPointer);
                (value, stackPointer) = _pop(stack, stackPointer);
                bool updated;
                for (uint256 i = journal.count; i > 0; --i) {
                    if (journal.targets[i - 1] == frame.context.addressId && journal.slots[i - 1] == bytes32(slot)) {
                        journal.values[i - 1] = bytes32(value);
                        updated = true;
                        break;
                    }
                }
                if (updated) continue;
                if (journal.count == journal.capacity) {
                    journal.capacity = journal.capacity < 8 ? 8 : journal.capacity * 2;
                    (journal.targets, journal.slots, journal.values) =
                        _growJournal(journal.targets, journal.slots, journal.values, journal.capacity);
                }
                journal.targets[journal.count] = frame.context.addressId;
                journal.slots[journal.count] = bytes32(slot);
                journal.values[journal.count] = bytes32(value);
                ++journal.count;
            } else if (opcode == 0x56) {
                uint256 destination;
                (destination, stackPointer) = _pop(stack, stackPointer);
                _requireJumpdest(frame.jumpdest, frame.code.length, destination);
                pc = destination;
            } else if (opcode == 0x57) {
                uint256 destination;
                uint256 condition;
                (destination, stackPointer) = _pop(stack, stackPointer);
                (condition, stackPointer) = _pop(stack, stackPointer);
                if (condition != 0) {
                    _requireJumpdest(frame.jumpdest, frame.code.length, destination);
                    pc = destination;
                }
            } else if (opcode == 0x58) {
                stackPointer = _push(stack, stackPointer, instructionPc);
            } else if (opcode == 0x59) {
                stackPointer = _push(stack, stackPointer, memorySize);
            } else if (opcode == 0x5b) {
                // JUMPDEST has no runtime effect.
            } else if (opcode >= 0xa0 && opcode <= 0xa4) {
                if (frame.staticMode) revert StaticViolation(opcode);
                uint8 topicCount = opcode - 0xa0;
                bytes32[4] memory topics;
                for (uint256 i = topicCount; i > 0; --i) {
                    uint256 topic;
                    (topic, stackPointer) = _pop(stack, stackPointer);
                    topics[i - 1] = bytes32(topic);
                }
                uint256 offset;
                uint256 size;
                (offset, stackPointer) = _pop(stack, stackPointer);
                (size, stackPointer) = _pop(stack, stackPointer);
                uint256 end = _memoryEnd(offset, size, frame.seed.ancestorMemory);
                if (end > memorySize) memorySize = end;
                (frame.seed.records, frame.seed.recordCount) = _appendRecord(
                    frame.seed.records,
                    frame.seed.recordCount,
                    frame.context.addressId,
                    topicCount,
                    topics,
                    _memorySlice(vmMemory, offset, size)
                );
            } else if (opcode >= 0xb0 && opcode <= 0xbc) {
                stackPointer = _push(stack, stackPointer, _contextValue(opcode, frame.context, used, frame.byteLimit));
            } else if (opcode == 0xf3 || opcode == 0xfd) {
                uint256 offset;
                uint256 size;
                (offset, stackPointer) = _pop(stack, stackPointer);
                (size, stackPointer) = _pop(stack, stackPointer);
                uint256 end = _memoryEnd(offset, size, frame.seed.ancestorMemory);
                if (end > memorySize) memorySize = end;
                bytes memory output = _memorySlice(vmMemory, offset, size);
                if (opcode == 0xfd) revert VMExplicitRevert(output);
                return _finish(
                    output,
                    used,
                    journal.targets,
                    journal.slots,
                    journal.values,
                    journal.count,
                    frame.seed.deployments,
                    frame.seed.records,
                    frame.seed.recordCount
                );
            } else if (opcode == 0xf1 || opcode == 0xfa) {
                uint256 outputOffset;
                uint256 outputSize;
                uint256 inputOffset;
                uint256 inputSize;
                uint256 targetWord;
                (outputOffset, stackPointer) = _pop(stack, stackPointer);
                (outputSize, stackPointer) = _pop(stack, stackPointer);
                (inputOffset, stackPointer) = _pop(stack, stackPointer);
                (inputSize, stackPointer) = _pop(stack, stackPointer);
                (targetWord, stackPointer) = _pop(stack, stackPointer);
                uint256 inputEnd = _memoryEnd(inputOffset, inputSize, frame.seed.ancestorMemory);
                uint256 outputEnd = _memoryEnd(outputOffset, outputSize, frame.seed.ancestorMemory);
                if (inputEnd > memorySize) memorySize = inputEnd;
                if (outputEnd > memorySize) memorySize = outputEnd;
                bytes memory childInput = _memorySlice(vmMemory, inputOffset, inputSize);
                VMContext memory childContext =
                    _copyContext(frame.context, bytes32(targetWord), frame.context.addressId);
                FrameSeed memory childSeed = FrameSeed({
                    used: used,
                    depth: frame.seed.depth + 1,
                    ancestorMemory: uint32(uint256(frame.seed.ancestorMemory) + memorySize),
                    targets: _trim(journal.targets, journal.count),
                    slots: _trim(journal.slots, journal.count),
                    values: _trim(journal.values, journal.count),
                    deployments: frame.seed.deployments,
                    records: frame.seed.records,
                    recordCount: frame.seed.recordCount
                });
                RunResult memory child = _runProgramNested(
                    frame.context.worldId,
                    bytes32(targetWord),
                    childInput,
                    frame.byteLimit,
                    frame.staticMode || opcode == 0xfa,
                    childContext,
                    false,
                    childSeed
                );
                used = child.executedBytes;
                journal.targets = child.targets;
                journal.slots = child.slots;
                journal.values = child.values;
                journal.count = child.slots.length;
                journal.capacity = journal.count;
                frame.seed.deployments = child.deployments;
                frame.seed.records = child.records;
                frame.seed.recordCount = child.recordCount;
                returnData = child.output;
                uint256 copySize = outputSize < returnData.length ? outputSize : returnData.length;
                assembly ("memory-safe") {
                    mcopy(add(add(vmMemory, 0x20), outputOffset), add(returnData, 0x20), copySize)
                }
                stackPointer = _push(stack, stackPointer, 1);
            } else if (opcode == 0xf0) {
                if (frame.staticMode) revert StaticViolation(opcode);
                uint256 inputOffset;
                uint256 inputSize;
                uint256 codeHashWord;
                (inputOffset, stackPointer) = _pop(stack, stackPointer);
                (inputSize, stackPointer) = _pop(stack, stackPointer);
                (codeHashWord, stackPointer) = _pop(stack, stackPointer);
                uint256 inputEnd = _memoryEnd(inputOffset, inputSize, frame.seed.ancestorMemory);
                if (inputEnd > memorySize) memorySize = inputEnd;
                CreateFrame memory createFrame = CreateFrame({
                    frame: frame,
                    journal: journal,
                    vmMemory: vmMemory,
                    memorySize: memorySize,
                    used: used,
                    codeHash: bytes32(codeHashWord),
                    inputOffset: inputOffset,
                    inputSize: inputSize
                });
                (RunResult memory child, bytes32 contractId) = _executeCreate(createFrame);
                used = child.executedBytes;
                journal.targets = child.targets;
                journal.slots = child.slots;
                journal.values = child.values;
                journal.count = child.slots.length;
                journal.capacity = journal.count;
                frame.seed.deployments = child.deployments;
                frame.seed.records = child.records;
                frame.seed.recordCount = child.recordCount;
                returnData = child.output;
                stackPointer = _push(stack, stackPointer, uint256(contractId));
            } else {
                revert UnknownOpcode(opcode, instructionPc);
            }
        }
        revert MissingHalt();
    }

    function _executeCreate(CreateFrame memory creation)
        private
        view
        returns (RunResult memory child, bytes32 contractId)
    {
        PackageInfo storage packageInfo = _programPackages[creation.frame.context.worldId][creation.codeHash];
        if (packageInfo.blob == address(0)) {
            revert PackageNotRegistered(creation.frame.context.worldId, creation.codeHash);
        }
        bytes32 creator = creation.frame.context.addressId;
        uint64 nextCreationNonce =
            _nextCreatorNonce(creation.frame.context.worldId, creator, creation.frame.seed.deployments);
        if (nextCreationNonce == type(uint64).max) revert CreatorNonceOverflow();
        contractId = _deriveContractId(creation.frame.context.worldId, creator, nextCreationNonce, creation.codeHash);
        creation.frame.seed.deployments = _appendDeployment(
            creation.frame.seed.deployments,
            Deployment({
                contractId: contractId, creator: creator, codeHash: creation.codeHash, nonceAfter: nextCreationNonce + 1
            })
        );
        (bytes memory childCode, bytes memory childJumpdest) = _loadProgram(packageInfo);
        VMContext memory childContext = _copyContext(creation.frame.context, contractId, creator);
        FrameSeed memory childSeed = FrameSeed({
            used: creation.used,
            depth: creation.frame.seed.depth + 1,
            ancestorMemory: uint32(uint256(creation.frame.seed.ancestorMemory) + creation.memorySize),
            targets: _trim(creation.journal.targets, creation.journal.count),
            slots: _trim(creation.journal.slots, creation.journal.count),
            values: _trim(creation.journal.values, creation.journal.count),
            deployments: creation.frame.seed.deployments,
            records: creation.frame.seed.records,
            recordCount: creation.frame.seed.recordCount
        });
        FrameInput memory childFrame = FrameInput({
            code: childCode,
            jumpdest: childJumpdest,
            input: _memorySlice(creation.vmMemory, creation.inputOffset, creation.inputSize),
            byteLimit: creation.frame.byteLimit,
            staticMode: false,
            context: childContext,
            entry: packageInfo.constructorEntry,
            seed: childSeed
        });
        child = _runCode(childFrame);
        bytes32[4] memory topics;
        topics[0] = INTERNAL_DEPLOYED_SELECTOR;
        (child.records, child.recordCount) = _appendRecord(
            child.records,
            child.recordCount,
            INTERNAL_KERNEL_EMITTER_ID,
            1,
            topics,
            abi.encode(contractId, creator, creation.codeHash)
        );
    }

    function _writeCodeBlob(bytes memory payload, bytes memory jumpdest, bytes32 salt)
        private
        returns (address blob, bytes32 blobCodeHash)
    {
        bytes memory runtime = bytes.concat(hex"00", payload, jumpdest);
        uint16 runtimeLength = uint16(runtime.length);
        bytes memory initCode = abi.encodePacked(
            hex"61", bytes2(runtimeLength), hex"600c5f3961", bytes2(runtimeLength), hex"5ff3", runtime
        );
        assembly ("memory-safe") {
            blob := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (blob == address(0)) revert CodeBlobDeploymentFailed(salt);
        blobCodeHash = keccak256(runtime);
        bytes32 actual = blob.codehash;
        if (actual != blobCodeHash) revert CodeBlobMismatch(blob, blobCodeHash, actual);
    }

    function _loadProgram(PackageInfo storage packageInfo)
        private
        view
        returns (bytes memory code, bytes memory jumpdest)
    {
        address blob = packageInfo.blob;
        bytes32 expected = packageInfo.blobCodeHash;
        bytes32 actual = blob.codehash;
        if (actual != expected) revert CodeBlobMismatch(blob, expected, actual);

        uint256 codeLength = packageInfo.codeLength;
        uint256 jumpdestLength = packageInfo.jumpdestLength;
        uint256 codeOffset = packageInfo.codeOffset;
        uint256 jumpdestOffset = uint256(packageInfo.packageLength) + 1;
        code = new bytes(codeLength);
        jumpdest = new bytes(jumpdestLength);
        assembly ("memory-safe") {
            extcodecopy(blob, add(code, 0x20), codeOffset, codeLength)
            extcodecopy(blob, add(jumpdest, 0x20), jumpdestOffset, jumpdestLength)
        }
    }

    function _decodePackage(bytes memory packageBytes)
        internal
        pure
        returns (uint16 constructorEntry, uint16 runtimeEntry, bytes32 abiHash, bytes memory code)
    {
        if (packageBytes.length < 44) revert InvalidPackageLength(packageBytes.length);
        bytes4 magic;
        assembly ("memory-safe") {
            magic := mload(add(packageBytes, 0x20))
        }
        if (magic != 0x53564d31) revert InvalidPackageMagic(magic);
        uint16 version = _readU16(packageBytes, 4);
        if (version != 1) revert InvalidPackageVersion(version);
        constructorEntry = _readU16(packageBytes, 6);
        runtimeEntry = _readU16(packageBytes, 8);
        uint16 codeLength = _readU16(packageBytes, 10);
        if (packageBytes.length != 44 + uint256(codeLength)) {
            revert InvalidPackageCodeLength(codeLength, packageBytes.length - 44);
        }
        assembly ("memory-safe") {
            abiHash := mload(add(packageBytes, 0x2c))
        }
        code = new bytes(codeLength);
        assembly ("memory-safe") {
            mcopy(add(code, 0x20), add(packageBytes, 0x4c), codeLength)
        }
        _validateCode(code);
        if (!_isOpcodeBoundary(code, constructorEntry)) revert InvalidPackageEntry(constructorEntry);
        if (!_isOpcodeBoundary(code, runtimeEntry)) revert InvalidPackageEntry(runtimeEntry);
    }

    function _isOpcodeBoundary(bytes memory code, uint256 target) private pure returns (bool) {
        uint256 pc;
        while (pc < code.length) {
            if (pc == target) return true;
            (, uint8 immediateBytes) = _opcodeInfo(uint8(code[pc]));
            pc += 1 + immediateBytes;
        }
        return false;
    }

    function _readU16(bytes memory data, uint256 offset) private pure returns (uint16 value) {
        value = (uint16(uint8(data[offset])) << 8) | uint16(uint8(data[offset + 1]));
    }

    function _commitWrites(bytes32 worldId, bytes32[] memory targets, bytes32[] memory slots, bytes32[] memory values)
        internal
    {
        for (uint256 i; i < slots.length; ++i) {
            _programStorage[worldId][targets[i]][slots[i]] = values[i];
        }
    }

    function _validateCode(bytes memory code) internal pure returns (bytes memory jumpdest) {
        if (code.length == 0) revert EmptyCode();
        if (code.length > MAX_CODE_BYTES) revert CodeTooLarge(code.length);
        jumpdest = new bytes(code.length);
        uint256 pc;
        while (pc < code.length) {
            uint8 opcode = uint8(code[pc]);
            (bool known, uint8 immediateBytes) = _opcodeInfo(opcode);
            if (!known) revert UnknownOpcode(opcode, pc);
            if (pc + 1 + immediateBytes > code.length) revert TruncatedImmediate(pc, immediateBytes);
            if (opcode == 0x5b) jumpdest[pc] = 0x01;
            pc += 1 + immediateBytes;
        }
    }

    function _packJumpdest(bytes memory unpacked) internal pure returns (bytes memory packed) {
        packed = new bytes((unpacked.length + 7) >> 3);
        for (uint256 i; i < unpacked.length; ++i) {
            if (unpacked[i] == 0x01) {
                uint256 index = i >> 3;
                packed[index] = bytes1(uint8(packed[index]) | uint8(1 << (i & 7)));
            }
        }
    }

    function _opcodeInfo(uint8 opcode) private pure returns (bool known, uint8 immediateBytes) {
        if (opcode >= 0x60 && opcode <= 0x7f) return (true, opcode - 0x5f);
        if (
            opcode == 0x00 || (opcode >= 0x01 && opcode <= 0x0a) || (opcode >= 0x10 && opcode <= 0x1d) || opcode == 0x20
                || opcode == 0x21 || opcode == 0x30 || opcode == 0x33 || (opcode >= 0x35 && opcode <= 0x37)
                || opcode == 0x3d || opcode == 0x3e || opcode == 0x42 || opcode == 0x43
                || (opcode >= 0x50 && opcode <= 0x59) || opcode == 0x5b || opcode == 0x5f
                || (opcode >= 0x80 && opcode <= 0x9f) || (opcode >= 0xa0 && opcode <= 0xa4)
                || (opcode >= 0xb0 && opcode <= 0xbc) || opcode == 0xf0 || opcode == 0xf1 || opcode == 0xf3
                || opcode == 0xfa || opcode == 0xfd
        ) return (true, 0);
        return (false, 0);
    }

    function _binary(uint8 opcode, uint256 a, uint256 b) private pure returns (uint256 result) {
        assembly ("memory-safe") {
            switch opcode
            case 0x01 { result := add(a, b) }
            case 0x02 { result := mul(a, b) }
            case 0x03 { result := sub(a, b) }
            case 0x04 { result := div(a, b) }
            case 0x05 { result := sdiv(a, b) }
            case 0x06 { result := mod(a, b) }
            case 0x07 { result := smod(a, b) }
            case 0x0a { result := exp(a, b) }
            case 0x10 { result := lt(a, b) }
            case 0x11 { result := gt(a, b) }
            case 0x12 { result := slt(a, b) }
            case 0x13 { result := sgt(a, b) }
            case 0x14 { result := eq(a, b) }
            case 0x16 { result := and(a, b) }
            case 0x17 { result := or(a, b) }
            case 0x18 { result := xor(a, b) }
            case 0x1a { result := byte(b, a) }
            case 0x1b { result := shl(b, a) }
            case 0x1c { result := shr(b, a) }
            case 0x1d { result := sar(b, a) }
        }
    }

    function _contextValue(uint8 opcode, VMContext memory context, uint32 used, uint32 limit)
        private
        pure
        returns (uint256 value)
    {
        if (opcode == 0xb0) return uint256(context.txActor);
        if (opcode == 0xb1) return uint256(context.worldId);
        if (opcode == 0xb2) return context.executionHeight;
        if (opcode == 0xb3) return context.ethAmountIn;
        if (opcode == 0xb4) return context.grossTokenOut;
        if (opcode == 0xb5) return uint256(int256(context.tickAfter));
        if (opcode == 0xb6) return context.liquidityAfter;
        if (opcode == 0xb7) return context.byteGasPrice;
        if (opcode == 0xb8) return used;
        if (opcode == 0xb9) return uint256(limit) - used;
        if (opcode == 0xba) return uint256(uint160(context.txRouter));
        if (opcode == 0xbb) return uint256(uint160(context.txExecutor));
        return uint256(uint160(context.txRecipient));
    }

    function _push(uint256[1024] memory stack, uint256 stackPointer, uint256 value) private pure returns (uint256) {
        if (stackPointer == MAX_STACK_WORDS) revert StackOverflow();
        stack[stackPointer] = value;
        return stackPointer + 1;
    }

    function _pop(uint256[1024] memory stack, uint256 stackPointer)
        private
        pure
        returns (uint256 value, uint256 nextPointer)
    {
        if (stackPointer == 0) revert StackUnderflow();
        nextPointer = stackPointer - 1;
        value = stack[nextPointer];
    }

    function _memoryEnd(uint256 offset, uint256 size, uint32 ancestorMemory) private pure returns (uint256 end) {
        if (offset > MAX_MEMORY_BYTES || size > MAX_MEMORY_BYTES - offset) revert MemoryOutOfBounds(offset, size);
        end = offset + size;
        uint256 total = uint256(ancestorMemory) + end;
        if (total > 262_144) revert TotalMemoryOutOfBounds(total);
    }

    function _memoryWord(bytes memory vmMemory, uint256 offset) private pure returns (bytes32 value) {
        assembly ("memory-safe") {
            value := mload(add(add(vmMemory, 0x20), offset))
        }
    }

    function _storeWord(bytes memory vmMemory, uint256 offset, bytes32 value) private pure {
        assembly ("memory-safe") {
            mstore(add(add(vmMemory, 0x20), offset), value)
        }
    }

    function _calldataWord(bytes memory input, uint256 offset) private pure returns (uint256 value) {
        if (offset >= input.length) return 0;
        uint256 available = input.length - offset;
        uint256 count = available > 32 ? 32 : available;
        assembly ("memory-safe") {
            let shift := shl(3, sub(32, count))
            value := shl(shift, shr(shift, mload(add(add(input, 0x20), offset))))
        }
    }

    function _copyPadded(
        bytes memory source,
        uint256 sourceOffset,
        bytes memory target,
        uint256 targetOffset,
        uint256 size
    ) private pure {
        if (sourceOffset >= source.length || size == 0) return;
        uint256 available = source.length - sourceOffset;
        uint256 copySize = size < available ? size : available;
        assembly ("memory-safe") {
            mcopy(add(add(target, 0x20), targetOffset), add(add(source, 0x20), sourceOffset), copySize)
        }
    }

    function _memorySlice(bytes memory vmMemory, uint256 offset, uint256 size)
        private
        pure
        returns (bytes memory output)
    {
        output = new bytes(size);
        assembly ("memory-safe") {
            mcopy(add(output, 0x20), add(add(vmMemory, 0x20), offset), size)
        }
    }

    function _journalLoad(
        bytes32 worldId,
        bytes32 target,
        bytes32 slot,
        bytes32[] memory targets,
        bytes32[] memory slots,
        bytes32[] memory values,
        uint256 writeCount
    ) private view returns (bytes32) {
        for (uint256 i = writeCount; i > 0; --i) {
            if (targets[i - 1] == target && slots[i - 1] == slot) return values[i - 1];
        }
        return _programStorage[worldId][target][slot];
    }

    function _growJournal(
        bytes32[] memory oldTargets,
        bytes32[] memory oldSlots,
        bytes32[] memory oldValues,
        uint256 capacity
    ) private pure returns (bytes32[] memory targets, bytes32[] memory slots, bytes32[] memory values) {
        targets = new bytes32[](capacity);
        slots = new bytes32[](capacity);
        values = new bytes32[](capacity);
        uint256 copySize = oldSlots.length * 32;
        assembly ("memory-safe") {
            mcopy(add(targets, 0x20), add(oldTargets, 0x20), copySize)
            mcopy(add(slots, 0x20), add(oldSlots, 0x20), copySize)
            mcopy(add(values, 0x20), add(oldValues, 0x20), copySize)
        }
    }

    function _finish(
        bytes memory output,
        uint32 used,
        bytes32[] memory targets,
        bytes32[] memory slots,
        bytes32[] memory values,
        uint256 writeCount,
        Deployment[] memory deployments,
        bytes memory records,
        uint16 recordCount
    ) private pure returns (RunResult memory result) {
        bytes32[] memory finalTargets = new bytes32[](writeCount);
        bytes32[] memory finalSlots = new bytes32[](writeCount);
        bytes32[] memory finalValues = new bytes32[](writeCount);
        uint256 copySize = writeCount * 32;
        assembly ("memory-safe") {
            mcopy(add(finalTargets, 0x20), add(targets, 0x20), copySize)
            mcopy(add(finalSlots, 0x20), add(slots, 0x20), copySize)
            mcopy(add(finalValues, 0x20), add(values, 0x20), copySize)
        }
        result = RunResult({
            output: output,
            executedBytes: used,
            targets: finalTargets,
            slots: finalSlots,
            values: finalValues,
            deployments: deployments,
            records: records,
            recordCount: recordCount
        });
    }

    function _trim(bytes32[] memory values, uint256 length) private pure returns (bytes32[] memory result) {
        result = new bytes32[](length);
        assembly ("memory-safe") {
            mcopy(add(result, 0x20), add(values, 0x20), mul(length, 0x20))
        }
    }

    function _appendDeployment(Deployment[] memory existing, Deployment memory addition)
        private
        pure
        returns (Deployment[] memory result)
    {
        result = new Deployment[](existing.length + 1);
        // Memory arrays of structs store one pointer per element; the structs themselves remain
        // valid at their existing memory locations for the duration of this execution.
        uint256 copySize = existing.length * 32;
        assembly ("memory-safe") {
            mcopy(add(result, 0x20), add(existing, 0x20), copySize)
        }
        result[existing.length] = addition;
    }

    function _appendRecord(
        bytes memory existing,
        uint16 existingCount,
        bytes32 emitter,
        uint8 topicCount,
        bytes32[4] memory topics,
        bytes memory data
    ) private pure returns (bytes memory records, uint16 recordCount) {
        if (data.length > MAX_RECORD_DATA_BYTES) revert RecordDataTooLarge(data.length);
        if (existingCount == MAX_RECEIPT_RECORDS) revert TooManyVMRecords(uint256(existingCount) + 1);
        uint256 recordLength = 32 + 1 + (32 * uint256(topicCount)) + 4 + data.length;
        uint256 existingLength = existing.length;
        records = new bytes(existingLength + 4 + recordLength);
        uint256 topicsLength = uint256(topicCount) * 32;
        uint256 dataLength = data.length;
        assembly ("memory-safe") {
            let output := add(records, 0x20)
            mcopy(output, add(existing, 0x20), existingLength)
            let record := add(output, existingLength)
            mstore(record, shl(224, recordLength))
            mstore(add(record, 4), emitter)
            mstore8(add(record, 36), topicCount)
            mcopy(add(record, 37), topics, topicsLength)
            let dataLengthPointer := add(add(record, 37), topicsLength)
            mstore(dataLengthPointer, shl(224, dataLength))
            mcopy(add(dataLengthPointer, 4), add(data, 0x20), dataLength)
        }
        uint256 payloadLength = 4 + records.length;
        if (payloadLength > MAX_RECEIPT_PAYLOAD_BYTES) revert ReceiptPayloadTooLarge(payloadLength);
        recordCount = existingCount + 1;
    }

    function _copyContext(VMContext memory source, bytes32 addressId, bytes32 caller)
        private
        pure
        returns (VMContext memory)
    {
        return VMContext({
            worldId: source.worldId,
            addressId: addressId,
            caller: caller,
            txActor: source.txActor,
            txRouter: source.txRouter,
            txExecutor: source.txExecutor,
            txRecipient: source.txRecipient,
            executionHeight: source.executionHeight,
            ethAmountIn: source.ethAmountIn,
            grossTokenOut: source.grossTokenOut,
            tickAfter: source.tickAfter,
            liquidityAfter: source.liquidityAfter,
            byteGasPrice: source.byteGasPrice,
            chainBlockNumber: source.chainBlockNumber,
            chainTimestamp: source.chainTimestamp
        });
    }

    function _pendingCodeHash(Deployment[] memory deployments, bytes32 contractId) private pure returns (bytes32) {
        for (uint256 i = deployments.length; i > 0; --i) {
            if (deployments[i - 1].contractId == contractId) return deployments[i - 1].codeHash;
        }
        return bytes32(0);
    }

    function _nextCreatorNonce(bytes32 worldId, bytes32 creator, Deployment[] memory deployments)
        private
        view
        returns (uint64 nonce)
    {
        nonce = creatorNonce[worldId][creator];
        for (uint256 i; i < deployments.length; ++i) {
            if (deployments[i].creator == creator && deployments[i].nonceAfter > nonce) {
                nonce = deployments[i].nonceAfter;
            }
        }
    }

    function _deriveContractId(bytes32 worldId, bytes32 creator, uint64 creationNonce, bytes32 codeHash)
        internal
        pure
        returns (bytes32)
    {
        bytes32 hash = keccak256(abi.encodePacked("SwapVM.CREATE.v1", worldId, creator, creationNonce, codeHash));
        return bytes32((uint256(1) << 248) | (uint256(hash) >> 8));
    }

    function _commitDeployments(bytes32 worldId, Deployment[] memory deployments) internal {
        for (uint256 i; i < deployments.length; ++i) {
            Deployment memory item = deployments[i];
            _instantiatePackage(worldId, item.contractId, item.codeHash);
            creatorNonce[worldId][item.creator] = item.nonceAfter;
        }
    }

    function _requireJumpdest(bytes memory jumpdest, uint256 codeLength, uint256 destination) private pure {
        if (destination >= codeLength || (uint8(jumpdest[destination >> 3]) & uint8(1 << (destination & 7))) == 0) {
            revert InvalidJumpDestination(destination);
        }
    }

    function _requireContractAccount(bytes32 target) private pure {
        if (uint8(target[0]) != 0x01) revert InvalidContractAccount(target);
    }
}
