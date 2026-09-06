import { InspectionError, InspectionErrorCode } from "./errors.js";

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

export function rpcUrlFromEnvironment(environmentName: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(environmentName)) {
    throw new InspectionError(InspectionErrorCode.CLI_USAGE, { field: "rpc-env" });
  }
  const value = process.env[environmentName];
  if (value === undefined || value.length === 0) {
    throw new InspectionError(InspectionErrorCode.RPC_ENV_MISSING, { environment: environmentName });
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
  } catch (error) {
    throw new InspectionError(InspectionErrorCode.RPC_ENV_MISSING, { environment: environmentName }, error);
  }
  return value;
}
