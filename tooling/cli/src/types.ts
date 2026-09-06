import type { VMReceiptV1 } from "@swaputer-labs/receipt-codec";

export type Hex = `0x${string}`;

export interface SwaputerDeployment {
  readonly schemaVersion: "swaputer-cli-deployment/1";
  readonly id: string;
  readonly releaseName: string;
  readonly protocolVersion: string;
  readonly chainId: bigint;
  readonly networkName: string;
  readonly kernel: Hex;
  readonly kernelRuntimeCodeHash: Hex;
  readonly worldId: Hex;
  readonly sourceManifest: string;
  readonly sourceManifestHash: Hex;
}

export interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly logIndex: string;
  readonly transactionIndex: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
}

export interface RpcReceipt {
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly transactionIndex: string;
  readonly status: string;
  readonly logs: readonly RpcLog[];
}

export interface SwaputerExecution {
  readonly worldId: Hex;
  readonly executionHeight: bigint;
  readonly payload: Hex;
  readonly logIndex: bigint;
  readonly receipt: VMReceiptV1;
}

export interface InspectionResult {
  readonly kind: "verified";
  readonly deployment: SwaputerDeployment;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionIndex: bigint;
  readonly executions: readonly SwaputerExecution[];
  readonly rpcEnvironment: string;
}
