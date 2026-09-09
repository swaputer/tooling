import activeRelease from "../../../../tooling/cli/deployments/base-sepolia.json";

export interface SwaputerDeployment {
  readonly chainId: bigint;
  readonly chainIdHex: `0x${string}`;
  readonly networkName: string;
  readonly protocolVersion: string;
  readonly kernel: `0x${string}`;
  readonly kernelRuntimeCodeHash: `0x${string}`;
  readonly worldId: `0x${string}`;
  readonly explorerTransactionBaseUrl: string;
  readonly rpcUrls: readonly string[];
}

export const BASE_SEPOLIA_DEPLOYMENT: SwaputerDeployment = Object.freeze({
  chainId: BigInt(activeRelease.chainId),
  chainIdHex: `0x${activeRelease.chainId.toString(16)}`,
  networkName: activeRelease.networkName,
  protocolVersion: activeRelease.protocolVersion,
  kernel: activeRelease.kernel.toLowerCase() as `0x${string}`,
  kernelRuntimeCodeHash: activeRelease.kernelRuntimeCodeHash.toLowerCase() as `0x${string}`,
  worldId: activeRelease.worldId.toLowerCase() as `0x${string}`,
  explorerTransactionBaseUrl: "https://sepolia.basescan.org/tx/",
  rpcUrls: Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"])
});

export const DEPLOYMENTS: readonly SwaputerDeployment[] = Object.freeze([BASE_SEPOLIA_DEPLOYMENT]);
