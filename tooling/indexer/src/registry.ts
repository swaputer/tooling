import type { SqliteDatabase } from "./database.js";
import {
  EventAbiError,
  EventAbiErrorCode,
  canonicalDescriptorJson,
  eventAbiDescriptorHash,
  normalizeEventAbiDescriptor,
  type SwapVMEventABIV1
} from "./event-abi.js";
import { GENERATED_REFERENCE_REGISTRY } from "./generated-reference-registry.js";

export type RegistryTrustLevel = "verified_reference" | "declared_unverified";

export interface AbiRegistryEntry {
  readonly registryId: bigint;
  readonly codeHash: string;
  readonly artifactAbiHash: string | null;
  readonly descriptorHash: string;
  readonly interfaceId: string | null;
  readonly standard: string;
  readonly version: bigint;
  readonly trustLevel: RegistryTrustLevel;
  readonly descriptorJson: string;
  readonly artifactSource: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
}

interface RegistryRow {
  readonly registry_id: bigint;
  readonly code_hash: string;
  readonly artifact_abi_hash: string | null;
  readonly descriptor_hash: string;
  readonly interface_id: string | null;
  readonly standard: string;
  readonly version: bigint;
  readonly trust_level: RegistryTrustLevel;
  readonly descriptor_json: string;
  readonly artifact_source: string | null;
  readonly enabled: bigint;
  readonly created_at: string;
}

function publicEntry(row: RegistryRow): AbiRegistryEntry {
  return Object.freeze({
    registryId: row.registry_id,
    codeHash: row.code_hash,
    artifactAbiHash: row.artifact_abi_hash,
    descriptorHash: row.descriptor_hash,
    interfaceId: row.interface_id,
    standard: row.standard,
    version: row.version,
    trustLevel: row.trust_level,
    descriptorJson: row.descriptor_json,
    artifactSource: row.artifact_source,
    enabled: row.enabled === 1n,
    createdAt: row.created_at
  });
}

export function referenceEventAbis(): readonly SwapVMEventABIV1[] {
  return Object.freeze(GENERATED_REFERENCE_REGISTRY.map((entry) => normalizeEventAbiDescriptor(entry.descriptor)));
}

export function installVerifiedReferenceRegistry(database: SqliteDatabase, now = new Date().toISOString()): void {
  const insert = database.prepare(
    `INSERT OR IGNORE INTO abi_registry(
       code_hash, artifact_abi_hash, descriptor_hash, interface_id, standard, version,
       trust_level, descriptor_json, artifact_source, enabled, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'verified_reference', ?, ?, 1, ?)`
  );
  database.transaction(() => {
    for (const generated of GENERATED_REFERENCE_REGISTRY) {
      const descriptor = normalizeEventAbiDescriptor(generated.descriptor);
      const descriptorJson = canonicalDescriptorJson(descriptor);
      const descriptorHash = eventAbiDescriptorHash(descriptor);
      if (descriptorJson !== generated.descriptorJson || descriptorHash !== generated.descriptorHash) {
        throw new EventAbiError(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
      }
      insert.run(
        descriptor.codeHash,
        descriptor.artifactAbiHash ?? null,
        descriptorHash,
        descriptor.interfaceId ?? null,
        descriptor.standard,
        BigInt(descriptor.version),
        descriptorJson,
        generated.artifactSource,
        now
      );
    }
  }).immediate();
}

export function registerDeclaredEventAbi(
  database: SqliteDatabase,
  input: unknown,
  options: { readonly source?: string; readonly now?: string } = {}
): AbiRegistryEntry {
  const descriptor = normalizeEventAbiDescriptor(input);
  const descriptorJson = canonicalDescriptorJson(descriptor);
  const descriptorHash = eventAbiDescriptorHash(descriptor);
  const now = options.now ?? new Date().toISOString();
  database
    .prepare(
      `INSERT OR IGNORE INTO abi_registry(
         code_hash, artifact_abi_hash, descriptor_hash, interface_id, standard, version,
         trust_level, descriptor_json, artifact_source, enabled, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'declared_unverified', ?, ?, 1, ?)`
    )
    .run(
      descriptor.codeHash,
      descriptor.artifactAbiHash ?? null,
      descriptorHash,
      descriptor.interfaceId ?? null,
      descriptor.standard,
      BigInt(descriptor.version),
      descriptorJson,
      options.source ?? null,
      now
    );
  const row = database
    .prepare(
      `SELECT * FROM abi_registry
        WHERE code_hash = ? AND descriptor_hash = ? AND trust_level = 'declared_unverified'`
    )
    .get(descriptor.codeHash, descriptorHash) as RegistryRow | undefined;
  if (row === undefined) throw new EventAbiError(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
  return publicEntry(row);
}

export function disableAbiRegistry(database: SqliteDatabase, registryId: bigint): boolean {
  return database.prepare("UPDATE abi_registry SET enabled = 0 WHERE registry_id = ? AND enabled = 1").run(registryId).changes === 1;
}

export function listAbiRegistry(database: SqliteDatabase): readonly AbiRegistryEntry[] {
  const rows = database.prepare("SELECT * FROM abi_registry ORDER BY registry_id").all() as RegistryRow[];
  return Object.freeze(rows.map(publicEntry));
}

export function verifyInstalledReferenceRegistry(database: SqliteDatabase): Readonly<{ verified: number }> {
  for (const generated of GENERATED_REFERENCE_REGISTRY) {
    const row = database
      .prepare(
        `SELECT * FROM abi_registry
          WHERE code_hash = ? AND descriptor_hash = ? AND trust_level = 'verified_reference'`
      )
      .get(generated.descriptor.codeHash, generated.descriptorHash) as RegistryRow | undefined;
    if (
      row === undefined ||
      row.descriptor_json !== generated.descriptorJson ||
      row.artifact_source !== generated.artifactSource ||
      row.artifact_abi_hash !== generated.descriptor.artifactAbiHash ||
      row.interface_id !== generated.descriptor.interfaceId
    ) {
      throw new EventAbiError(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
    }
    const descriptor = normalizeEventAbiDescriptor(JSON.parse(row.descriptor_json));
    if (eventAbiDescriptorHash(descriptor) !== row.descriptor_hash) {
      throw new EventAbiError(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
    }
  }
  return Object.freeze({ verified: GENERATED_REFERENCE_REGISTRY.length });
}
