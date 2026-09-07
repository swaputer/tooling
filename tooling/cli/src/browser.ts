import { decodeVMReceipt, isVMReceiptError, type Hex as ReceiptHex } from "@swaputer-labs/receipt-codec";
import { InspectionError, InspectionErrorCode, isInspectionError } from "./errors.js";
import { inspectTransaction } from "./inspect.js";
import { jsonStringify } from "./json.js";
import type { RpcTransport } from "./rpc.js";
import type { SwaputerDeployment } from "./types.js";

export const CLI_VERSION = "0.1.2";

export const BROWSER_HELP = Object.freeze([
  "Swaputer Terminal — read-only transaction verification",
  "",
  "Commands:",
  "  inspect <transaction-hash> [--json]",
  "  decode-receipt <0x-payload> [--json]",
  "  clear",
  "  version",
  "  help"
]);

export interface BrowserCommandOptions {
  readonly deployment: SwaputerDeployment;
  readonly rpcUrl: string;
  readonly transport?: RpcTransport;
}

export interface BrowserCommandResult {
  readonly clear?: boolean;
  readonly lines: readonly string[];
}

function usage(details: Readonly<Record<string, string>> = {}): never {
  throw new InspectionError(InspectionErrorCode.CLI_USAGE, details);
}

function jsonFlag(arguments_: readonly string[]): boolean {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === "--json") return true;
  return usage();
}

export async function executeBrowserCommand(input: string, options?: BrowserCommandOptions): Promise<BrowserCommandResult> {
  const [command, ...arguments_] = input.trim().split(/\s+/).filter(Boolean);
  if (!command) return { lines: [] };
  if (command === "help" || command === "--help") {
    if (arguments_.length) usage();
    return { lines: BROWSER_HELP };
  }
  if (command === "version" || command === "--version") {
    if (arguments_.length) usage();
    return { lines: [`@swaputer-labs/cli ${CLI_VERSION}`] };
  }
  if (command === "clear") {
    if (arguments_.length) usage();
    return { clear: true, lines: [] };
  }
  if (command === "decode-receipt") {
    const [payload, ...flags] = arguments_;
    if (!payload || !/^0x(?:[0-9a-fA-F]{2})*$/.test(payload)) {
      throw new InspectionError(InspectionErrorCode.INVALID_RECEIPT_PAYLOAD);
    }
    const json = jsonFlag(flags);
    try {
      const receipt = decodeVMReceipt(payload as ReceiptHex);
      return { lines: [json ? jsonStringify(receipt) : `Valid VMReceiptV1: records=${receipt.recordCount} bytes=${receipt.worldExecution.executedBytes} burned=${receipt.worldExecution.tokenBurned}`] };
    } catch (error) {
      if (isVMReceiptError(error)) throw new InspectionError(InspectionErrorCode.INVALID_RECEIPT_PAYLOAD, { receiptError: error.code }, error);
      throw error;
    }
  }
  if (command === "inspect") {
    const [transactionHash, ...flags] = arguments_;
    if (!transactionHash) usage({ missing: "transaction-hash" });
    const json = jsonFlag(flags);
    if (!options) usage({ missing: "browser-options" });
    const result = await inspectTransaction(transactionHash, {
      deployment: options.deployment,
      rpcUrl: options.rpcUrl,
      rpcEnvironment: "browser",
      ...(options.transport ? { transport: options.transport } : {})
    });
    if (json) return { lines: [jsonStringify(result)] };
    const lines = [
      `Verified Swaputer transaction ${result.transactionHash}`,
      `Network: ${result.deployment.networkName} (${result.deployment.chainId})`,
      `Release: ${result.deployment.releaseName}`,
      `Block: ${result.blockNumber}`
    ];
    for (const [index, execution] of result.executions.entries()) {
      const summary = execution.receipt.worldExecution;
      lines.push(`Execution ${index + 1}: height=${execution.executionHeight} actor=${summary.actor} target=${summary.rootTarget} bytes=${summary.executedBytes} burned=${summary.tokenBurned}`);
    }
    return { lines };
  }
  usage({ command });
}

export function browserErrorLines(error: unknown): readonly string[] {
  if (isInspectionError(error)) {
    const details = Object.keys(error.details).length ? ` ${jsonStringify(error.details)}` : "";
    return [`error: ${error.code}${details}`];
  }
  return ["error: INTERNAL_ERROR"];
}

export { InspectionError, InspectionErrorCode, isInspectionError } from "./errors.js";
export type { RpcTransport } from "./rpc.js";
export type { Hex, InspectionResult, SwaputerDeployment } from "./types.js";
