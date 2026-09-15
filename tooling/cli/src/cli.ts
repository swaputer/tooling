#!/usr/bin/env node

import { decodeVMReceipt, isVMReceiptError, type Hex as ReceiptHex } from "@swaputer-labs/receipt-codec";
import { loadDeployment } from "./deployment.js";
import { InspectionError, InspectionErrorCode, inspectionExitCode, isInspectionError } from "./errors.js";
import { inspectTransaction } from "./inspect.js";
import { jsonStringify } from "./json.js";
import { rpcUrlFromEnvironment } from "./rpc.js";
import { CLI_VERSION } from "./version.js";

const USAGE = `Usage:
  swaputer inspect <transaction-hash> --rpc-env <ENV_NAME> [--network ethereum-mainnet|base-sepolia] [--json]
  swaputer decode-receipt <0x-payload> [--json]
  swaputer --help
  swaputer --version`;

interface ParsedInspect {
  readonly transactionHash: string;
  readonly rpcEnvironment: string;
  readonly network: string;
  readonly json: boolean;
}

function parseInspect(arguments_: readonly string[]): ParsedInspect {
  const transactionHash = arguments_[0];
  if (transactionHash === undefined || transactionHash.startsWith("--")) throw new InspectionError(InspectionErrorCode.CLI_USAGE);
  let rpcEnvironment: string | undefined;
  let network = "ethereum-mainnet";
  let networkSeen = false;
  let json = false;
  for (let index = 1; index < arguments_.length;) {
    const key = arguments_[index];
    if (key === "--json") {
      if (json) throw new InspectionError(InspectionErrorCode.CLI_USAGE);
      json = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new InspectionError(InspectionErrorCode.CLI_USAGE);
    if (key === "--rpc-env" && rpcEnvironment === undefined) rpcEnvironment = value;
    else if (key === "--network" && !networkSeen) {
      network = value;
      networkSeen = true;
    }
    else throw new InspectionError(InspectionErrorCode.CLI_USAGE);
    index += 2;
  }
  if (rpcEnvironment === undefined) throw new InspectionError(InspectionErrorCode.CLI_USAGE, { missing: "rpc-env" });
  return { transactionHash, rpcEnvironment, network, json };
}

function printInspection(result: Awaited<ReturnType<typeof inspectTransaction>>): void {
  process.stdout.write(`Verified Swaputer transaction ${result.transactionHash}\n`);
  process.stdout.write(`Network: ${result.deployment.networkName} (${result.deployment.chainId})\n`);
  process.stdout.write(`Release: ${result.deployment.releaseName}\n`);
  process.stdout.write(`Block: ${result.blockNumber}\n`);
  process.stdout.write(`Finality: finalized at ${result.finalizedBlockNumber} (${result.confirmations} confirmations observed)\n`);
  for (const [index, execution] of result.executions.entries()) {
    const summary = execution.receipt.worldExecution;
    process.stdout.write(`Execution ${index + 1}: height=${execution.executionHeight} actor=${summary.actor} target=${summary.rootTarget} bytes=${summary.executedBytes} burned=${summary.tokenBurned}\n`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (command === "decode-receipt") {
    const [payload, flag] = rest;
    if (payload === undefined || rest.length > 2 || (flag !== undefined && flag !== "--json")) throw new InspectionError(InspectionErrorCode.CLI_USAGE);
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(payload)) throw new InspectionError(InspectionErrorCode.INVALID_RECEIPT_PAYLOAD);
    try {
      const receipt = decodeVMReceipt(payload as ReceiptHex);
      if (flag === "--json") process.stdout.write(`${jsonStringify(receipt)}\n`);
      else process.stdout.write(`Valid VMReceiptV1: records=${receipt.recordCount} bytes=${receipt.worldExecution.executedBytes} burned=${receipt.worldExecution.tokenBurned}\n`);
      return;
    } catch (error) {
      if (isVMReceiptError(error)) throw new InspectionError(InspectionErrorCode.INVALID_RECEIPT_PAYLOAD, { receiptError: error.code }, error);
      throw error;
    }
  }
  if (command === "inspect") {
    const parsed = parseInspect(rest);
    const deployment = await loadDeployment(parsed.network);
    const rpcUrl = rpcUrlFromEnvironment(parsed.rpcEnvironment);
    const result = await inspectTransaction(parsed.transactionHash, {
      deployment,
      rpcUrl,
      rpcEnvironment: parsed.rpcEnvironment
    });
    if (parsed.json) process.stdout.write(`${jsonStringify(result)}\n`);
    else printInspection(result);
    return;
  }
  throw new InspectionError(InspectionErrorCode.CLI_USAGE);
}

main().catch((error: unknown) => {
  if (isInspectionError(error)) {
    process.stderr.write(`${jsonStringify({ status: "error", code: error.code, details: error.details })}\n`);
    if (error.code === InspectionErrorCode.CLI_USAGE) process.stderr.write(`${USAGE}\n`);
    process.exitCode = inspectionExitCode(error.code);
    return;
  }
  process.stderr.write(`${jsonStringify({ status: "error", code: "INTERNAL_ERROR" })}\n`);
  process.exitCode = 1;
});
