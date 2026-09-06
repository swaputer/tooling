import { decodeVMReceipt, isVMReceiptError, type Hex as ReceiptHex } from "@swaputer/receipt-codec";
import { keccak_256 } from "@noble/hashes/sha3";
import { InspectionError, InspectionErrorCode } from "./errors.js";
import { HttpRpcTransport, type RpcTransport } from "./rpc.js";
import type { Hex, InspectionResult, RpcLog, RpcReceipt, SwaputerDeployment, SwaputerExecution } from "./types.js";

export const EVENTS_TOPIC = "0x602812b230e5dc416bb4163643fb95093808246664e5b824bf2849ffb8c33d04";
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function normalizeHex(value: string): Hex {
  return value.toLowerCase() as Hex;
}

function hexToBytes(value: string): Uint8Array {
  if (!HEX_BYTES.test(value)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "data" });
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let value = "0x";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value as Hex;
}

function readWord(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 32 > bytes.length) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "outerData" });
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
  if (!Array.isArray(receipt.logs)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "logs" });
  for (const log of receipt.logs) {
    if (log === null || typeof log !== "object") throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "log" });
    if (!ADDRESS.test(log.address)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "log.address" });
    if (!Array.isArray(log.topics) || log.topics.some((topic: unknown) => typeof topic !== "string" || !BYTES32.test(topic))) {
      throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "log.topics" });
    }
    if (typeof log.data !== "string" || !HEX_BYTES.test(log.data)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "log.data" });
    quantity(log.logIndex, "log.logIndex");
    quantity(log.transactionIndex, "log.transactionIndex");
    quantity(log.blockNumber, "log.blockNumber");
    if (!BYTES32.test(log.blockHash)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "log.blockHash" });
    assertTransactionHash(log.transactionHash);
    if (
      log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase()
      || log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
      || log.blockNumber !== receipt.blockNumber
      || log.transactionIndex !== receipt.transactionIndex
    ) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "log.receiptLink" });
  }
}

export function assertTransactionHash(value: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new InspectionError(InspectionErrorCode.INVALID_TRANSACTION_HASH);
}

export function decodeOuterPayload(data: string): Hex {
  const bytes = hexToBytes(data);
  if (bytes.length < 64 || readWord(bytes, 0) !== 32n) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "outerData" });
  const declaredLength = readWord(bytes, 32);
  if (declaredLength > 65_536n || declaredLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "payloadLength" });
  }
  const payloadLength = Number(declaredLength);
  const paddedLength = Math.ceil(payloadLength / 32) * 32;
  const expectedLength = 64 + paddedLength;
  if (bytes.length !== expectedLength) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "outerLength" });
  for (let index = 64 + payloadLength; index < expectedLength; index += 1) {
    if (bytes[index] !== 0) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "outerPadding" });
  }
  return bytesToHex(bytes.subarray(64, 64 + payloadLength));
}

function validateEvents(log: RpcLog, deployment: SwaputerDeployment): SwaputerExecution {
  if (log.topics.length !== 3) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "topics" });
  const worldId = log.topics[1];
  if (worldId === undefined || !/^0x[0-9a-fA-F]{64}$/.test(worldId)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "worldId" });
  if (worldId.toLowerCase() !== deployment.worldId) throw new InspectionError(InspectionErrorCode.UNSUPPORTED_DEPLOYMENT, { worldId: worldId.toLowerCase() });
  const heightTopic = log.topics[2];
  if (heightTopic === undefined || !/^0x0{48}[0-9a-fA-F]{16}$/.test(heightTopic)) {
    throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "executionHeight" });
  }
  const payload = decodeOuterPayload(log.data);
  try {
    return Object.freeze({
      worldId: normalizeHex(worldId),
      executionHeight: BigInt(heightTopic),
      payload,
      logIndex: quantity(log.logIndex, "logIndex"),
      receipt: decodeVMReceipt(payload as ReceiptHex)
    });
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    if (isVMReceiptError(error)) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { receiptError: error.code }, error);
    throw error;
  }
}

export function inspectRpcReceipt(receipt: RpcReceipt, deployment: SwaputerDeployment): Omit<InspectionResult, "rpcEnvironment"> {
  validateReceiptShape(receipt);
  const matchingTopic = receipt.logs.filter((log) => log.topics[0]?.toLowerCase() === EVENTS_TOPIC);
  if (matchingTopic.length === 0) throw new InspectionError(InspectionErrorCode.NOT_SWAPUTER);
  const matchingKernel = matchingTopic.filter((log) => log.address.toLowerCase() === deployment.kernel);
  if (matchingKernel.length === 0) throw new InspectionError(InspectionErrorCode.UNSUPPORTED_DEPLOYMENT);
  return Object.freeze({
    kind: "verified",
    deployment,
    transactionHash: normalizeHex(receipt.transactionHash),
    blockNumber: quantity(receipt.blockNumber, "blockNumber"),
    blockHash: normalizeHex(receipt.blockHash),
    transactionIndex: quantity(receipt.transactionIndex, "transactionIndex"),
    executions: Object.freeze(matchingKernel.map((log) => validateEvents(log, deployment)))
  });
}

function runtimeCodeHash(code: string): Hex {
  return bytesToHex(keccak_256(hexToBytes(code)));
}

export async function inspectTransaction(
  transactionHashInput: string,
  options: {
    readonly deployment: SwaputerDeployment;
    readonly rpcUrl: string;
    readonly rpcEnvironment: string;
    readonly transport?: RpcTransport;
  }
): Promise<InspectionResult> {
  assertTransactionHash(transactionHashInput);
  const transactionHash = normalizeHex(transactionHashInput);
  const transport = options.transport ?? new HttpRpcTransport();
  try {
    const chainId = await transport.request<string>(options.rpcUrl, "eth_chainId", []);
    if (!QUANTITY.test(chainId) || BigInt(chainId) !== options.deployment.chainId) {
      throw new InspectionError(InspectionErrorCode.UNSUPPORTED_NETWORK, { chainId: QUANTITY.test(chainId) ? BigInt(chainId).toString() : "invalid" });
    }
    const receipt = await transport.request<RpcReceipt | null>(options.rpcUrl, "eth_getTransactionReceipt", [transactionHash]);
    if (receipt === null) throw new InspectionError(InspectionErrorCode.TRANSACTION_NOT_FOUND);
    if (receipt.transactionHash.toLowerCase() !== transactionHash) throw new InspectionError(InspectionErrorCode.MALFORMED_EVENTS, { field: "transactionHash" });
    const decoded = inspectRpcReceipt(receipt, options.deployment);
    const runtimeCode = await transport.request<string>(options.rpcUrl, "eth_getCode", [options.deployment.kernel, receipt.blockNumber]);
    const actualCodeHash = runtimeCodeHash(runtimeCode);
    if (actualCodeHash !== options.deployment.kernelRuntimeCodeHash) {
      throw new InspectionError(InspectionErrorCode.KERNEL_CODE_HASH_MISMATCH, { actualCodeHash });
    }
    return Object.freeze({ ...decoded, rpcEnvironment: options.rpcEnvironment });
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    throw new InspectionError(InspectionErrorCode.RPC_UNAVAILABLE, { environment: options.rpcEnvironment }, error);
  }
}
