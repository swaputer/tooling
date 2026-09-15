import mainnetRelease from "../../../../tooling/cli/deployments/ethereum-mainnet.json";
import baseSepoliaRelease from "../../../../tooling/cli/deployments/base-sepolia.json";

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

export const ETHEREUM_MAINNET_DEPLOYMENT: SwaputerDeployment = Object.freeze({
  chainId: BigInt(mainnetRelease.chainId),
  chainIdHex: `0x${mainnetRelease.chainId.toString(16)}`,
  networkName: mainnetRelease.networkName,
  protocolVersion: mainnetRelease.protocolVersion,
  kernel: mainnetRelease.kernel.toLowerCase() as `0x${string}`,
  kernelRuntimeCodeHash: mainnetRelease.kernelRuntimeCodeHash.toLowerCase() as `0x${string}`,
  worldId: mainnetRelease.worldId.toLowerCase() as `0x${string}`,
  explorerTransactionBaseUrl: "https://etherscan.io/tx/",
  rpcUrls: Object.freeze(["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"])
});

export const BASE_SEPOLIA_DEPLOYMENT: SwaputerDeployment = Object.freeze({
  chainId: BigInt(baseSepoliaRelease.chainId),
  chainIdHex: `0x${baseSepoliaRelease.chainId.toString(16)}`,
  networkName: baseSepoliaRelease.networkName,
  protocolVersion: baseSepoliaRelease.protocolVersion,
  kernel: baseSepoliaRelease.kernel.toLowerCase() as `0x${string}`,
  kernelRuntimeCodeHash: baseSepoliaRelease.kernelRuntimeCodeHash.toLowerCase() as `0x${string}`,
  worldId: baseSepoliaRelease.worldId.toLowerCase() as `0x${string}`,
  explorerTransactionBaseUrl: "https://sepolia.basescan.org/tx/",
  rpcUrls: Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"])
});

export const DEPLOYMENTS: readonly SwaputerDeployment[] = Object.freeze([ETHEREUM_MAINNET_DEPLOYMENT]);
