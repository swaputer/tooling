import type { Hex } from "./types";
import { InspectionError, InspectionErrorCode } from "./types";

interface RpcSuccess<T> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: T;
}

interface RpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string };
}

export interface RpcTransport {
  request<T>(url: string, method: string, params: readonly unknown[]): Promise<T>;
}

export class HttpRpcTransport implements RpcTransport {
  async request<T>(url: string, method: string, params: readonly unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload = (await response.json()) as RpcSuccess<T> | RpcFailure;
      if ("error" in payload) throw new Error(`RPC_${payload.error.code}`);
      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function requestWithFallback<T>(
  urls: readonly string[],
  method: string,
  params: readonly unknown[],
  transport: RpcTransport = new HttpRpcTransport()
): Promise<{ readonly result: T; readonly rpcUrl: string }> {
  let lastError: unknown;
  for (const rpcUrl of urls) {
    try {
      return { result: await transport.request<T>(rpcUrl, method, params), rpcUrl };
    } catch (error) {
      lastError = error;
    }
  }
  throw new InspectionError(InspectionErrorCode.RPC_UNAVAILABLE, { method }, lastError);
}

export function assertTransactionHash(value: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new InspectionError(InspectionErrorCode.INVALID_TRANSACTION_HASH);
  }
}
