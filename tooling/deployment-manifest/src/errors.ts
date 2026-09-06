export type ManifestErrorCode =
  | "INVALID_JSON"
  | "INVALID_TYPE"
  | "MISSING_FIELD"
  | "UNSUPPORTED_SCHEMA"
  | "INVALID_HEX"
  | "INVALID_INTEGER"
  | "FORBIDDEN_FIELD"
  | "WORLD_ID_MISMATCH"
  | "CONFIG_HASH_MISMATCH"
  | "MANIFEST_HASH_MISMATCH"
  | "SIGNATURE_INVALID"
  | "OBSERVATION_MISMATCH";

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;
  readonly path: string;

  constructor(code: ManifestErrorCode, path: string, message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
    this.path = path;
  }

  toJSON(): Readonly<{ code: ManifestErrorCode; path: string; message: string }> {
    return Object.freeze({ code: this.code, path: this.path, message: this.message });
  }
}
