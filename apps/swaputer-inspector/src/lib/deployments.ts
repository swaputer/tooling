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
  chainId: 84532n,
  chainIdHex: "0x14a34",
  networkName: "Base Sepolia",
  protocolVersion: "1.2",
  kernel: "0xa751daffd61c2d259414573efcd743cfb24ed10b",
  kernelRuntimeCodeHash: "0xd05ae5fdaecc573384b216fc370df83091e7a305579f0e200ca3ef80bd62243d",
  worldId: "0x20f614ee9d36602f82422765fa005cedcb6c042fe7fbf5b368124820a829f757",
  explorerTransactionBaseUrl: "https://sepolia.basescan.org/tx/",
  rpcUrls: Object.freeze(["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"])
});

export const DEPLOYMENTS: readonly SwaputerDeployment[] = Object.freeze([BASE_SEPOLIA_DEPLOYMENT]);
