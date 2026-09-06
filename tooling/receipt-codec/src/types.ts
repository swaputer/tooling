import type { Bytes32, Hex, ReceiptInput } from "./hex.js";

export type { Bytes32, Hex, ReceiptInput };

export interface WorldExecutionData {
  readonly actor: Bytes32;
  readonly rootTarget: Bytes32;
  readonly executedBytes: number;
  readonly tokenBurned: bigint;
  readonly grossTokenOut: bigint;
  readonly netTokenOut: bigint;
}

export interface MiniContractDeployedData {
  readonly contractId: Bytes32;
  readonly creator: Bytes32;
  readonly codeHash: Bytes32;
}

interface VMRecordBase {
  readonly recordLength: number;
  readonly emitter: Bytes32;
  readonly topicCount: number;
  readonly topics: readonly Bytes32[];
  readonly dataLength: number;
  readonly data: Hex;
}

export interface ApplicationRecord extends VMRecordBase {
  readonly kind: "application";
}

export interface WorldExecutionRecord extends VMRecordBase {
  readonly kind: "worldExecution";
  readonly decoded: Readonly<WorldExecutionData>;
}

export interface MiniContractDeployedRecord extends VMRecordBase {
  readonly kind: "miniContractDeployed";
  readonly decoded: Readonly<MiniContractDeployedData>;
}

export type VMRecord = ApplicationRecord | WorldExecutionRecord | MiniContractDeployedRecord;

export interface VMReceiptV1 {
  readonly version: 1;
  readonly flags: 0;
  readonly recordCount: number;
  readonly records: readonly VMRecord[];
  readonly worldExecution: Readonly<WorldExecutionData>;
}

export interface VMRecordInput {
  readonly emitter: Bytes32;
  readonly topics: readonly Bytes32[];
  readonly data: ReceiptInput;
}

export interface VMReceiptV1Input {
  readonly version?: 1;
  readonly flags?: 0;
  readonly records: readonly VMRecordInput[];
}
