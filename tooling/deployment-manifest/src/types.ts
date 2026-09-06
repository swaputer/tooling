export type Address = `0x${string}`;
export type Bytes32 = `0x${string}`;
export type Hex = `0x${string}`;

export interface CodeIdentity {
  readonly address: Address;
  readonly extcodehash: Bytes32;
  readonly runtimeCodeHash: Bytes32;
}

export interface PoolKeyManifest {
  readonly currency0: "ETH";
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

export interface DeploymentSignature {
  readonly signer: Address;
  readonly algorithm: "EIP-191";
  readonly message: Bytes32;
  readonly signature: Hex;
}

export interface DeploymentReleaseStatus {
  readonly environment: "local" | "testnet";
  readonly auditStatus: "unaudited";
  readonly auditCandidateTag: "swaputer-v1.1-stage7c-rc2";
  readonly auditCandidateCommit: "afa54c2e02e7e91430b14b6884faff5e3f5867d9";
  readonly economicValue: "none";
  readonly publicMainnetDeploymentAllowed: false;
  readonly auditedReleaseArtifact: null;
}

export interface DeploymentManifest {
  readonly schemaVersion: "1";
  readonly protocolVersion: "1.1" | "1.2";
  readonly release: DeploymentReleaseStatus;
  readonly chainId: number;
  readonly worldConfigHash: Bytes32;
  readonly poolManager: CodeIdentity;
  readonly factory: CodeIdentity;
  readonly referenceRegistry: CodeIdentity;
  readonly worldDeployer: CodeIdentity;
  readonly artifactStores: Readonly<{
    kernelCreationCode: CodeIdentity & Readonly<{ payloadHash: Bytes32 }>;
    hookCreationCode: CodeIdentity & Readonly<{ payloadHash: Bytes32 }>;
  }>;
  readonly world: Readonly<{
    poolKey: PoolKeyManifest;
    worldId: Bytes32;
    byteGasPrice: string;
    maxByteGasLimit: number;
    initialSqrtPriceX96: string;
    sealed: true;
    sealedAtBlock: number;
  }>;
  readonly gasToken: CodeIdentity & Readonly<{
    decimals: 18;
    initialSupply: string;
    initialHolder: Address;
    distributionCommitment: Bytes32;
  }>;
  readonly kernel: CodeIdentity;
  readonly hook: CodeIdentity;
  readonly router: CodeIdentity & Readonly<{
    supportsCanonicalVMInput: true;
    supportsSignedVm: true;
  }>;
  readonly limits: Readonly<{
    vmVersion: 1 | 2;
    receiptVersion: 1;
    isaHash: Bytes32;
    maxCodeBytes: number;
    maxStackWords: number;
    maxMemoryBytes: number;
    maxCallDepth: number;
    maxReceiptPayloadBytes: number;
  }>;
  readonly referencePrograms: Readonly<{
    src20: Bytes32;
    src721: Bytes32;
    src1155: Bytes32;
    cpamm: Bytes32;
  }>;
  readonly compiler: Readonly<{ name: string; version: string; hash: Bytes32 }>;
  readonly deployment: Readonly<{
    blockHash: Bytes32;
    blockNumber: number;
    txHash: Bytes32;
    factoryAddress: Address;
    routerAddress: Address;
    factoryEventTxIndex: number;
  }>;
  readonly integrity: Readonly<{
    sourceControlCommit: string;
    treeCommitment: Bytes32;
    artifactCommitment: Bytes32;
    specKeccak256: Bytes32;
    isaKeccak256: Bytes32;
    manifestHash: Bytes32;
    signature: DeploymentSignature | null;
  }>;
}

export interface DeploymentObservation {
  readonly chainId: number;
  readonly worldId: Bytes32;
  readonly worldConfigHash: Bytes32;
  readonly blockHash: Bytes32;
  readonly blockNumber: number;
  readonly txHash: Bytes32;
  readonly sealed: boolean;
  readonly treeCommitment: Bytes32;
  readonly artifactCommitment: Bytes32;
  readonly compilerHash: Bytes32;
  readonly referencePrograms: DeploymentManifest["referencePrograms"];
  readonly artifactPayloads: Readonly<{ kernelCreationCode: Bytes32; hookCreationCode: Bytes32 }>;
  readonly code: Readonly<Record<string, Readonly<{ address: Address; extcodehash: Bytes32 }>>>;
}
