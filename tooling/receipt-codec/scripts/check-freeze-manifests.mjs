import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3";

const here = dirname(fileURLToPath(import.meta.url));
const specRoot = resolve(here, "../../../docs/spec");
const manifests = [
  "SwapVM-v1.2-freeze-manifest.json",
  "SwapVM-v1.1-freeze-manifest.json",
  "SwapVM-v1.0-freeze-manifest.json"
];

for (const manifestName of manifests) {
  const manifest = JSON.parse(await readFile(resolve(specRoot, manifestName), "utf8"));
  for (const key of ["specification", "isa"]) {
    const entry = manifest[key];
    if (typeof entry?.file !== "string" || typeof entry?.sha256 !== "string" || typeof entry?.keccak256 !== "string") {
      throw new Error(`${manifestName}: malformed ${key} entry`);
    }
    const data = await readFile(resolve(specRoot, entry.file));
    const sha256 = createHash("sha256").update(data).digest("hex");
    const keccak256 = `0x${Buffer.from(keccak_256(data)).toString("hex")}`;
    if (sha256 !== entry.sha256) throw new Error(`${manifestName}: ${entry.file} SHA-256 mismatch`);
    if (keccak256 !== entry.keccak256) throw new Error(`${manifestName}: ${entry.file} Keccak-256 mismatch`);
    process.stdout.write(`${manifest.version} ${entry.file}: verified\n`);
  }
}
