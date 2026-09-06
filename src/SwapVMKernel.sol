// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SwapVMMiniVM} from "./SwapVMMiniVM.sol";

/// @notice Stage 1 NOP plus Stage 2/3 metered SwapVM Kernel with packages, deployment and nested execution.
contract SwapVMKernel is SwapVMMiniVM {
    uint16 public constant VM_VERSION = 2;
    uint8 public constant RECEIPT_VERSION = 1;
    bytes32 public constant ISA_HASH = 0x5958f1a3baf744e5ed92f096a964ee14779db2e32e70a2982c53080eb3cd92c2;
    uint32 public constant MAX_BYTE_GAS_LIMIT_V1 = 1_000_000;
    uint32 public constant STOP_EXECUTED_BYTES = 1;
    bytes32 public constant KERNEL_EMITTER_ID = 0xff00000000000000000000000000000000000000000000000000000000000001;
    bytes32 public constant WORLD_EXECUTION_SELECTOR =
        keccak256("WorldExecution(bytes32,bytes32,uint32,uint256,uint256,uint256)");
    bytes32 public constant MINI_CONTRACT_DEPLOYED_SELECTOR =
        keccak256("MiniContractDeployed(bytes32,bytes32,bytes32)");
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)");
    bytes32 public constant VM_ACTION_TYPEHASH = keccak256(
        "VMAction(uint8 op,bytes32 worldId,address actor,bytes32 targetOrCodeHash,bytes32 payloadHash,uint32 byteGasLimit,uint128 minNetTokenOut,uint128 exactEthAmountIn,uint160 sqrtPriceLimitX96,address recipient,address router,address authorizedExecutor,uint64 nonce,uint64 deadline)"
    );
    bytes32 private constant NAME_HASH = keccak256("Swaputer");
    bytes32 private constant VERSION_HASH = keccak256("1.2");
    uint256 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable hook;
    uint128 public immutable byteGasPrice;

    mapping(bytes32 worldId => uint64 height) public executionHeight;
    mapping(bytes32 worldId => uint32 count) public executedBytes;
    mapping(bytes32 worldId => mapping(bytes32 actor => uint64 nextNonce)) public nonces;

    enum RootOp {
        NOP,
        DEPLOY,
        CALL
    }

    struct VMEnvelope {
        RootOp op;
        bytes32 worldId;
        address actor;
        bytes32 targetOrCodeHash;
        bytes payload;
        uint32 byteGasLimit;
        uint128 minNetTokenOut;
        uint64 nonce;
        uint64 deadline;
        address recipient;
        address authorizedExecutor;
        bytes signature;
    }

    struct ActionBinding {
        uint160 sqrtPriceLimitX96;
        address router;
    }

    struct ActionRun {
        bytes32 rootTarget;
        bytes32 deployedCodeHash;
        RunResult run;
    }

    struct BuyReceipt {
        bytes32 worldId;
        uint64 executionHeight;
        bytes32 actor;
        uint128 ethAmountIn;
        uint128 grossTokenOut;
        uint128 tokenGasBurned;
        int24 tickAfter;
        uint128 liquidityAfter;
        uint64 chainBlockNumber;
        uint64 chainTimestamp;
    }

    event Events(bytes32 indexed worldId, uint64 indexed executionHeight, bytes payload);

    error OnlyBoundHook(address caller);
    error InvalidExecutionHeight(uint64 expected, uint64 supplied);
    error InvalidNOPActor();
    error InvalidNOPBurn();
    error HeightOverflow();
    error InvalidHookBinding();
    error InvalidByteGasPrice(uint128 price);
    error Stage2RootOpUnsupported(RootOp op);
    error EnvelopeWorldMismatch(bytes32 expected, bytes32 supplied);
    error ActionExpired(uint64 deadline);
    error InvalidSignatureLength(uint256 length);
    error InvalidSignature();
    error InvalidActor();
    error ActorSignatureMismatch(address expected, address recovered);
    error InvalidSignatureS();
    error InvalidSignatureV(uint8 v);
    error InvalidNonce(uint64 expected, uint64 supplied);
    error NonceOverflow();
    error BurnOutOfRange(uint256 amount);
    error NetOutputBelowMinimum(uint256 netOutput, uint128 minimum);
    error InvalidDeployPayload(uint256 length);
    error OnlySelf();
    error TooManyReceiptRecords(uint256 count);

    constructor(address boundHook, uint128 price) {
        if (boundHook == address(0)) revert InvalidHookBinding();
        if (price == 0 || uint256(price) * MAX_BYTE_GAS_LIMIT_V1 > uint256(uint128(type(int128).max))) {
            revert InvalidByteGasPrice(price);
        }
        hook = boundHook;
        byteGasPrice = price;
    }

    /// @notice Executes the canonical unsigned STOP and emits its sole aggregate receipt.
    function executeNOP(BuyReceipt calldata receipt) external returns (uint32 bytesUsed) {
        if (msg.sender != hook) revert OnlyBoundHook(msg.sender);
        if (receipt.actor != bytes32(0)) revert InvalidNOPActor();
        if (receipt.tokenGasBurned != byteGasPrice || receipt.grossTokenOut <= receipt.tokenGasBurned) {
            revert InvalidNOPBurn();
        }

        uint64 oldHeight = executionHeight[receipt.worldId];
        if (oldHeight == type(uint64).max) revert HeightOverflow();
        uint64 nextHeight = oldHeight + 1;
        if (receipt.executionHeight != nextHeight) {
            revert InvalidExecutionHeight(nextHeight, receipt.executionHeight);
        }

        bytesUsed = STOP_EXECUTED_BYTES;
        executedBytes[receipt.worldId] = bytesUsed;
        executionHeight[receipt.worldId] = nextHeight;

        bytes memory payload = _encodeReceipt(
            receipt.actor,
            bytes32(0),
            bytesUsed,
            receipt.tokenGasBurned,
            receipt.grossTokenOut,
            receipt.grossTokenOut - receipt.tokenGasBurned
        );
        emit Events(receipt.worldId, nextHeight, payload);
    }

    /// @notice Executes one authenticated Stage 2/3 root CALL or DEPLOY.
    function executeCall(BuyReceipt calldata receipt, VMEnvelope calldata action, ActionBinding calldata binding)
        external
        returns (uint32 bytesUsed, uint128 tokenBurned, bytes memory output, bytes32 actor)
    {
        if (msg.sender != hook) revert OnlyBoundHook(msg.sender);
        if (action.op != RootOp.CALL && action.op != RootOp.DEPLOY) revert Stage2RootOpUnsupported(action.op);
        if (action.worldId != receipt.worldId) revert EnvelopeWorldMismatch(receipt.worldId, action.worldId);
        if (block.timestamp > action.deadline) revert ActionExpired(action.deadline);

        uint64 oldHeight = executionHeight[receipt.worldId];
        if (oldHeight == type(uint64).max) revert HeightOverflow();
        uint64 nextHeight = oldHeight + 1;
        if (receipt.executionHeight != nextHeight) {
            revert InvalidExecutionHeight(nextHeight, receipt.executionHeight);
        }

        address signer = _recoverActor(receipt, action, binding);
        actor = eoaAccountId(signer);
        uint64 expectedNonce = nonces[receipt.worldId][actor];
        if (action.nonce != expectedNonce) revert InvalidNonce(expectedNonce, action.nonce);
        if (expectedNonce == type(uint64).max) revert NonceOverflow();

        ActionRun memory actionRun = _executeAction(receipt, action, binding.router, actor, nextHeight);
        bytesUsed = actionRun.run.executedBytes;

        uint256 burn256 = uint256(bytesUsed) * byteGasPrice;
        if (burn256 > uint256(uint128(type(int128).max)) || burn256 > type(uint128).max) {
            revert BurnOutOfRange(burn256);
        }
        tokenBurned = uint128(burn256);
        uint256 gross = receipt.grossTokenOut;
        if (burn256 > gross) revert NetOutputBelowMinimum(0, action.minNetTokenOut);
        uint256 net = gross - burn256;
        if (net < action.minNetTokenOut) revert NetOutputBelowMinimum(net, action.minNetTokenOut);

        _commitWrites(receipt.worldId, actionRun.run.targets, actionRun.run.slots, actionRun.run.values);
        this.commitInternalDeployments(receipt.worldId, actionRun.run.deployments);
        nonces[receipt.worldId][actor] = expectedNonce + 1;
        executedBytes[receipt.worldId] = bytesUsed;
        executionHeight[receipt.worldId] = nextHeight;
        output = actionRun.run.output;

        bytes memory payload = _encodeActionReceipt(
            action.op,
            actionRun.rootTarget,
            actor,
            actionRun.deployedCodeHash,
            actionRun.run.records,
            actionRun.run.recordCount,
            bytesUsed,
            burn256,
            gross,
            net
        );
        emit Events(receipt.worldId, nextHeight, payload);
    }

    function _executeAction(
        BuyReceipt calldata receipt,
        VMEnvelope calldata action,
        address router,
        bytes32 actor,
        uint64 nextHeight
    ) private returns (ActionRun memory result) {
        result.rootTarget = action.targetOrCodeHash;
        bytes memory callInput = action.payload;
        bool constructorMode;
        if (action.op == RootOp.DEPLOY) {
            (bytes memory packageBytes, bytes memory constructorInput) = _splitDeployPayload(action.payload);
            result.deployedCodeHash = keccak256(packageBytes);
            if (result.deployedCodeHash != action.targetOrCodeHash) {
                revert PackageHashMismatch(action.targetOrCodeHash, result.deployedCodeHash);
            }
            bytes32 registeredHash = _registerPackage(receipt.worldId, packageBytes);
            if (registeredHash != result.deployedCodeHash) {
                revert PackageHashMismatch(result.deployedCodeHash, registeredHash);
            }
            uint64 creationNonce = creatorNonce[receipt.worldId][actor];
            if (creationNonce == type(uint64).max) revert CreatorNonceOverflow();
            result.rootTarget = contractAccountId(receipt.worldId, actor, creationNonce, result.deployedCodeHash);
            _instantiatePackage(receipt.worldId, result.rootTarget, result.deployedCodeHash);
            creatorNonce[receipt.worldId][actor] = creationNonce + 1;
            callInput = constructorInput;
            constructorMode = true;
        }
        VMContext memory context = VMContext({
            worldId: receipt.worldId,
            addressId: result.rootTarget,
            caller: actor,
            txActor: actor,
            txRouter: router,
            txExecutor: action.authorizedExecutor,
            txRecipient: action.recipient,
            executionHeight: nextHeight,
            ethAmountIn: receipt.ethAmountIn,
            grossTokenOut: receipt.grossTokenOut,
            tickAfter: receipt.tickAfter,
            liquidityAfter: receipt.liquidityAfter,
            byteGasPrice: byteGasPrice,
            chainBlockNumber: receipt.chainBlockNumber,
            chainTimestamp: receipt.chainTimestamp
        });
        result.run = _runProgram(
            receipt.worldId, result.rootTarget, callInput, action.byteGasLimit, false, context, constructorMode
        );
    }

    /// @notice Executes deployed code read-only without consuming nonce, height, TOKEN, or events.
    function staticCall(bytes32 worldId, bytes32 target, bytes calldata input, uint32 byteLimit)
        external
        view
        returns (bytes memory output, uint32 bytesUsed)
    {
        if (block.number > type(uint64).max || block.timestamp > type(uint64).max) {
            revert BurnOutOfRange(block.number > block.timestamp ? block.number : block.timestamp);
        }
        bytes32 actor = eoaAccountId(msg.sender);
        VMContext memory context = VMContext({
            worldId: worldId,
            addressId: target,
            caller: actor,
            txActor: actor,
            txRouter: address(0),
            txExecutor: msg.sender,
            txRecipient: address(0),
            executionHeight: executionHeight[worldId],
            ethAmountIn: 0,
            grossTokenOut: 0,
            tickAfter: 0,
            liquidityAfter: 0,
            byteGasPrice: byteGasPrice,
            chainBlockNumber: uint64(block.number),
            chainTimestamp: uint64(block.timestamp)
        });
        RunResult memory run = _runProgram(worldId, target, input, byteLimit, true, context, false);
        return (run.output, run.executedBytes);
    }

    function validateProgram(bytes calldata code) external pure returns (bool) {
        _validateCode(code);
        return true;
    }

    function programCodeHash(bytes32 worldId, bytes32 target) external view returns (bytes32) {
        return _contractCodeHash[worldId][target];
    }

    function programEntries(bytes32 worldId, bytes32 target)
        external
        view
        returns (uint16 constructorEntry, uint16 runtimeEntry)
    {
        PackageInfo storage packageInfo = _programPackages[worldId][_contractCodeHash[worldId][target]];
        return (packageInfo.constructorEntry, packageInfo.runtimeEntry);
    }

    function packageRegistered(bytes32 worldId, bytes32 codeHash) external view returns (bool) {
        return _programPackages[worldId][codeHash].blob != address(0);
    }

    function commitInternalDeployments(bytes32 worldId, Deployment[] calldata deployments) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _commitDeployments(worldId, deployments);
    }

    function programCodeLength(bytes32 worldId, bytes32 target) external view returns (uint256) {
        return _programPackages[worldId][_contractCodeHash[worldId][target]].codeLength;
    }

    function packageBlob(bytes32 worldId, bytes32 codeHash)
        external
        view
        returns (address blob, uint16 packageLength, uint16 codeLength, bytes32 blobCodeHash)
    {
        PackageInfo storage packageInfo = _programPackages[worldId][codeHash];
        return (packageInfo.blob, packageInfo.packageLength, packageInfo.codeLength, packageInfo.blobCodeHash);
    }

    function programStorageAt(bytes32 worldId, bytes32 target, bytes32 slot) external view returns (bytes32) {
        return _programStorage[worldId][target][slot];
    }

    function domainSeparator(bytes32 worldId) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this), worldId)
            );
    }

    function eoaAccountId(address account) public pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    function contractAccountId(bytes32 worldId, bytes32 creator, uint64 creationNonce, bytes32 codeHash)
        public
        pure
        returns (bytes32)
    {
        return _deriveContractId(worldId, creator, creationNonce, codeHash);
    }

    function _recoverActor(BuyReceipt calldata receipt, VMEnvelope calldata action, ActionBinding calldata binding)
        private
        view
        returns (address signer)
    {
        if (action.actor == address(0)) revert InvalidActor();
        bytes32 structHash = keccak256(
            abi.encode(
                VM_ACTION_TYPEHASH,
                uint8(action.op),
                action.worldId,
                action.actor,
                action.targetOrCodeHash,
                keccak256(action.payload),
                action.byteGasLimit,
                action.minNetTokenOut,
                receipt.ethAmountIn,
                binding.sqrtPriceLimitX96,
                action.recipient,
                binding.router,
                action.authorizedExecutor,
                action.nonce,
                action.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainSeparator(action.worldId), structHash));
        signer = _recover(digest, action.signature);
        if (signer != action.actor) revert ActorSignatureMismatch(action.actor, signer);
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignatureLength(signature.length);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (uint256(s) > SECP256K1N_HALF) revert InvalidSignatureS();
        if (v != 27 && v != 28) revert InvalidSignatureV(v);
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _splitDeployPayload(bytes calldata payload)
        private
        pure
        returns (bytes memory packageBytes, bytes memory constructorInput)
    {
        if (payload.length < 4) revert InvalidDeployPayload(payload.length);
        uint256 packageLength = (uint256(uint8(payload[0])) << 24) | (uint256(uint8(payload[1])) << 16)
            | (uint256(uint8(payload[2])) << 8) | uint256(uint8(payload[3]));
        if (packageLength == 0 || packageLength > payload.length - 4) revert InvalidDeployPayload(payload.length);
        packageBytes = new bytes(packageLength);
        uint256 inputLength = payload.length - 4 - packageLength;
        constructorInput = new bytes(inputLength);
        assembly ("memory-safe") {
            calldatacopy(add(packageBytes, 0x20), add(payload.offset, 4), packageLength)
            calldatacopy(add(constructorInput, 0x20), add(add(payload.offset, 4), packageLength), inputLength)
        }
    }

    function _encodeReceipt(
        bytes32 actor,
        bytes32 rootTarget,
        uint32 bytesUsed,
        uint256 tokenBurned,
        uint256 grossTokenOut,
        uint256 netTokenOut
    ) private pure returns (bytes memory) {
        bytes memory summaryData = abi.encode(actor, rootTarget, bytesUsed, tokenBurned, grossTokenOut, netTokenOut);
        return abi.encodePacked(
            bytes1(RECEIPT_VERSION), bytes1(0), bytes2(uint16(1)), _kernelRecord(WORLD_EXECUTION_SELECTOR, summaryData)
        );
    }

    function _encodeActionReceipt(
        RootOp op,
        bytes32 rootTarget,
        bytes32 actor,
        bytes32 rootCodeHash,
        bytes memory vmRecords,
        uint16 vmRecordCount,
        uint32 bytesUsed,
        uint256 tokenBurned,
        uint256 grossTokenOut,
        uint256 netTokenOut
    ) private pure returns (bytes memory) {
        uint256 recordCount = uint256(vmRecordCount) + (op == RootOp.DEPLOY ? 1 : 0) + 1;
        if (recordCount > 64) revert TooManyReceiptRecords(recordCount);
        bytes memory records = vmRecords;
        if (op == RootOp.DEPLOY) {
            records = bytes.concat(records, _deploymentRecord(rootTarget, actor, rootCodeHash));
        }
        bytes memory summaryData = abi.encode(actor, rootTarget, bytesUsed, tokenBurned, grossTokenOut, netTokenOut);
        records = bytes.concat(records, _kernelRecord(WORLD_EXECUTION_SELECTOR, summaryData));
        bytes memory payload =
            abi.encodePacked(bytes1(RECEIPT_VERSION), bytes1(0), bytes2(uint16(recordCount)), records);
        if (payload.length > MAX_RECEIPT_PAYLOAD_BYTES) revert ReceiptPayloadTooLarge(payload.length);
        return payload;
    }

    function _deploymentRecord(bytes32 contractId, bytes32 creator, bytes32 codeHash)
        private
        pure
        returns (bytes memory)
    {
        return _kernelRecord(MINI_CONTRACT_DEPLOYED_SELECTOR, abi.encode(contractId, creator, codeHash));
    }

    function _kernelRecord(bytes32 selector, bytes memory data) private pure returns (bytes memory) {
        uint32 recordLength = 32 + 1 + 32 + 4 + uint32(data.length);
        return abi.encodePacked(
            bytes4(recordLength), KERNEL_EMITTER_ID, bytes1(uint8(1)), selector, bytes4(uint32(data.length)), data
        );
    }
}
