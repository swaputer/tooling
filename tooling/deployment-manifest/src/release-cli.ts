#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { canonicalJson, keccakHex, parseStrictJson } from "./canonical.js";
import { ReleaseError, preflightTestnetRelease, validateTestnetReleaseConfig } from "./release.js";
import type { ArtifactInventory, ReleaseObservation } from "./release.js";

function options(values: readonly string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || output.has(key)) {
      throw new ReleaseError("INVALID_RELEASE_CONFIG", "$", "invalid CLI arguments");
    }
    output.set(key, value);
  }
  return output;
}

async function jsonFile(path: string): Promise<unknown> {
  return parseStrictJson(await readFile(path, "utf8"));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = options(rest);
  const configPath = parsed.get("--config");
  const artifactsPath = parsed.get("--artifacts");
  if (parsed.size !== 3 || configPath === undefined || artifactsPath === undefined) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$", "exactly three options are required");
  const rawConfig = await jsonFile(configPath);
  if (command === "live-preflight") {
    const environmentName = parsed.get("--rpc-env");
    if (environmentName === undefined) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.rpc", "missing RPC environment variable name");
    const config = validateTestnetReleaseConfig(rawConfig);
    if (!config.rpcEnvironmentVariables.includes(environmentName)) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.rpcEnvironmentVariables", "RPC environment variable is not authorized by config");
    const rpcUrl = process.env[environmentName];
    if (rpcUrl === undefined || rpcUrl.length === 0) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.rpc", "RPC environment variable is unset");
    let rpcId = 0;
    const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
      const body = await response.json() as { result?: unknown; error?: unknown };
      if (body.error !== undefined || body.result === undefined) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.rpc", "read-only RPC observation failed");
      return body.result;
    };
    const code = async (address: string): Promise<{ code: string; extcodehash: `0x${string}` }> => {
      const runtime = await rpc("eth_getCode", [address, "latest"]);
      if (typeof runtime !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(runtime)) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.rpc", "invalid eth_getCode response");
      return { code: runtime, extcodehash: keccakHex(Uint8Array.from(Buffer.from(runtime.slice(2), "hex"))) };
    };
    const chain = await rpc("eth_chainId", []);
    if (typeof chain !== "string" || !/^0x[0-9a-fA-F]+$/.test(chain)) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$.rpc", "invalid eth_chainId response");
    const manager = await code(config.poolManager.address);
    const kernelStore = await code(config.factory.kernelCreationCodeStore.address);
    const hookStore = await code(config.factory.hookCreationCodeStore.address);
    const occupiedAddresses: `0x${string}`[] = [];
    for (const predicted of Object.values(config.predicted)) if ((await code(predicted)).code !== "0x") occupiedAddresses.push(predicted);
    const report = preflightTestnetRelease(rawConfig, {
      chainId: Number(BigInt(chain)),
      poolManager: { address: config.poolManager.address, extcodehash: manager.extcodehash },
      code: {
        kernelCreationCodeStore: { address: config.factory.kernelCreationCodeStore.address, extcodehash: kernelStore.extcodehash },
        hookCreationCodeStore: { address: config.factory.hookCreationCodeStore.address, extcodehash: hookStore.extcodehash }
      },
      occupiedAddresses
    }, await jsonFile(artifactsPath) as ArtifactInventory);
    process.stdout.write(`${canonicalJson({ ...report, observationMode: "read-only-rpc", rpcEnvironmentVariable: environmentName })}\n`);
    return;
  }
  if (command !== "preflight") throw new ReleaseError("INVALID_RELEASE_CONFIG", "$", "supported commands: preflight, live-preflight");
  const observationPath = parsed.get("--observation");
  if (observationPath === undefined) throw new ReleaseError("INVALID_RELEASE_CONFIG", "$", "missing observation path");
  const report = preflightTestnetRelease(
    rawConfig,
    await jsonFile(observationPath) as ReleaseObservation,
    await jsonFile(artifactsPath) as ArtifactInventory
  );
  process.stdout.write(`${canonicalJson(report)}\n`);
}

main().catch((cause: unknown) => {
  const error = cause instanceof ReleaseError ? cause.toJSON() : { code: "UNEXPECTED", path: "$" };
  process.stderr.write(`${canonicalJson({ error })}\n`);
  process.exitCode = 1;
});
