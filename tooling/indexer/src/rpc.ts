import { IndexerError, IndexerErrorCode, RpcRangeTooLargeError } from "./errors.js";
import type { RpcTransport } from "./types.js";

interface JsonRpcResponse<T> {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: T;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export class HttpJsonRpcTransport implements RpcTransport {
  readonly #url: string;
  readonly #timeoutMs: number;
  #requestId = 0;

  constructor(url: string, options: { readonly timeoutMs?: number } = {}) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      throw new IndexerError(IndexerErrorCode.RPC_TRANSPORT, "RPC", { fatal: true });
    }
    this.#url = url;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T>(method: string, params: readonly unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#requestId, method, params }),
        signal: controller.signal
      });
    } catch {
      throw new IndexerError(IndexerErrorCode.RPC_TRANSPORT, "RPC", { retryable: true });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      if (response.status === 413 || response.status === 429) throw new RpcRangeTooLargeError();
      throw new IndexerError(IndexerErrorCode.RPC_TRANSPORT, "RPC", {
        retryable: response.status >= 500 || response.status === 408,
        details: { status: response.status }
      });
    }
    let body: JsonRpcResponse<T>;
    try {
      body = (await response.json()) as JsonRpcResponse<T>;
    } catch {
      throw new IndexerError(IndexerErrorCode.RPC_RESPONSE, "RPC", { retryable: true });
    }
    if (body.error !== undefined) {
      const code = typeof body.error.code === "number" ? body.error.code : null;
      const message = typeof body.error.message === "string" ? body.error.message.toLowerCase() : "";
      if (code === -32005 || /range|too many|response size|limit exceeded/.test(message)) {
        throw new RpcRangeTooLargeError();
      }
      throw new IndexerError(IndexerErrorCode.RPC_TRANSPORT, "RPC", {
        retryable: true,
        details: { rpcCode: code }
      });
    }
    if (!("result" in body)) throw new IndexerError(IndexerErrorCode.RPC_RESPONSE, "RPC", { retryable: true });
    return body.result as T;
  }
}
