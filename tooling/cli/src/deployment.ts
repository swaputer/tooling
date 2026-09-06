import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InspectionError, InspectionErrorCode } from "./errors.js";
import type { Hex, SwaputerDeployment } from "./types.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DEPLOYMENTS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../deployments");
const NETWORK_IDS = new Set(["base-sepolia"]);

function fail(field: string): never {
  throw new InspectionError(InspectionErrorCode.INVALID_DEPLOYMENT, { field });
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(field);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(field);
  return value;
}

function hex(value: unknown, field: string, pattern: RegExp): Hex {
  const result = string(value, field);
  if (!pattern.test(result) || BigInt(result) === 0n) fail(field);
  return result.toLowerCase() as Hex;
}

export function parseDeployment(value: unknown): SwaputerDeployment {
  const input = object(value, "$deployment");
  const expected = new Set([
    "schemaVersion", "id", "releaseName", "protocolVersion", "chainId", "networkName",
    "kernel", "kernelRuntimeCodeHash", "worldId", "sourceManifest", "sourceManifestHash"
  ]);
  for (const key of expected) if (!(key in input)) fail(key);
  for (const key of Object.keys(input)) if (!expected.has(key)) fail(key);
  if (input.schemaVersion !== "swaputer-cli-deployment/1") fail("schemaVersion");
  if (!Number.isSafeInteger(input.chainId) || Number(input.chainId) <= 0) fail("chainId");
  const id = string(input.id, "id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail("id");
  return Object.freeze({
    schemaVersion: "swaputer-cli-deployment/1",
    id,
    releaseName: string(input.releaseName, "releaseName"),
    protocolVersion: string(input.protocolVersion, "protocolVersion"),
    chainId: BigInt(Number(input.chainId)),
    networkName: string(input.networkName, "networkName"),
    kernel: hex(input.kernel, "kernel", ADDRESS),
    kernelRuntimeCodeHash: hex(input.kernelRuntimeCodeHash, "kernelRuntimeCodeHash", BYTES32),
    worldId: hex(input.worldId, "worldId", BYTES32),
    sourceManifest: string(input.sourceManifest, "sourceManifest"),
    sourceManifestHash: hex(input.sourceManifestHash, "sourceManifestHash", BYTES32)
  });
}

export async function loadDeployment(network: string): Promise<SwaputerDeployment> {
  if (!NETWORK_IDS.has(network)) throw new InspectionError(InspectionErrorCode.UNSUPPORTED_NETWORK, { network });
  try {
    const bytes = await readFile(resolve(DEPLOYMENTS_DIRECTORY, `${network}.json`), "utf8");
    const deployment = parseDeployment(JSON.parse(bytes) as unknown);
    if (deployment.id !== network) fail("id");
    return deployment;
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    throw new InspectionError(InspectionErrorCode.INVALID_DEPLOYMENT, { network }, error);
  }
}
