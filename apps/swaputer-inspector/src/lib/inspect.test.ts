import { describe, expect, it } from "vitest";
import fixture from "../../../../tooling/receipt-codec/fixtures/unsigned-nop.json";
import { ETHEREUM_MAINNET_DEPLOYMENT } from "./deployments";
import { decodeOuterPayload, inspectRpcReceipt, inspectTransaction, EVENTS_TOPIC } from "./inspect";
import type { RpcTransport } from "./rpc";
import { InspectionError, InspectionErrorCode, type RpcLog, type RpcReceipt } from "./types";

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeOuter(payload: string): string {
  const body = payload.slice(2);
  const padding = "0".repeat((64 - (body.length % 64)) % 64);
  return `0x${word(32n)}${word(BigInt(body.length / 2))}${body}${padding}`;
}

const deployment = Object.freeze({ ...ETHEREUM_MAINNET_DEPLOYMENT, worldId: fixture.worldId.toLowerCase() as `0x${string}` });

function log(overrides: Partial<RpcLog> = {}): RpcLog {
  return {
    address: deployment.kernel,
    topics: [EVENTS_TOPIC, fixture.worldId, `0x${word(1n)}`],
    data: encodeOuter(fixture.payload),
    logIndex: "0x2",
    transactionIndex: "0x1",
    blockNumber: "0x2c001df",
    blockHash: `0x${"b".repeat(64)}`,
    transactionHash: `0x${"a".repeat(64)}`,
    ...overrides
  };
}

function receipt(overrides: Partial<RpcReceipt> = {}): RpcReceipt {
  return {
    blockHash: `0x${"b".repeat(64)}`,
    blockNumber: "0x2c001df",
    contractAddress: null,
    from: "0x1111111111111111111111111111111111111111",
    transactionHash: `0x${"a".repeat(64)}`,
    transactionIndex: "0x1",
    to: deployment.kernel,
    status: "0x1",
    logs: [log()],
    ...overrides
  };
}

function expectInspectionCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(InspectionError);
    expect((error as InspectionError).code).toBe(code);
  }
}

describe("Swaputer transaction recognition", () => {
  it("strictly recognizes and decodes a bound Kernel Events", () => {
    const result = inspectRpcReceipt(receipt(), deployment);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.worldId).toBe(fixture.worldId);
    expect(result.executions[0]?.executionHeight).toBe(1n);
    expect(result.executions[0]?.payload).toBe(fixture.payload);
    expect(result.executions[0]?.receipt.worldExecution.executedBytes).toBe(1);
  });

  it("decodes canonical outer dynamic bytes without changing payload bytes", () => {
    expect(decodeOuterPayload(encodeOuter(fixture.payload))).toBe(fixture.payload);
  });

  it("does not classify unrelated Ethereum logs as Swaputer", () => {
    expectInspectionCode(
      () => inspectRpcReceipt(receipt({ logs: [log({ topics: [`0x${"1".repeat(64)}`] })] }), deployment),
      InspectionErrorCode.NOT_SWAPUTER
    );
  });

  it("refuses a Events-shaped event from an unbound address", () => {
    expectInspectionCode(
      () => inspectRpcReceipt(receipt({ logs: [log({ address: `0x${"1".repeat(40)}` })] }), deployment),
      InspectionErrorCode.UNSUPPORTED_DEPLOYMENT
    );
  });

  it("rejects reverted transactions", () => {
    expectInspectionCode(() => inspectRpcReceipt(receipt({ status: "0x0", logs: [] }), deployment), InspectionErrorCode.TRANSACTION_REVERTED);
  });

  it("rejects non-canonical outer ABI, padding and malformed receipts", () => {
    const canonical = encodeOuter(fixture.payload);
    expectInspectionCode(() => decodeOuterPayload(`${canonical}00`), InspectionErrorCode.MALFORMED_EVENTS);
    expectInspectionCode(
      () => inspectRpcReceipt(receipt({ logs: [log({ data: canonical.slice(0, -1) + "1" })] }), deployment),
      InspectionErrorCode.MALFORMED_EVENTS
    );
    const malformedPayload = "0x02000001";
    expectInspectionCode(
      () => inspectRpcReceipt(receipt({ logs: [log({ data: encodeOuter(malformedPayload) })] }), deployment),
      InspectionErrorCode.MALFORMED_EVENTS
    );
  });

  it("returns every execution in log order for one Ethereum transaction", () => {
    const second = log({ logIndex: "0x3", topics: [EVENTS_TOPIC, fixture.worldId, `0x${word(2n)}`] });
    const result = inspectRpcReceipt(receipt({ logs: [log(), second] }), deployment);
    expect(result.executions.map((execution) => execution.executionHeight)).toEqual([1n, 2n]);
    expect(result.executions.map((execution) => execution.logIndex)).toEqual([2n, 3n]);
  });

  it("requires the exact receipt block and transaction to remain canonical and finalized", async () => {
    const hash = `0x${"a".repeat(64)}`;
    const transport = (containingHash = `0x${"b".repeat(64)}`): RpcTransport => ({
      async request<T>(_rpcUrl: string, method: string, params: readonly unknown[]): Promise<T> {
        if (method === "eth_chainId") return deployment.chainIdHex as T;
        if (method === "eth_getTransactionReceipt") return receipt() as T;
        if (method === "eth_getCode") return "0x" as T;
        if (method === "eth_getTransactionByHash") return {
          hash,
          blockHash: `0x${"b".repeat(64)}`,
          blockNumber: "0x2c001df",
          transactionIndex: "0x1",
          chainId: deployment.chainIdHex,
          from: "0x1111111111111111111111111111111111111111",
          to: deployment.kernel,
          nonce: "0x1"
        } as T;
        if (method === "eth_getBlockByNumber") {
          if (params[0] === "0x2c001df") return { number: "0x2c001df", hash: containingHash } as T;
          if (params[0] === "finalized") return { number: "0x2c001f0", hash: `0x${"c".repeat(64)}` } as T;
          if (params[0] === "latest") return { number: "0x2c00200", hash: `0x${"d".repeat(64)}` } as T;
        }
        throw new Error(`unexpected method ${method}`);
      }
    });
    const runtimeDeployment = Object.freeze({
      ...deployment,
      kernelRuntimeCodeHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" as `0x${string}`,
      rpcUrls: Object.freeze(["https://rpc.invalid"])
    });
    await expect(inspectTransaction(hash, { deployment: runtimeDeployment, transport: transport() }))
      .resolves.toMatchObject({ confirmations: 34n });
    await expect(inspectTransaction(hash, {
      deployment: runtimeDeployment,
      transport: transport(`0x${"e".repeat(64)}`)
    })).rejects.toMatchObject({ code: InspectionErrorCode.TRANSACTION_NOT_CANONICAL });
  });
});
