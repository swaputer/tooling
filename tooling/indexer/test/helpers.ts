import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";

import { RpcRangeTooLargeError, IndexerError, IndexerErrorCode } from "../src/errors.js";
import { EVENTS_TOPIC } from "../src/events.js";
import { parseQuantity, toQuantity } from "../src/encoding.js";
import type { Address, Bytes32, Hex, RpcBlock, RpcLog, RpcTransport } from "../src/types.js";

export const KERNEL = "0x1000000000000000000000000000000000000001" as Address;
export const OTHER_KERNEL = "0x2000000000000000000000000000000000000002" as Address;
export const WORLD = `0x${"ab".repeat(32)}` as Bytes32;

interface Fixture {
  readonly payload: Hex;
}

export function fixturePayload(name = "unsigned-nop"): Hex {
  const path = resolve(process.cwd(), "../receipt-codec/fixtures", `${name}.json`);
  return (JSON.parse(readFileSync(path, "utf8")) as Fixture).payload;
}

export function hash(label: string): Bytes32 {
  return `0x${Buffer.from(keccak_256(new TextEncoder().encode(label))).toString("hex")}` as Bytes32;
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

export function outerData(payload: Hex, options: { readonly offset?: bigint; readonly length?: bigint; readonly paddingByte?: string; readonly trailing?: string } = {}): Hex {
  const data = payload.slice(2);
  const length = options.length ?? BigInt(data.length / 2);
  const padding = Number((32n - (length % 32n)) % 32n);
  const padded = `${data}${(options.paddingByte ?? "00").repeat(padding)}`;
  return `0x${word(options.offset ?? 32n)}${word(length)}${padded}${options.trailing ?? ""}` as Hex;
}

export function makeLog(
  blockNumber: bigint,
  blockHash: Bytes32,
  height: bigint,
  options: {
    readonly payload?: Hex;
    readonly address?: Address;
    readonly worldId?: Bytes32;
    readonly transactionIndex?: bigint;
    readonly logIndex?: bigint;
    readonly transactionHash?: Bytes32;
    readonly data?: Hex;
    readonly topics?: readonly string[];
  } = {}
): RpcLog {
  const transactionIndex = options.transactionIndex ?? 0n;
  const logIndex = options.logIndex ?? 0n;
  return {
    address: options.address ?? KERNEL,
    topics: options.topics ?? [EVENTS_TOPIC, options.worldId ?? WORLD, `0x${word(height)}`],
    data: options.data ?? outerData(options.payload ?? fixturePayload()),
    blockNumber: toQuantity(blockNumber),
    blockHash,
    transactionHash: options.transactionHash ?? hash(`tx:${blockHash}:${transactionIndex}:${logIndex}`),
    transactionIndex: toQuantity(transactionIndex),
    logIndex: toQuantity(logIndex),
    removed: false
  };
}

export class FakeRpcTransport implements RpcTransport {
  readonly chainId: bigint;
  readonly blocks = new Map<bigint, RpcBlock>();
  readonly logs = new Map<bigint, RpcLog[]>();
  readonly calls = new Map<string, number>();
  maxLogRange: bigint | null = null;
  reverseLogs = false;
  duplicateLogs = false;
  transientFailures = new Map<string, number>();
  #branch = 0;

  constructor(chainId = 31_337n) {
    this.chainId = chainId;
    const genesisHash = hash(`block:${this.#branch}:0`);
    this.blocks.set(0n, {
      number: "0x0",
      hash: genesisHash,
      parentHash: `0x${"00".repeat(32)}`,
      timestamp: "0x1"
    });
    this.logs.set(0n, []);
  }

  get latest(): bigint {
    return [...this.blocks.keys()].reduce((maximum, value) => (value > maximum ? value : maximum), 0n);
  }

  addBlock(logFactory: (number: bigint, blockHash: Bytes32) => readonly RpcLog[] = () => []): bigint {
    const number = this.latest + 1n;
    const parent = this.blocks.get(number - 1n);
    if (parent === undefined) throw new Error("missing parent");
    const blockHash = hash(`block:${this.#branch}:${number}`);
    this.blocks.set(number, {
      number: toQuantity(number),
      hash: blockHash,
      parentHash: parent.hash,
      timestamp: toQuantity(1_000n + number)
    });
    this.logs.set(number, [...logFactory(number, blockHash)]);
    return number;
  }

  replaceAfter(ancestor: bigint, branches: readonly ((number: bigint, blockHash: Bytes32) => readonly RpcLog[])[]): void {
    for (const number of [...this.blocks.keys()]) {
      if (number > ancestor) {
        this.blocks.delete(number);
        this.logs.delete(number);
      }
    }
    this.#branch += 1;
    for (const factory of branches) this.addBlock(factory);
  }

  fail(method: string, count: number): void {
    this.transientFailures.set(method, count);
  }

  async request<T>(method: string, params: readonly unknown[]): Promise<T> {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    const remaining = this.transientFailures.get(method) ?? 0;
    if (remaining > 0) {
      this.transientFailures.set(method, remaining - 1);
      throw new IndexerError(IndexerErrorCode.RPC_TRANSPORT, "RPC", { retryable: true });
    }
    if (method === "eth_chainId") return toQuantity(this.chainId) as T;
    if (method === "eth_blockNumber") return toQuantity(this.latest) as T;
    if (method === "eth_getBlockByNumber") {
      const number = parseQuantity(String(params[0]));
      return (this.blocks.get(number) ?? null) as T;
    }
    if (method === "eth_getLogs") {
      const filter = params[0] as { readonly fromBlock: string; readonly toBlock: string };
      const from = parseQuantity(filter.fromBlock);
      const to = parseQuantity(filter.toBlock);
      if (this.maxLogRange !== null && to - from + 1n > this.maxLogRange) throw new RpcRangeTooLargeError();
      const result: RpcLog[] = [];
      for (let number = from; number <= to; number += 1n) result.push(...(this.logs.get(number) ?? []));
      if (this.reverseLogs) result.reverse();
      if (this.duplicateLogs) result.push(...result);
      return result as T;
    }
    throw new Error(`unsupported fake RPC method ${method}`);
  }
}

export const TEST_CONFIG = Object.freeze({
  chainId: 31_337n,
  kernelAddress: KERNEL,
  startBlock: 1n,
  confirmations: 0n,
  chunkSize: 10n,
  maxReorgDepth: 16n,
  maxRpcRetries: 3,
  retryBaseDelayMs: 0
});
