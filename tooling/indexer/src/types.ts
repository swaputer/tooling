import type { Bytes32, Hex, VMReceiptV1 } from "@swaputer/receipt-codec";

export type { Bytes32, Hex, VMReceiptV1 };
export type Address = `0x${string}`;

export interface RpcTransport {
  request<T>(method: string, params: readonly unknown[]): Promise<T>;
}

export interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: string;
  readonly logIndex: string;
  readonly removed?: boolean;
}

export interface RpcBlock {
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: string;
}

export interface BlockHeader {
  readonly number: bigint;
  readonly hash: Bytes32;
  readonly parentHash: Bytes32;
  readonly timestamp: bigint;
}

export interface ParsedEvents {
  readonly kernelAddress: Address;
  readonly worldId: Bytes32;
  readonly executionHeight: bigint;
  readonly payload: Hex;
  readonly receipt: VMReceiptV1;
}

export interface IndexerConfig {
  readonly chainId: bigint;
  readonly kernelAddress: Address;
  readonly startBlock: bigint;
  readonly confirmations: bigint;
  readonly chunkSize: bigint;
  readonly maxReorgDepth: bigint;
  readonly targetBlock?: bigint;
  readonly worldId?: Bytes32;
  readonly maxRpcRetries?: number;
  readonly retryBaseDelayMs?: number;
}

export interface SyncResult {
  readonly chainId: bigint;
  readonly kernelAddress: Address;
  readonly fromBlock: bigint;
  readonly nextBlock: bigint;
  readonly latestBlock: bigint;
  readonly targetBlock: bigint | null;
  readonly finalizedBlock: bigint | null;
  readonly blocksCommitted: bigint;
  readonly executionsCommitted: bigint;
  readonly quarantinedEvents: bigint;
  readonly reorgsApplied: bigint;
}

export interface IndexerStatus {
  readonly chainId: bigint;
  readonly kernelAddress: Address;
  readonly canonicalTip: bigint | null;
  readonly canonicalTipHash: Bytes32 | null;
  readonly finalizedTip: bigint | null;
  readonly nextBlock: bigint;
  readonly executions: bigint;
  readonly records: bigint;
  readonly deployments: bigint;
  readonly quarantineErrors: bigint;
  readonly lastSyncAt: string;
}

export interface IndexerHooks {
  readonly beforeBlockCommit?: (block: BlockHeader) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => string;
}
