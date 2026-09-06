#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { canonicalJson, parseStrictJson } from "./canonical.js";
import { ManifestError } from "./errors.js";
import { finalizeManifest, validateManifest, verifyObservation } from "./manifest.js";
import type { DeploymentManifest } from "./types.js";
import type { DeploymentObservation } from "./types.js";

async function main(): Promise<void> {
  const [command, manifestPath, observationPath] = process.argv.slice(2);
  if ((command !== "canonicalize" && command !== "finalize" && command !== "verify") || manifestPath === undefined) throw new ManifestError("INVALID_TYPE", "$", "usage: swaputer-manifest <canonicalize|finalize|verify> MANIFEST [OBSERVATION]");
  const input = parseStrictJson(await readFile(manifestPath, "utf8"));
  const manifest = command === "finalize" ? finalizeManifest(input as DeploymentManifest) : validateManifest(input);
  if (command === "verify" && observationPath !== undefined) verifyObservation(manifest, parseStrictJson(await readFile(observationPath, "utf8")) as DeploymentObservation);
  if (command === "canonicalize" || command === "finalize") process.stdout.write(`${canonicalJson(manifest)}\n`);
  else process.stdout.write(`${canonicalJson({ manifestHash: manifest.integrity.manifestHash, signatureVerified: manifest.integrity.signature !== null, status: "verified", worldConfigHash: manifest.worldConfigHash, worldId: manifest.world.worldId })}\n`);
}

main().catch((cause: unknown) => { const error = cause instanceof ManifestError ? cause.toJSON() : { code: "UNEXPECTED", path: "$", message: cause instanceof Error ? cause.message : String(cause) }; process.stderr.write(`${canonicalJson({ error })}\n`); process.exitCode = 1; });
