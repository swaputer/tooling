import { decodeVMReceipt, isVMReceiptError, type Hex as ReceiptHex } from "@swaputer-labs/receipt-codec";
import { keccak_256 } from "@noble/hashes/sha3";
import { DEPLOYMENTS, type SwaputerDeployment } from "./deployments";
import { HttpRpcTransport, assertTransactionHash, type RpcTransport } from "./rpc";
import {
  InspectionError,
  InspectionErrorCode,
  type Hex,
  type InspectionResult,
  type RpcBlock,
  type RpcLog,
  type RpcReceipt,
  type RpcTransaction,
  type SwaputerExecution
} from "./types";

export const EVENTS_TOPIC = "0x602812b230e5dc416bb4163643fb95093808246664e5b824bf2849ffb8c33d04";
export const MINIMUM_INSPECTION_CONFIRMATIONS = 12n;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function normalizeHex(value: string): Hex {
  return value.toLowerCase() as Hex;
}

function hexToBytes(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "data" });
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let value = "0x";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value as Hex;
}

function readWord(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 32 > bytes.length) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "outerData" });
  }
  let value = 0n;
  for (let index = 0; index < 32; index += 1) value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  return value;
}

function quantity(value: string, field: string): bigint {
  if (!QUANTITY.test(value)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field });
  return BigInt(value);
}

function validateReceiptShape(receipt: RpcReceipt): void {
  if (receipt.status === "0x0") throw new InspectionError(InspectionErrorCode.TRANSACTION_REVERTED);
  if (receipt.status !== "0x1") throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "status" });
  assertTransactionHash(receipt.transactionHash);
  if (!BYTES32.test(receipt.blockHash)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "blockHash" });
  quantity(receipt.blockNumber, "blockNumber");
  quantity(receipt.transactionIndex, "transactionIndex");
  if (!ADDRESS.test(receipt.from)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "from" });
  if (receipt.to !== null && !ADDRESS.test(receipt.to)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "to" });
  if (receipt.contractAddress !== null && !ADDRESS.test(receipt.contractAddress)) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "contractAddress" });
  }
  if (!Array.isArray(receipt.logs)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "logs" });
  for (const log of receipt.logs) {
    if (!ADDRESS.test(log.address)
      || !Array.isArray(log.topics) || log.topics.some((topic: unknown) => typeof topic !== "string" || !BYTES32.test(topic))
      || !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)
      || !BYTES32.test(log.blockHash)) {
      throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "log" });
    }
    quantity(log.logIndex, "log.logIndex");
    quantity(log.transactionIndex, "log.transactionIndex");
    quantity(log.blockNumber, "log.blockNumber");
    assertTransactionHash(log.transactionHash);
    if (log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase()
      || log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
      || log.blockNumber !== receipt.blockNumber
      || log.transactionIndex !== receipt.transactionIndex) {
      throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "log.receiptLink" });
    }
  }
}

export function decodeOuterPayload(data: string): Hex {
  const bytes = hexToBytes(data);
  if (bytes.length < 64 || readWord(bytes, 0) !== 32n) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "outerData" });
  }
  const declaredLength = readWord(bytes, 32);
  if (declaredLength > 65_536n || declaredLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "payloadLength" });
  }
  const payloadLength = Number(declaredLength);
  const paddedLength = Math.ceil(payloadLength / 32) * 32;
  const expectedLength = 64 + paddedLength;
  if (bytes.length !== expectedLength) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "outerLength" });
  }
  for (let index = 64 + payloadLength; index < expectedLength; index += 1) {
    if (bytes[index] !== 0) {
      throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "outerPadding" });
    }
  }
  return bytesToHex(bytes.subarray(64, 64 + payloadLength));
}

function parseExecutionHeight(topic: string): bigint {
  if (!/^0x0{48}[0-9a-fA-F]{16}$/.test(topic)) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "executionHeight" });
  }
  return BigInt(topic);
}

function validateEvents(log: RpcLog, deployment: SwaputerDeployment): SwaputerExecution {
  if (log.topics.length !== 3) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "topics" });
  }
  const worldId = log.topics[1];
  if (worldId === undefined || !/^0x[0-9a-fA-F]{64}$/.test(worldId)) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "worldId" });
  }
  if (worldId.toLowerCase() !== deployment.worldId) {
    throw new InspectionError(InspectionErrorCode.UNSUPPORTED_DEPLOYMENT, { worldId: worldId.toLowerCase() });
  }
  const heightTopic = log.topics[2];
  if (heightTopic === undefined) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "executionHeight" });
  }
  const payload = decodeOuterPayload(log.data);
  try {
    return Object.freeze({
      worldId: normalizeHex(worldId),
      executionHeight: parseExecutionHeight(heightTopic),
      payload,
      logIndex: BigInt(log.logIndex),
      receipt: decodeVMReceipt(payload as ReceiptHex)
    });
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    if (isVMReceiptError(error)) {
      throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { receiptError: error.code }, error);
    }
    throw error;
  }
}

export function inspectRpcReceipt(
  receipt: RpcReceipt,
  deployment: SwaputerDeployment
): Omit<InspectionResult, "rpcUrl" | "confirmations" | "finalizedBlockNumber" | "finalizedBlockHash"> {
  validateReceiptShape(receipt);
  const matchingTopic = receipt.logs.filter((log) => log.topics[0]?.toLowerCase() === EVENTS_TOPIC);
  if (matchingTopic.length === 0) throw new InspectionError(InspectionErrorCode.NOT_SWAPUTER);
  const matchingKernel = matchingTopic.filter((log) => log.address.toLowerCase() === deployment.kernel);
  if (matchingKernel.length === 0) throw new InspectionError(InspectionErrorCode.UNSUPPORTED_DEPLOYMENT);
  const executions = matchingKernel.map((log) => validateEvents(log, deployment));
  return Object.freeze({
    kind: "verified" as const,
    deployment,
    transactionHash: normalizeHex(receipt.transactionHash),
    blockNumber: quantity(receipt.blockNumber, "blockNumber"),
    blockHash: normalizeHex(receipt.blockHash),
    transactionIndex: quantity(receipt.transactionIndex, "transactionIndex"),
    executions: Object.freeze(executions)
  });
}

function canonicalBlock(value: RpcBlock | null, field: string): { readonly number: bigint; readonly hash: Hex } {
  if (value === null || typeof value !== "object" || !BYTES32.test(value.hash)) {
    throw new InspectionError(InspectionErrorCode.TRANSACTION_NOT_CANONICAL, { field });
  }
  return Object.freeze({ number: quantity(value.number, `${field}.number`), hash: normalizeHex(value.hash) });
}

function validateCanonicalTransaction(transaction: RpcTransaction | null, receipt: RpcReceipt, deployment: SwaputerDeployment): void {
  if (transaction === null || typeof transaction !== "object") {
    throw new InspectionError(InspectionErrorCode.TRANSACTION_NOT_CANONICAL, { field: "transaction" });
  }
  if (!BYTES32.test(transaction.hash)
    || transaction.hash.toLowerCase() !== receipt.transactionHash.toLowerCase()
    || transaction.blockHash === null || !BYTES32.test(transaction.blockHash)
    || transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
    || transaction.blockNumber === null || quantity(transaction.blockNumber, "transaction.blockNumber") !== quantity(receipt.blockNumber, "blockNumber")
    || transaction.transactionIndex === null || quantity(transaction.transactionIndex, "transaction.transactionIndex") !== quantity(receipt.transactionIndex, "transactionIndex")
    || quantity(transaction.chainId, "transaction.chainId") !== deployment.chainId
    || !ADDRESS.test(transaction.from) || transaction.from.toLowerCase() !== receipt.from.toLowerCase()
    || (transaction.to !== null && !ADDRESS.test(transaction.to))
    || (transaction.to?.toLowerCase() ?? null) !== (receipt.to?.toLowerCase() ?? null)) {
    throw new InspectionError(InspectionErrorCode.TRANSACTION_NOT_CANONICAL, { field: "transactionLink" });
  }
  quantity(transaction.nonce, "transaction.nonce");
}

async function verifyCanonicalFinality(
  rpcUrl: string,
  receipt: RpcReceipt,
  deployment: SwaputerDeployment,
  transport: RpcTransport
): Promise<Pick<InspectionResult, "confirmations" | "finalizedBlockNumber" | "finalizedBlockHash">> {
  const [blockValue, transaction, finalizedValue, latestValue] = await Promise.all([
    transport.request<RpcBlock | null>(rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    transport.request<RpcTransaction | null>(rpcUrl, "eth_getTransactionByHash", [receipt.transactionHash]),
    transport.request<RpcBlock | null>(rpcUrl, "eth_getBlockByNumber", ["finalized", false]),
    transport.request<RpcBlock | null>(rpcUrl, "eth_getBlockByNumber", ["latest", false])
  ]);
  const block = canonicalBlock(blockValue, "containingBlock");
  const finalized = canonicalBlock(finalizedValue, "finalizedBlock");
  const latest = canonicalBlock(latestValue, "latestBlock");
  const receiptNumber = quantity(receipt.blockNumber, "blockNumber");
  if (finalized.number > latest.number
    || block.number !== receiptNumber || block.hash !== normalizeHex(receipt.blockHash)) {
    throw new InspectionError(InspectionErrorCode.TRANSACTION_NOT_CANONICAL, { field: "canonicalChain" });
  }
  validateCanonicalTransaction(transaction, receipt, deployment);
  if (finalized.number < receiptNumber
    || (finalized.number === receiptNumber && finalized.hash !== normalizeHex(receipt.blockHash))) {
    throw new InspectionError(InspectionErrorCode.TRANSACTION_NOT_FINALIZED, {
      blockNumber: receiptNumber.toString(),
      finalizedBlockNumber: finalized.number.toString()
    });
  }
  const confirmations = latest.number >= receiptNumber ? latest.number - receiptNumber + 1n : 0n;
  if (confirmations < MINIMUM_INSPECTION_CONFIRMATIONS) {
    throw new InspectionError(InspectionErrorCode.TRANSACTION_NOT_FINALIZED, {
      confirmations: confirmations.toString(),
      requiredConfirmations: MINIMUM_INSPECTION_CONFIRMATIONS.toString()
    });
  }
  return Object.freeze({ confirmations, finalizedBlockNumber: finalized.number, finalizedBlockHash: finalized.hash });
}

function hashRuntimeCode(code: string): Hex {
  const bytes = hexToBytes(code);
  return bytesToHex(keccak_256(bytes));
}

async function inspectOnRpc(
  rpcUrl: string,
  transactionHash: Hex,
  deployment: SwaputerDeployment,
  transport: RpcTransport
): Promise<InspectionResult> {
  const chainId = await transport.request<string>(rpcUrl, "eth_chainId", []);
  if (chainId.toLowerCase() !== deployment.chainIdHex) {
    throw new InspectionError(InspectionErrorCode.UNSUPPORTED_NETWORK, { chainId });
  }
  const receipt = await transport.request<RpcReceipt | null>(rpcUrl, "eth_getTransactionReceipt", [transactionHash]);
  if (receipt === null) throw new InspectionError(InspectionErrorCode.TRANSACTION_NOT_FOUND);
  if (receipt.transactionHash.toLowerCase() !== transactionHash) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "transactionHash" });
  }
  const decoded = inspectRpcReceipt(receipt, deployment);
  const finality = await verifyCanonicalFinality(rpcUrl, receipt, deployment, transport);
  const runtimeCode = await transport.request<string>(rpcUrl, "eth_getCode", [deployment.kernel, receipt.blockNumber]);
  const actualCodeHash = hashRuntimeCode(runtimeCode);
  if (actualCodeHash !== deployment.kernelRuntimeCodeHash) {
    throw new InspectionError(InspectionErrorCode.KERNEL_CODE_HASH_MISMATCH, { actualCodeHash });
  }
  return Object.freeze({ ...decoded, ...finality, rpcUrl });
}

export async function inspectTransaction(
  transactionHashInput: string,
  options: {
    readonly deployment?: SwaputerDeployment;
    readonly transport?: RpcTransport;
  } = {}
): Promise<InspectionResult> {
  assertTransactionHash(transactionHashInput);
  const transactionHash = normalizeHex(transactionHashInput);
  const deployment = options.deployment ?? DEPLOYMENTS[0];
  if (deployment === undefined) throw new InspectionError(InspectionErrorCode.UNSUPPORTED_NETWORK);
  const transport = options.transport ?? new HttpRpcTransport();
  let lastRpcError: unknown;
  for (const rpcUrl of deployment.rpcUrls) {
    try {
      return await inspectOnRpc(rpcUrl, transactionHash, deployment, transport);
    } catch (error) {
      if (error instanceof InspectionError) throw error;
      lastRpcError = error;
    }
  }
  throw new InspectionError(InspectionErrorCode.RPC_UNAVAILABLE, {}, lastRpcError);
}

export function isInspectionError(error: unknown): error is InspectionError {
  return error instanceof InspectionError;
}
