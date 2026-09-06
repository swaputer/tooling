import { hexToBytes, type Bytes32, type Hex } from "@swaputer/receipt-codec";
import { keccak_256 } from "@noble/hashes/sha3";

import type { Address } from "./types.js";

export const EVENT_ABI_FORMAT = "SwapVMEventABI" as const;
export const EVENT_ABI_DESCRIPTOR_VERSION = 1 as const;
export const EVENT_DECODER_VERSION = 1 as const;

export const EventAbiErrorCode = {
  INVALID_DESCRIPTOR_SHAPE: "INVALID_DESCRIPTOR_SHAPE",
  UNSUPPORTED_DESCRIPTOR_VERSION: "UNSUPPORTED_DESCRIPTOR_VERSION",
  INVALID_DESCRIPTOR_METADATA: "INVALID_DESCRIPTOR_METADATA",
  INVALID_CODE_HASH: "INVALID_CODE_HASH",
  INVALID_EVENT_SIGNATURE: "INVALID_EVENT_SIGNATURE",
  EVENT_TOPIC_MISMATCH: "EVENT_TOPIC_MISMATCH",
  DUPLICATE_EVENT: "DUPLICATE_EVENT",
  INVALID_FIELD: "INVALID_FIELD",
  UNSUPPORTED_FIELD_TYPE: "UNSUPPORTED_FIELD_TYPE",
  LAYOUT_MISMATCH: "LAYOUT_MISMATCH",
  EVENT_TOPIC_COUNT_MISMATCH: "EVENT_TOPIC_COUNT_MISMATCH",
  EVENT_DATA_LENGTH_MISMATCH: "EVENT_DATA_LENGTH_MISMATCH",
  BOOL_NON_CANONICAL: "BOOL_NON_CANONICAL",
  ADDRESS_NON_CANONICAL: "ADDRESS_NON_CANONICAL",
  DEPLOYMENT_AMBIGUOUS: "DEPLOYMENT_AMBIGUOUS",
  REGISTRY_AMBIGUOUS: "REGISTRY_AMBIGUOUS"
} as const;

export type EventAbiErrorCode = (typeof EventAbiErrorCode)[keyof typeof EventAbiErrorCode];
export type EventFieldType = "uint256" | "int256" | "bool" | "bytes32" | "account" | "address";
export type AccountKind = "zero" | "EOA" | "contract" | "Kernel" | "unknown-tag";

export class EventAbiError extends Error {
  readonly code: EventAbiErrorCode;
  readonly details: Readonly<Record<string, string | number | bigint | boolean>>;

  constructor(code: EventAbiErrorCode, details: Readonly<Record<string, string | number | bigint | boolean>> = {}) {
    super(code);
    this.name = "EventAbiError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isEventAbiError(error: unknown): error is EventAbiError {
  return error instanceof EventAbiError;
}

export interface EventFieldDescriptorV1 {
  readonly name: string;
  readonly type: EventFieldType;
  readonly indexed: boolean;
  readonly position: number;
}

export interface EventDescriptorV1 {
  readonly name: string;
  readonly signature: string;
  readonly topic0: Bytes32;
  readonly fields: readonly EventFieldDescriptorV1[];
}

export interface SwapVMEventABIV1 {
  readonly format: typeof EVENT_ABI_FORMAT;
  readonly descriptorVersion: typeof EVENT_ABI_DESCRIPTOR_VERSION;
  readonly codeHash: Bytes32;
  readonly standard: string;
  readonly version: number;
  readonly interfaceId?: `0x${string}`;
  readonly artifactAbiHash?: Bytes32;
  readonly events: readonly EventDescriptorV1[];
}

export interface DecodedEventField {
  readonly index: number;
  readonly name: string;
  readonly type: EventFieldType;
  readonly indexed: boolean;
  readonly position: number;
  readonly raw: Bytes32;
  readonly value: bigint | boolean | Bytes32 | Address;
  readonly normalized: string;
  readonly accountKind?: AccountKind;
}

export interface DecodedApplicationEvent {
  readonly name: string;
  readonly signature: string;
  readonly topic0: Bytes32;
  readonly fields: readonly DecodedEventField[];
}

const FIELD_TYPES = new Set<EventFieldType>(["uint256", "int256", "bool", "bytes32", "account", "address"]);
const KERNEL_ACCOUNT = "0xff00000000000000000000000000000000000000000000000000000000000001";

function fail(code: EventAbiErrorCode, details: Readonly<Record<string, string | number | bigint | boolean>> = {}): never {
  throw new EventAbiError(code, details);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(EventAbiErrorCode.INVALID_DESCRIPTOR_SHAPE);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail(EventAbiErrorCode.INVALID_DESCRIPTOR_SHAPE);
  }
}

function bytes32(value: unknown, code: EventAbiErrorCode): Bytes32 {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail(code);
  return value.toLowerCase() as Bytes32;
}

function hashUtf8(value: string): Bytes32 {
  return `0x${Buffer.from(keccak_256(new TextEncoder().encode(value))).toString("hex")}` as Bytes32;
}

function abiType(type: EventFieldType): string {
  return type === "account" ? "bytes32" : type;
}

function freezeDescriptor(descriptor: SwapVMEventABIV1): SwapVMEventABIV1 {
  for (const event of descriptor.events) {
    Object.freeze(event.fields);
    Object.freeze(event);
  }
  Object.freeze(descriptor.events);
  return Object.freeze(descriptor);
}

export function normalizeEventAbiDescriptor(input: unknown): SwapVMEventABIV1 {
  const source = record(input);
  exactKeys(
    source,
    ["format", "descriptorVersion", "codeHash", "standard", "version", "events"],
    ["interfaceId", "artifactAbiHash"]
  );
  if (source.format !== EVENT_ABI_FORMAT) fail(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
  if (source.descriptorVersion !== EVENT_ABI_DESCRIPTOR_VERSION) {
    fail(EventAbiErrorCode.UNSUPPORTED_DESCRIPTOR_VERSION);
  }
  const codeHash = bytes32(source.codeHash, EventAbiErrorCode.INVALID_CODE_HASH);
  if (typeof source.standard !== "string" || source.standard.length === 0 || source.standard.length > 128) {
    fail(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
  }
  if (!Number.isSafeInteger(source.version) || Number(source.version) <= 0) {
    fail(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
  }
  const interfaceId = source.interfaceId;
  if (interfaceId !== undefined && (typeof interfaceId !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(interfaceId))) {
    fail(EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
  }
  const artifactAbiHash = source.artifactAbiHash;
  const normalizedArtifactAbiHash =
    artifactAbiHash === undefined ? undefined : bytes32(artifactAbiHash, EventAbiErrorCode.INVALID_DESCRIPTOR_METADATA);
  if (!Array.isArray(source.events) || source.events.length === 0 || source.events.length > 256) {
    fail(EventAbiErrorCode.INVALID_DESCRIPTOR_SHAPE);
  }

  const topics = new Set<string>();
  const signatures = new Set<string>();
  const events = source.events.map((item): EventDescriptorV1 => {
    const event = record(item);
    exactKeys(event, ["name", "signature", "topic0", "fields"]);
    if (typeof event.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(event.name)) {
      fail(EventAbiErrorCode.INVALID_EVENT_SIGNATURE);
    }
    if (typeof event.signature !== "string") fail(EventAbiErrorCode.INVALID_EVENT_SIGNATURE);
    const signature = event.signature;
    const match = signature.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
    if (match === null || match[1] !== event.name) fail(EventAbiErrorCode.INVALID_EVENT_SIGNATURE);
    if (!Array.isArray(event.fields)) fail(EventAbiErrorCode.INVALID_FIELD);
    const names = new Set<string>();
    const fields = event.fields.map((itemField): EventFieldDescriptorV1 => {
      const field = record(itemField);
      exactKeys(field, ["name", "type", "indexed", "position"]);
      if (typeof field.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) || names.has(field.name)) {
        fail(EventAbiErrorCode.INVALID_FIELD);
      }
      names.add(field.name);
      if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type as EventFieldType)) {
        fail(EventAbiErrorCode.UNSUPPORTED_FIELD_TYPE);
      }
      if (typeof field.indexed !== "boolean" || !Number.isSafeInteger(field.position) || Number(field.position) < 0) {
        fail(EventAbiErrorCode.INVALID_FIELD);
      }
      return Object.freeze({
        name: field.name,
        type: field.type as EventFieldType,
        indexed: field.indexed,
        position: Number(field.position)
      });
    });
    const signatureTypes = match[2] === "" ? [] : match[2]?.split(",");
    if (signatureTypes === undefined || signatureTypes.length !== fields.length) fail(EventAbiErrorCode.LAYOUT_MISMATCH);
    if (fields.some((field, index) => signatureTypes[index] !== abiType(field.type))) {
      fail(EventAbiErrorCode.LAYOUT_MISMATCH);
    }
    const indexedPositions = fields.filter((field) => field.indexed).map((field) => field.position).sort((a, b) => a - b);
    const dataPositions = fields.filter((field) => !field.indexed).map((field) => field.position).sort((a, b) => a - b);
    if (
      indexedPositions.length > 3 ||
      indexedPositions.some((position, index) => position !== index + 1) ||
      dataPositions.some((position, index) => position !== index)
    ) {
      fail(EventAbiErrorCode.LAYOUT_MISMATCH);
    }
    const topic0 = bytes32(event.topic0, EventAbiErrorCode.EVENT_TOPIC_MISMATCH);
    if (topic0 !== hashUtf8(signature)) fail(EventAbiErrorCode.EVENT_TOPIC_MISMATCH);
    if (topics.has(topic0) || signatures.has(signature)) fail(EventAbiErrorCode.DUPLICATE_EVENT);
    topics.add(topic0);
    signatures.add(signature);
    return Object.freeze({ name: event.name, signature, topic0, fields: Object.freeze(fields) });
  });

  const normalized: SwapVMEventABIV1 = {
    format: EVENT_ABI_FORMAT,
    descriptorVersion: EVENT_ABI_DESCRIPTOR_VERSION,
    codeHash,
    standard: source.standard,
    version: Number(source.version),
    ...(interfaceId === undefined ? {} : { interfaceId: interfaceId.toLowerCase() as `0x${string}` }),
    ...(normalizedArtifactAbiHash === undefined ? {} : { artifactAbiHash: normalizedArtifactAbiHash }),
    events: Object.freeze(events)
  };
  return freezeDescriptor(normalized);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail(EventAbiErrorCode.INVALID_DESCRIPTOR_SHAPE);
  return encoded;
}

export function canonicalDescriptorJson(descriptor: SwapVMEventABIV1 | unknown): string {
  return canonicalJson(normalizeEventAbiDescriptor(descriptor));
}

export function eventAbiDescriptorHash(descriptor: SwapVMEventABIV1 | unknown): Bytes32 {
  return hashUtf8(canonicalDescriptorJson(descriptor));
}

function wordBigInt(word: Bytes32): bigint {
  return BigInt(word);
}

export function classifyAccount(value: Bytes32): AccountKind {
  if (value === `0x${"00".repeat(32)}`) return "zero";
  if (value === KERNEL_ACCOUNT) return "Kernel";
  const bytes = hexToBytes(value);
  if (bytes[0] === 0x01) return "contract";
  if (bytes.subarray(0, 12).every((byte) => byte === 0)) return "EOA";
  return "unknown-tag";
}

function decodeField(field: EventFieldDescriptorV1, raw: Bytes32, index: number): DecodedEventField {
  const unsigned = wordBigInt(raw);
  const base = { index, name: field.name, type: field.type, indexed: field.indexed, position: field.position, raw };
  if (field.type === "uint256") return Object.freeze({ ...base, value: unsigned, normalized: unsigned.toString(10) });
  if (field.type === "int256") {
    const signed = unsigned >= 1n << 255n ? unsigned - (1n << 256n) : unsigned;
    return Object.freeze({ ...base, value: signed, normalized: signed.toString(10) });
  }
  if (field.type === "bool") {
    if (unsigned > 1n) fail(EventAbiErrorCode.BOOL_NON_CANONICAL, { field: field.name });
    const value = unsigned === 1n;
    return Object.freeze({ ...base, value, normalized: value ? "true" : "false" });
  }
  if (field.type === "address") {
    const bytes = hexToBytes(raw);
    if (!bytes.subarray(0, 12).every((byte) => byte === 0)) {
      fail(EventAbiErrorCode.ADDRESS_NON_CANONICAL, { field: field.name });
    }
    const value = `0x${Buffer.from(bytes.subarray(12)).toString("hex")}` as Address;
    return Object.freeze({ ...base, value, normalized: value });
  }
  if (field.type === "account") {
    return Object.freeze({ ...base, value: raw, normalized: raw, accountKind: classifyAccount(raw) });
  }
  return Object.freeze({ ...base, value: raw, normalized: raw });
}

export function decodeApplicationEvent(
  descriptorInput: SwapVMEventABIV1 | unknown,
  recordInput: { readonly topics: readonly Bytes32[]; readonly data: Hex }
): DecodedApplicationEvent | null {
  const descriptor = normalizeEventAbiDescriptor(descriptorInput);
  const topic0 = recordInput.topics[0];
  if (topic0 === undefined) return null;
  const event = descriptor.events.find((candidate) => candidate.topic0 === topic0.toLowerCase());
  if (event === undefined) return null;
  const indexedCount = event.fields.filter((field) => field.indexed).length;
  const dataCount = event.fields.length - indexedCount;
  if (recordInput.topics.length !== indexedCount + 1) {
    fail(EventAbiErrorCode.EVENT_TOPIC_COUNT_MISMATCH, {
      actual: recordInput.topics.length,
      expected: indexedCount + 1
    });
  }
  if (!/^0x(?:[0-9a-fA-F]{64})*$/.test(recordInput.data) || (recordInput.data.length - 2) / 2 !== dataCount * 32) {
    fail(EventAbiErrorCode.EVENT_DATA_LENGTH_MISMATCH, {
      actual: (recordInput.data.length - 2) / 2,
      expected: dataCount * 32
    });
  }
  const dataWords = Array.from({ length: dataCount }, (_value, index) =>
    `0x${recordInput.data.slice(2 + index * 64, 2 + (index + 1) * 64).toLowerCase()}` as Bytes32
  );
  const decoded = event.fields.map((field, index) => {
    const raw = field.indexed ? recordInput.topics[field.position] : dataWords[field.position];
    if (raw === undefined) fail(EventAbiErrorCode.LAYOUT_MISMATCH, { field: field.name });
    return decodeField(field, raw.toLowerCase() as Bytes32, index);
  });
  return Object.freeze({ name: event.name, signature: event.signature, topic0: event.topic0, fields: Object.freeze(decoded) });
}
