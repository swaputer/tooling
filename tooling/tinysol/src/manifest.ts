import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalJson } from "./abi.js";
import { bytesToHex, normalizeBytes32, type Bytes32 } from "./bytes.js";
import { ISA_FILE_KECCAK, ISA_FILE_SHA256, ISA_VERSION } from "./isa.js";
import { encodeProgramPackage, programPackageCodeHash, type ProgramPackageV1 } from "./package.js";

export const TOOLCHAIN_NAME = "@swaputer/tinysol" as const;
export const TOOLCHAIN_VERSION = "0.1.0" as const;
export const BUILD_MANIFEST_FORMAT = "SwapVMToolchainManifest" as const;
export const BUILD_MANIFEST_VERSION = 1 as const;

export interface BuildManifestV1 {
  readonly format: typeof BUILD_MANIFEST_FORMAT;
  readonly manifestVersion: typeof BUILD_MANIFEST_VERSION;
  readonly consensusEncoding: false;
  readonly toolchain: Readonly<{ name: typeof TOOLCHAIN_NAME; version: typeof TOOLCHAIN_VERSION }>;
  readonly mode: "assembler";
  readonly isa: Readonly<{ version: typeof ISA_VERSION; keccak256: typeof ISA_FILE_KECCAK; sha256: typeof ISA_FILE_SHA256 }>;
  readonly codeHash: Bytes32;
  readonly packageHash: Bytes32;
  readonly abiHash: Bytes32;
  readonly descriptorHash?: Bytes32;
  readonly constructorEntry: number;
  readonly runtimeEntry: number;
  readonly codeLength: number;
  readonly sourceSha256: string;
  readonly sourceKeccak256: Bytes32;
}

export function buildManifest(
  packageValue: ProgramPackageV1,
  source: string | Uint8Array,
  descriptorHash?: string
): BuildManifestV1 {
  const sourceBytes = typeof source === "string" ? new TextEncoder().encode(source) : new Uint8Array(source);
  const packageBytes = encodeProgramPackage(packageValue);
  const packageHash = programPackageCodeHash(packageBytes);
  const base = {
    format: BUILD_MANIFEST_FORMAT,
    manifestVersion: BUILD_MANIFEST_VERSION,
    consensusEncoding: false as const,
    toolchain: Object.freeze({ name: TOOLCHAIN_NAME, version: TOOLCHAIN_VERSION }),
    mode: "assembler" as const,
    isa: Object.freeze({ version: ISA_VERSION, keccak256: ISA_FILE_KECCAK, sha256: ISA_FILE_SHA256 }),
    codeHash: packageHash,
    packageHash,
    abiHash: packageValue.abiHash,
    constructorEntry: packageValue.constructorEntry,
    runtimeEntry: packageValue.runtimeEntry,
    codeLength: packageValue.codeLength,
    sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    sourceKeccak256: bytesToHex(keccak_256(sourceBytes)) as Bytes32
  };
  return Object.freeze(descriptorHash === undefined ? base : { ...base, descriptorHash: normalizeBytes32(descriptorHash) });
}

export function encodeBuildManifest(manifest: BuildManifestV1): string {
  return `${canonicalJson(manifest)}\n`;
}
