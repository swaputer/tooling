import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalJson, eventTopic, exactUtf8AbiHash, functionSelector } from "./abi.js";
import { bytesToHex, type Bytes32 } from "./bytes.js";
import { tinySolAbiType, tinySolSignature } from "./semantic.js";
import type { TinySolAbi, TinySolEventAbi, TinySolProgram, TinySolStorageLayout } from "./compiler-types.js";

function hashText(value: string): Bytes32 { return bytesToHex(keccak_256(new TextEncoder().encode(value))) as Bytes32; }
function word(value: bigint): Bytes32 { return `0x${value.toString(16).padStart(64, "0")}` as Bytes32; }

export function buildTinySolAbi(program: TinySolProgram): TinySolAbi {
  const contract = program.contract;
  const functions = contract.functions.filter((fn) => fn.visibility === "external").map((fn) => {
    const inputs = Object.freeze(fn.parameters.map((parameter) => parameter.type.name));
    const outputs = Object.freeze(fn.returns.map((item) => item.name));
    const signature = tinySolSignature(fn.name, inputs);
    return Object.freeze({ name: fn.name, signature, selector: functionSelector(signature), inputs, outputs, view: fn.view });
  });
  const constructor = tinySolSignature("constructor", contract.constructor?.kind === "ConstructorDeclaration" ? contract.constructor.parameters.map((parameter) => parameter.type.name) : []);
  const events = Object.freeze(contract.events.map((event) => tinySolSignature(event.name, event.parameters.map((parameter) => parameter.type.name))));
  const canonicalObject = { format: "TinySolABI", version: 1, contract: contract.name, constructor, functions, events };
  const abiCanonical = canonicalJson(canonicalObject);
  return Object.freeze({ ...canonicalObject, format: "TinySolABI" as const, version: 1 as const, functions: Object.freeze(functions), events, abiCanonical, abiHash: exactUtf8AbiHash(abiCanonical) });
}

export function buildStorageLayout(program: TinySolProgram): TinySolStorageLayout {
  const items = program.contract.stateVariables.map((state, declarationIndex) => {
    if (state.type.kind === "ScalarType") return Object.freeze({ name: state.name, type: state.type.name, declarationIndex, slot: word(BigInt(declarationIndex)) });
    const domain = hashText(`TinySol.storage.mapping.v1:${program.contract.name}:${state.name}:${declarationIndex}`);
    return Object.freeze({ name: state.name, type: `mapping(${state.type.keyType.name}=>${state.type.valueType.name})`, declarationIndex, namespace: domain, keyType: state.type.keyType.name, valueType: state.type.valueType.name });
  });
  const base = { format: "TinySolStorageLayout" as const, version: 1 as const, contract: program.contract.name, scalarPacking: "none" as const, mappingScheme: "keccak256(domain,key)" as const, items: Object.freeze(items) };
  return Object.freeze({ ...base, hash: hashText(canonicalJson(base)) });
}

export function buildEventDescriptor(program: TinySolProgram, abi: TinySolAbi, codeHash: Bytes32): TinySolEventAbi {
  const events = program.contract.events.map((event) => {
    const signature = tinySolSignature(event.name, event.parameters.map((field) => field.type.name));
    let indexedPosition = 1; let dataPosition = 0;
    const fields = event.parameters.map((field) => Object.freeze({
      name: field.name,
      type: field.type.name,
      indexed: field.indexed,
      position: field.indexed ? indexedPosition++ : dataPosition++
    }));
    return Object.freeze({ name: event.name, signature, topic0: eventTopic(signature), fields: Object.freeze(fields) });
  });
  return Object.freeze({ format: "SwapVMEventABI", descriptorVersion: 1, codeHash, standard: program.contract.name, version: 1, artifactAbiHash: abi.abiHash, events: Object.freeze(events) });
}

export function eventDescriptorHash(descriptor: TinySolEventAbi): Bytes32 { return hashText(canonicalJson(descriptor)); }
export function sourceHash(source: string): Bytes32 { return hashText(source.replace(/\r\n?/g, "\n")); }
