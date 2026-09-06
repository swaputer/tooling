import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes, normalizeBytes32, type Bytes32, type Hex } from "./bytes.js";
import { ToolchainError, ToolchainErrorCode } from "./errors.js";
import { instructionForOpcode } from "./isa.js";
import { decodeProgramPackage, programPackageCodeHash, type ProgramPackageV1 } from "./package.js";
import { validateCode } from "./validator.js";
import {
  MINIVM_LIMITS, MiniVMErrorCode, type MiniVMContextInput, type MiniVMDeployment, type MiniVMErrorCode as MiniVMErrorCodeType,
  type MiniVMFailure, type MiniVMRecord, type MiniVMSimulationResult, type MiniVMStorageDiff,
  type MiniVMStorageWrite, type MiniVMWorldState, type SimulateMiniVMInput, type SimulateMiniVMCodeInput
} from "./simulator-types.js";

const MOD = 1n << 256n;
const MASK = MOD - 1n;
const SIGN = 1n << 255n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const ZERO = `0x${"00".repeat(32)}` as Bytes32;
const KERNEL_EMITTER = `0xff${"00".repeat(30)}01` as Bytes32;
const DEPLOYED_TOPIC = bytesToHex(keccak_256(new TextEncoder().encode("MiniContractDeployed(bytes32,bytes32,bytes32)"))) as Bytes32;
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

interface MutableState {
  packages: Map<Bytes32, { bytes: Hex; package: ProgramPackageV1 }>;
  programs: Map<Bytes32, Bytes32>;
  storage: Map<Bytes32, Map<Bytes32, Bytes32>>;
  creatorNonces: Map<Bytes32, bigint>;
}
interface VMContext {
  worldId: Bytes32; addressId: Bytes32; caller: Bytes32; txActor: Bytes32; executionHeight: bigint;
  txRouter: bigint; txExecutor: bigint; txRecipient: bigint;
  ethAmountIn: bigint; grossTokenOut: bigint; tickAfter: number; liquidityAfter: bigint; byteGasPrice: bigint;
  chainBlockNumber: bigint; chainTimestamp: bigint;
}
interface Journal {
  used: number; writes: MiniVMStorageWrite[]; deployments: MiniVMDeployment[]; records: MiniVMRecord[]; encodedLength: number;
}
interface Frame {
  code: Uint8Array; input: Uint8Array; entry: number; byteLimit: number; staticMode: boolean; depth: number;
  ancestorMemory: number; context: VMContext;
}

class VMFault extends Error {
  constructor(
    readonly vmCode: MiniVMErrorCodeType, readonly used: number, readonly depth: number, readonly pc: number | null,
    readonly opcode: number | null, readonly faultData: Hex = "0x", readonly faultDetails: Readonly<Record<string, string | number | boolean>> = {}
  ) { super(vmCode); this.name = "VMFault"; }
}

function word(value: bigint): Bytes32 { return `0x${(value & MASK).toString(16).padStart(64, "0")}` as Bytes32; }
function bigintWord(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID, { details: { field } });
  const parsed = BigInt(value); if (parsed > MASK) throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID, { details: { field } }); return parsed;
}
function bounded(value: string, field: string, maximum: bigint): bigint { const parsed=bigintWord(value,field);if(parsed>maximum)throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID,{details:{field}});return parsed; }
function signed(value: bigint): bigint { const v = value & MASK; return v >= SIGN ? v - MOD : v; }
function unsigned(value: bigint): bigint { return value & MASK; }
function bytesWord(bytes: Uint8Array): bigint { let result = 0n; for (const byte of bytes) result = (result << 8n) | BigInt(byte); return result; }
function wordBytes(value: bigint): Uint8Array { return hexToBytes(word(value)); }
function bytes32(value: string, field: string): Bytes32 {
  try { return normalizeBytes32(value); }
  catch { throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID, { details: { field } }); }
}
function addressWord(value: string | undefined, field: string): bigint {
  if (value === undefined) return 0n;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID, { details: { field } });
  return BigInt(value);
}
function isContract(value: Bytes32): boolean { return value.slice(2, 4) === "01"; }
function isEoa(value: Bytes32): boolean { return value !== ZERO && value.slice(2,26) === "0".repeat(24); }
function cloneRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> { return { ...value }; }

function loadState(input: MiniVMWorldState): MutableState {
  const packages = new Map<Bytes32, { bytes: Hex; package: ProgramPackageV1 }>();
  const programs = new Map<Bytes32, Bytes32>(); const storage = new Map<Bytes32, Map<Bytes32, Bytes32>>(); const creatorNonces = new Map<Bytes32, bigint>();
  try {
    for (const [rawHash, rawPackage] of Object.entries(input.packages)) {
      const hash = bytes32(rawHash, "packages.codeHash"); const packageBytes = hexToBytes(rawPackage); const decoded = decodeProgramPackage(packageBytes);
      if (programPackageCodeHash(packageBytes) !== hash) throw new ToolchainError(ToolchainErrorCode.SIMULATION_STATE_INVALID, { details: { field: "packages.codeHash" } });
      packages.set(hash, { bytes: bytesToHex(packageBytes), package: decoded });
    }
    for (const [rawTarget, program] of Object.entries(input.programs)) {
      const target = bytes32(rawTarget, "programs.target"); const codeHash = bytes32(program.codeHash, "programs.codeHash");
      if (!isContract(target) || !packages.has(codeHash)) throw new ToolchainError(ToolchainErrorCode.SIMULATION_STATE_INVALID, { details: { field: "programs" } });
      programs.set(target, codeHash);
    }
    for (const [rawTarget, slots] of Object.entries(input.storage)) {
      const target = bytes32(rawTarget, "storage.target"); const values = new Map<Bytes32, Bytes32>();
      for (const [rawSlot, rawValue] of Object.entries(slots)) values.set(bytes32(rawSlot, "storage.slot"), bytes32(rawValue, "storage.value"));
      storage.set(target, values);
    }
    for (const [rawCreator, rawNonce] of Object.entries(input.creatorNonces)) {
      const creator = bytes32(rawCreator, "creatorNonces.creator"); const nonce = bigintWord(rawNonce, "creatorNonces.nonce");
      if (nonce > U64_MAX) throw new ToolchainError(ToolchainErrorCode.SIMULATION_STATE_INVALID, { details: { field: "creatorNonces.nonce" } });
      creatorNonces.set(creator, nonce);
    }
  } catch (error) {
    if (error instanceof ToolchainError && (error.code === ToolchainErrorCode.SIMULATION_INPUT_INVALID || error.code === ToolchainErrorCode.SIMULATION_STATE_INVALID)) throw error;
    throw new ToolchainError(ToolchainErrorCode.SIMULATION_STATE_INVALID);
  }
  return { packages, programs, storage, creatorNonces };
}

function exportState(state: MutableState): MiniVMWorldState {
  const packages: Record<string, Hex> = {}; const programs: Record<string, { codeHash: Bytes32 }> = {};
  const storage: Record<string, Record<string, Bytes32>> = {}; const creatorNonces: Record<string, string> = {};
  for (const key of [...state.packages.keys()].sort()) packages[key] = state.packages.get(key)!.bytes;
  for (const key of [...state.programs.keys()].sort()) programs[key] = Object.freeze({ codeHash: state.programs.get(key)! });
  for (const target of [...state.storage.keys()].sort()) { const slots: Record<string, Bytes32> = {}; for (const slot of [...state.storage.get(target)!.keys()].sort()) slots[slot] = state.storage.get(target)!.get(slot)!; storage[target] = Object.freeze(slots); }
  for (const key of [...state.creatorNonces.keys()].sort()) creatorNonces[key] = state.creatorNonces.get(key)!.toString();
  return Object.freeze({ packages: Object.freeze(packages), programs: Object.freeze(programs), storage: Object.freeze(storage), creatorNonces: Object.freeze(creatorNonces) });
}

function context(input: MiniVMContextInput, actor: Bytes32, target: Bytes32): VMContext {
  if (!Number.isInteger(input.buy.tickAfter) || input.buy.tickAfter < -8_388_608 || input.buy.tickAfter > 8_388_607) throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID, { details: { field: "context.buy.tickAfter" } });
  const executionHeight = bigintWord(input.executionHeight, "context.executionHeight"); const blockNumber = bigintWord(input.block.number, "context.block.number"); const timestamp = bigintWord(input.block.timestamp, "context.block.timestamp");
  if (executionHeight > U64_MAX || blockNumber > U64_MAX || timestamp > U64_MAX) throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID, { details: { field: "uint64-context" } });
  const byteGasPrice=bounded(input.byteGasPrice,"context.byteGasPrice",U128_MAX);if(byteGasPrice===0n)throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID,{details:{field:"context.byteGasPrice"}});
  return { worldId: bytes32(input.worldId, "context.worldId"), addressId: target, caller: actor, txActor: actor, executionHeight,
    txRouter: addressWord(input.tx?.router, "context.tx.router"), txExecutor: addressWord(input.tx?.executor, "context.tx.executor"), txRecipient: addressWord(input.tx?.recipient, "context.tx.recipient"),
    ethAmountIn: bounded(input.buy.ethAmountIn, "context.buy.ethAmountIn",U128_MAX), grossTokenOut: bounded(input.buy.grossTokenOut, "context.buy.grossTokenOut",U128_MAX), tickAfter: input.buy.tickAfter,
    liquidityAfter: bounded(input.buy.liquidityAfter, "context.buy.liquidityAfter",U128_MAX), byteGasPrice, chainBlockNumber: blockNumber, chainTimestamp: timestamp };
}

function fault(code: MiniVMErrorCodeType, journal: Journal, frame: Frame, pc: number | null, opcode: number | null, details: Readonly<Record<string, string | number | boolean>> = {}, data: Hex = "0x"): never {
  throw new VMFault(code, journal.used, frame.depth, pc, opcode, data, details);
}
function pop(stack: bigint[], journal: Journal, frame: Frame, pc: number, opcode: number): bigint { const value = stack.pop(); if (value === undefined) fault(MiniVMErrorCode.STACK_UNDERFLOW, journal, frame, pc, opcode); return value; }
function push(stack: bigint[], value: bigint, journal: Journal, frame: Frame, pc: number, opcode: number): void { if (stack.length === MINIVM_LIMITS.maxStackWords) fault(MiniVMErrorCode.STACK_OVERFLOW, journal, frame, pc, opcode); stack.push(unsigned(value)); }
function safeMemory(offsetWord: bigint, sizeWord: bigint, frame: Frame, journal: Journal, pc: number, opcode: number): { offset: number; size: number; end: number } {
  if (offsetWord > BigInt(MINIVM_LIMITS.maxMemoryBytes) || sizeWord > BigInt(MINIVM_LIMITS.maxMemoryBytes) - offsetWord) fault(MiniVMErrorCode.MEMORY_OUT_OF_BOUNDS, journal, frame, pc, opcode, { offset: offsetWord.toString(), size: sizeWord.toString() });
  const offset = Number(offsetWord); const size = Number(sizeWord); const end = offset + size;
  const total = frame.ancestorMemory + end; if (total > MINIVM_LIMITS.maxTotalMemoryBytes) fault(MiniVMErrorCode.TOTAL_MEMORY_OUT_OF_BOUNDS, journal, frame, pc, opcode, { total });
  return { offset, size, end };
}
function loadMemory(memory: Uint8Array, offset: number): bigint { return bytesWord(memory.slice(offset, offset + 32)); }
function storeMemory(memory: Uint8Array, offset: number, value: bigint): void { memory.set(wordBytes(value), offset); }
function powmod(base: bigint, exponent: bigint): bigint { let a = base & MASK; let b = exponent; let result = 1n; while (b > 0n) { if ((b & 1n) !== 0n) result = (result * a) & MASK; a = (a * a) & MASK; b >>= 1n; } return result; }
function binary(opcode: number, a: bigint, b: bigint): bigint {
  switch (opcode) {
    case 0x01: return a + b; case 0x02: return a * b; case 0x03: return a - b; case 0x04: return b === 0n ? 0n : a / b;
    case 0x05: { const sa = signed(a); const sb = signed(b); if (sb === 0n) return 0n; if (sa === -SIGN && sb === -1n) return SIGN; return unsigned(sa / sb); }
    case 0x06: return b === 0n ? 0n : a % b; case 0x07: { const sb = signed(b); return sb === 0n ? 0n : unsigned(signed(a) % sb); }
    case 0x0a: return powmod(a, b); case 0x10: return a < b ? 1n : 0n; case 0x11: return a > b ? 1n : 0n;
    case 0x12: return signed(a) < signed(b) ? 1n : 0n; case 0x13: return signed(a) > signed(b) ? 1n : 0n; case 0x14: return a === b ? 1n : 0n;
    case 0x16: return a & b; case 0x17: return a | b; case 0x18: return a ^ b;
    case 0x1a: return b >= 32n ? 0n : (a >> ((31n - b) * 8n)) & 0xffn;
    case 0x1b: return b >= 256n ? 0n : a << b; case 0x1c: return b >= 256n ? 0n : a >> b;
    case 0x1d: return b >= 256n ? (signed(a) < 0n ? MASK : 0n) : unsigned(signed(a) >> b);
    default: return 0n;
  }
}
function calldataWord(input: Uint8Array, offsetWord: bigint): bigint { if (offsetWord >= BigInt(input.length)) return 0n; const offset = Number(offsetWord); const slice = new Uint8Array(32); slice.set(input.slice(offset, offset + 32)); return bytesWord(slice); }
function journalLoad(state: MutableState, journal: Journal, target: Bytes32, slot: Bytes32): Bytes32 { for (let i = journal.writes.length - 1; i >= 0; i -= 1) { const item = journal.writes[i]!; if (item.target === target && item.slot === slot) return item.value; } return state.storage.get(target)?.get(slot) ?? ZERO; }
function journalStore(journal: Journal, target: Bytes32, slot: Bytes32, value: Bytes32): void { for (let i = journal.writes.length - 1; i >= 0; i -= 1) { const item = journal.writes[i]!; if (item.target === target && item.slot === slot) { journal.writes[i] = Object.freeze({ target, slot, value }); return; } } journal.writes.push(Object.freeze({ target, slot, value })); }
function nextNonce(state: MutableState, journal: Journal, creator: Bytes32): bigint { let nonce = state.creatorNonces.get(creator) ?? 0n; for (const item of journal.deployments) if (item.creator === creator && BigInt(item.nonceAfter) > nonce) nonce = BigInt(item.nonceAfter); return nonce; }
function deriveContractId(worldId: Bytes32, creator: Bytes32, nonce: bigint, codeHash: Bytes32): Bytes32 {
  const prefix = new TextEncoder().encode("SwapVM.CREATE.v1"); const nonceBytes = new Uint8Array(8); let n = nonce; for (let i = 7; i >= 0; i -= 1) { nonceBytes[i] = Number(n & 0xffn); n >>= 8n; }
  const hash = keccak_256(concatBytes(prefix, hexToBytes(worldId), hexToBytes(creator), nonceBytes, hexToBytes(codeHash))); const output=new Uint8Array(32);output[0]=1;output.set(hash.slice(0,31),1);return bytesToHex(output) as Bytes32;
}
function encodeU32(value: number): Uint8Array { return Uint8Array.of(value >>> 24, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff); }
function encodeRecord(record: MiniVMRecord): Uint8Array { const data = hexToBytes(record.data); const length = 32 + 1 + 32 * record.topics.length + 4 + data.length; return concatBytes(encodeU32(length), hexToBytes(record.emitter), Uint8Array.of(record.topics.length), ...record.topics.map(hexToBytes), encodeU32(data.length), data); }
function appendRecord(journal: Journal, frame: Frame, record: MiniVMRecord, pc: number, opcode: number): void {
  const dataLength = (record.data.length - 2) / 2; if (dataLength > MINIVM_LIMITS.maxRecordDataBytes) fault(MiniVMErrorCode.RECORD_DATA_TOO_LARGE, journal, frame, pc, opcode, { length: dataLength });
  if (journal.records.length === MINIVM_LIMITS.maxRecords) fault(MiniVMErrorCode.TOO_MANY_RECORDS, journal, frame, pc, opcode, { count: journal.records.length + 1 });
  const encoded = encodeRecord(record); if (4 + journal.encodedLength + encoded.length > MINIVM_LIMITS.maxReceiptPayloadBytes) fault(MiniVMErrorCode.RECEIPT_PAYLOAD_TOO_LARGE, journal, frame, pc, opcode, { length: 4 + journal.encodedLength + encoded.length });
  journal.records.push(Object.freeze({ emitter: record.emitter, topics: Object.freeze([...record.topics]), data: record.data })); journal.encodedLength += encoded.length;
}
function packageForTarget(state: MutableState, journal: Journal, target: Bytes32, frame: Frame): ProgramPackageV1 {
  let codeHash = state.programs.get(target); if (codeHash === undefined) for (let i = journal.deployments.length - 1; i >= 0; i -= 1) if (journal.deployments[i]!.contractId === target) { codeHash = journal.deployments[i]!.codeHash; break; }
  if (codeHash === undefined) fault(MiniVMErrorCode.PROGRAM_NOT_FOUND, journal, frame, null, null, { target }); const found = state.packages.get(codeHash); if (found === undefined) fault(MiniVMErrorCode.PACKAGE_NOT_REGISTERED, journal, frame, null, null, { codeHash }); return found.package;
}

function runFrame(state: MutableState, journal: Journal, frame: Frame): Uint8Array {
  if (frame.depth > MINIVM_LIMITS.maxCallDepth) fault(MiniVMErrorCode.CALL_DEPTH_EXCEEDED, journal, frame, null, null, { depth: frame.depth });
  if (!isContract(frame.context.addressId)) fault(MiniVMErrorCode.INVALID_CONTRACT_ACCOUNT, journal, frame, null, null, { target: frame.context.addressId });
  if (frame.byteLimit === 0 || frame.byteLimit > MINIVM_LIMITS.maxByteLimit) fault(MiniVMErrorCode.INVALID_BYTE_LIMIT, journal, frame, null, null, { limit: frame.byteLimit });
  let validation; try { validation = validateCode(frame.code); } catch (error) { if (error instanceof ToolchainError) fault(error.code === ToolchainErrorCode.EMPTY_CODE ? MiniVMErrorCode.EMPTY_CODE : error.code === ToolchainErrorCode.CODE_TOO_LARGE ? MiniVMErrorCode.CODE_TOO_LARGE : error.code === ToolchainErrorCode.TRUNCATED_IMMEDIATE ? MiniVMErrorCode.TRUNCATED_IMMEDIATE : MiniVMErrorCode.UNKNOWN_OPCODE, journal, frame, error.offset ?? null, null); throw error; }
  if (!validation.boundaries.has(frame.entry)) fault(MiniVMErrorCode.INVALID_ENTRYPOINT, journal, frame, frame.entry, null);
  const jumpdest = validation.jumpdestBitmap; const stack: bigint[] = []; const memory = new Uint8Array(MINIVM_LIMITS.maxMemoryBytes); let memorySize = 0; let returnData = new Uint8Array(); let pc = frame.entry;
  while (pc < frame.code.length) {
    const instructionPc = pc; const opcode = frame.code[pc]!; const definition = instructionForOpcode(opcode)!; const nextUsed = journal.used + definition.width;
    if (nextUsed > frame.byteLimit) { journal.used = nextUsed; fault(MiniVMErrorCode.OUT_OF_BYTE_GAS, journal, frame, instructionPc, opcode, { used: nextUsed, limit: frame.byteLimit }); }
    journal.used = nextUsed; pc += definition.width;
    if (opcode === 0x00) return new Uint8Array();
    if (opcode >= 0x60 && opcode <= 0x7f) { push(stack, bytesWord(frame.code.slice(instructionPc + 1, pc)), journal, frame, instructionPc, opcode); continue; }
    if (opcode === 0x5f) { push(stack, 0n, journal, frame, instructionPc, opcode); continue; }
    if (opcode >= 0x80 && opcode <= 0x8f) { const depth = opcode - 0x7f; if (stack.length < depth) fault(MiniVMErrorCode.STACK_UNDERFLOW, journal, frame, instructionPc, opcode); push(stack, stack[stack.length - depth]!, journal, frame, instructionPc, opcode); continue; }
    if (opcode >= 0x90 && opcode <= 0x9f) { const depth = opcode - 0x8f; if (stack.length <= depth) fault(MiniVMErrorCode.STACK_UNDERFLOW, journal, frame, instructionPc, opcode); const other = stack.length - 1 - depth; [stack[stack.length - 1], stack[other]] = [stack[other]!, stack[stack.length - 1]!]; continue; }
    if ([0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x0a,0x10,0x11,0x12,0x13,0x14,0x16,0x17,0x18,0x1a,0x1b,0x1c,0x1d].includes(opcode)) { const b = pop(stack,journal,frame,instructionPc,opcode); const a = pop(stack,journal,frame,instructionPc,opcode); push(stack,binary(opcode,a,b),journal,frame,instructionPc,opcode); continue; }
    if (opcode === 0x08 || opcode === 0x09) { const modulus=pop(stack,journal,frame,instructionPc,opcode), b=pop(stack,journal,frame,instructionPc,opcode), a=pop(stack,journal,frame,instructionPc,opcode); push(stack,modulus===0n?0n:(opcode===0x08?(a+b)%modulus:(a*b)%modulus),journal,frame,instructionPc,opcode); continue; }
    if (opcode === 0x15 || opcode === 0x19) { const value=pop(stack,journal,frame,instructionPc,opcode); push(stack,opcode===0x15?(value===0n?1n:0n):MASK^value,journal,frame,instructionPc,opcode); continue; }
    if (opcode === 0x20) { const offset=pop(stack,journal,frame,instructionPc,opcode), size=pop(stack,journal,frame,instructionPc,opcode); const region=safeMemory(offset,size,frame,journal,instructionPc,opcode); memorySize=Math.max(memorySize,region.end); push(stack,bytesWord(keccak_256(memory.slice(region.offset,region.end))),journal,frame,instructionPc,opcode); continue; }
    if (opcode === 0x21) { const s=pop(stack,journal,frame,instructionPc,opcode),r=pop(stack,journal,frame,instructionPc,opcode),v=pop(stack,journal,frame,instructionPc,opcode),hash=pop(stack,journal,frame,instructionPc,opcode); let recovered=0n; if ((v===27n||v===28n)&&s<=HALF_N&&s>0n&&r>0n) { try { const compact=concatBytes(wordBytes(r),wordBytes(s)); const key=secp256k1.Signature.fromCompact(compact).addRecoveryBit(Number(v-27n)).recoverPublicKey(wordBytes(hash)).toRawBytes(false); recovered=bytesWord(keccak_256(key.slice(1)).slice(12)); } catch {} } push(stack,recovered,journal,frame,instructionPc,opcode); continue; }
    if (opcode===0x30) { push(stack,BigInt(frame.context.addressId),journal,frame,instructionPc,opcode); continue; } if(opcode===0x33){push(stack,BigInt(frame.context.caller),journal,frame,instructionPc,opcode);continue;}
    if(opcode===0x35){push(stack,calldataWord(frame.input,pop(stack,journal,frame,instructionPc,opcode)),journal,frame,instructionPc,opcode);continue;} if(opcode===0x36){push(stack,BigInt(frame.input.length),journal,frame,instructionPc,opcode);continue;}
    if(opcode===0x37){const destination=pop(stack,journal,frame,instructionPc,opcode),source=pop(stack,journal,frame,instructionPc,opcode),size=pop(stack,journal,frame,instructionPc,opcode);const region=safeMemory(destination,size,frame,journal,instructionPc,opcode);memorySize=Math.max(memorySize,region.end);for(let i=0;i<region.size;i++){const sourceIndex=source+BigInt(i);memory[region.offset+i]=sourceIndex<BigInt(frame.input.length)?frame.input[Number(sourceIndex)]!:0;}continue;}
    if(opcode===0x3d){push(stack,BigInt(returnData.length),journal,frame,instructionPc,opcode);continue;} if(opcode===0x3e){const destination=pop(stack,journal,frame,instructionPc,opcode),source=pop(stack,journal,frame,instructionPc,opcode),size=pop(stack,journal,frame,instructionPc,opcode);if(source>BigInt(returnData.length)||size>BigInt(returnData.length)-source)fault(MiniVMErrorCode.RETURN_DATA_OUT_OF_BOUNDS,journal,frame,instructionPc,opcode,{offset:source.toString(),size:size.toString()});const region=safeMemory(destination,size,frame,journal,instructionPc,opcode);memorySize=Math.max(memorySize,region.end);memory.set(returnData.slice(Number(source),Number(source)+region.size),region.offset);continue;}
    if(opcode===0x42||opcode===0x43){push(stack,opcode===0x42?frame.context.chainTimestamp:frame.context.chainBlockNumber,journal,frame,instructionPc,opcode);continue;} if(opcode===0x50){pop(stack,journal,frame,instructionPc,opcode);continue;}
    if(opcode===0x51){const region=safeMemory(pop(stack,journal,frame,instructionPc,opcode),32n,frame,journal,instructionPc,opcode);memorySize=Math.max(memorySize,region.end);push(stack,loadMemory(memory,region.offset),journal,frame,instructionPc,opcode);continue;}
    if(opcode===0x52||opcode===0x53){const offset=pop(stack,journal,frame,instructionPc,opcode),value=pop(stack,journal,frame,instructionPc,opcode);const region=safeMemory(offset,opcode===0x52?32n:1n,frame,journal,instructionPc,opcode);memorySize=Math.max(memorySize,region.end);if(opcode===0x52)storeMemory(memory,region.offset,value);else memory[region.offset]=Number(value&0xffn);continue;}
    if(opcode===0x54){const slot=word(pop(stack,journal,frame,instructionPc,opcode));push(stack,BigInt(journalLoad(state,journal,frame.context.addressId,slot)),journal,frame,instructionPc,opcode);continue;}
    if(opcode===0x55){if(frame.staticMode)fault(MiniVMErrorCode.STATIC_VIOLATION,journal,frame,instructionPc,opcode);const slot=word(pop(stack,journal,frame,instructionPc,opcode)),value=word(pop(stack,journal,frame,instructionPc,opcode));journalStore(journal,frame.context.addressId,slot,value);continue;}
    if(opcode===0x56||opcode===0x57){const destination=pop(stack,journal,frame,instructionPc,opcode);const condition=opcode===0x57?pop(stack,journal,frame,instructionPc,opcode):1n;if(condition!==0n){if(destination>BigInt(Number.MAX_SAFE_INTEGER)||jumpdest[Number(destination)]!==1)fault(MiniVMErrorCode.INVALID_JUMP_DESTINATION,journal,frame,instructionPc,opcode,{destination:destination.toString()});pc=Number(destination);}continue;}
    if(opcode===0x58){push(stack,BigInt(instructionPc),journal,frame,instructionPc,opcode);continue;}if(opcode===0x59){push(stack,BigInt(memorySize),journal,frame,instructionPc,opcode);continue;}if(opcode===0x5b)continue;
    if(opcode>=0xa0&&opcode<=0xa4){if(frame.staticMode)fault(MiniVMErrorCode.STATIC_VIOLATION,journal,frame,instructionPc,opcode);const count=opcode-0xa0;const topics=new Array<Bytes32>(count);for(let i=count;i>0;i--)topics[i-1]=word(pop(stack,journal,frame,instructionPc,opcode));const offset=pop(stack,journal,frame,instructionPc,opcode),size=pop(stack,journal,frame,instructionPc,opcode);const region=safeMemory(offset,size,frame,journal,instructionPc,opcode);memorySize=Math.max(memorySize,region.end);appendRecord(journal,frame,Object.freeze({emitter:frame.context.addressId,topics:Object.freeze(topics),data:bytesToHex(memory.slice(region.offset,region.end))}),instructionPc,opcode);continue;}
    if(opcode>=0xb0&&opcode<=0xbc){let value:bigint;if(opcode===0xb0)value=BigInt(frame.context.txActor);else if(opcode===0xb1)value=BigInt(frame.context.worldId);else if(opcode===0xb2)value=frame.context.executionHeight;else if(opcode===0xb3)value=frame.context.ethAmountIn;else if(opcode===0xb4)value=frame.context.grossTokenOut;else if(opcode===0xb5)value=BigInt(frame.context.tickAfter);else if(opcode===0xb6)value=frame.context.liquidityAfter;else if(opcode===0xb7)value=frame.context.byteGasPrice;else if(opcode===0xb8)value=BigInt(journal.used);else if(opcode===0xb9)value=BigInt(frame.byteLimit-journal.used);else if(opcode===0xba)value=frame.context.txRouter;else if(opcode===0xbb)value=frame.context.txExecutor;else value=frame.context.txRecipient;push(stack,value,journal,frame,instructionPc,opcode);continue;}
    if(opcode===0xf3||opcode===0xfd){const offset=pop(stack,journal,frame,instructionPc,opcode),size=pop(stack,journal,frame,instructionPc,opcode);const region=safeMemory(offset,size,frame,journal,instructionPc,opcode);memorySize=Math.max(memorySize,region.end);const output=memory.slice(region.offset,region.end);if(opcode===0xfd)fault(MiniVMErrorCode.EXPLICIT_REVERT,journal,frame,instructionPc,opcode,{},bytesToHex(output));return output;}
    if(opcode===0xf1||opcode===0xfa){const outputOffset=pop(stack,journal,frame,instructionPc,opcode),outputSize=pop(stack,journal,frame,instructionPc,opcode),inputOffset=pop(stack,journal,frame,instructionPc,opcode),inputSize=pop(stack,journal,frame,instructionPc,opcode),target=word(pop(stack,journal,frame,instructionPc,opcode));const inputRegion=safeMemory(inputOffset,inputSize,frame,journal,instructionPc,opcode),outputRegion=safeMemory(outputOffset,outputSize,frame,journal,instructionPc,opcode);memorySize=Math.max(memorySize,inputRegion.end,outputRegion.end);const pkg=packageForTarget(state,journal,target,frame);const childContext={...frame.context,addressId:target,caller:frame.context.addressId};returnData=runFrame(state,journal,{code:pkg.code,input:memory.slice(inputRegion.offset,inputRegion.end),entry:pkg.runtimeEntry,byteLimit:frame.byteLimit,staticMode:frame.staticMode||opcode===0xfa,depth:frame.depth+1,ancestorMemory:frame.ancestorMemory+memorySize,context:childContext});memory.set(returnData.slice(0,Math.min(outputRegion.size,returnData.length)),outputRegion.offset);push(stack,1n,journal,frame,instructionPc,opcode);continue;}
    if(opcode===0xf0){if(frame.staticMode)fault(MiniVMErrorCode.STATIC_VIOLATION,journal,frame,instructionPc,opcode);const inputOffset=pop(stack,journal,frame,instructionPc,opcode),inputSize=pop(stack,journal,frame,instructionPc,opcode),codeHash=word(pop(stack,journal,frame,instructionPc,opcode));const region=safeMemory(inputOffset,inputSize,frame,journal,instructionPc,opcode);memorySize=Math.max(memorySize,region.end);const pkg=state.packages.get(codeHash);if(pkg===undefined)fault(MiniVMErrorCode.PACKAGE_NOT_REGISTERED,journal,frame,instructionPc,opcode,{codeHash});const nonce=nextNonce(state,journal,frame.context.addressId);if(nonce===U64_MAX)fault(MiniVMErrorCode.CREATOR_NONCE_OVERFLOW,journal,frame,instructionPc,opcode);const contractId=deriveContractId(frame.context.worldId,frame.context.addressId,nonce,codeHash);const deployment=Object.freeze({contractId,creator:frame.context.addressId,codeHash,nonceBefore:nonce.toString(),nonceAfter:(nonce+1n).toString(),root:false});journal.deployments.push(deployment);const childContext={...frame.context,addressId:contractId,caller:frame.context.addressId};returnData=runFrame(state,journal,{code:pkg.package.code,input:memory.slice(region.offset,region.end),entry:pkg.package.constructorEntry,byteLimit:frame.byteLimit,staticMode:false,depth:frame.depth+1,ancestorMemory:frame.ancestorMemory+memorySize,context:childContext});appendRecord(journal,frame,Object.freeze({emitter:KERNEL_EMITTER,topics:Object.freeze([DEPLOYED_TOPIC]),data:bytesToHex(concatBytes(hexToBytes(contractId),hexToBytes(frame.context.addressId),hexToBytes(codeHash)))}),instructionPc,opcode);push(stack,BigInt(contractId),journal,frame,instructionPc,opcode);continue;}
    fault(MiniVMErrorCode.UNKNOWN_OPCODE,journal,frame,instructionPc,opcode);
  }
  fault(MiniVMErrorCode.MISSING_HALT,journal,frame,pc,null);
}

function normalizedDiff(original: MutableState, writes: readonly MiniVMStorageWrite[]): readonly MiniVMStorageDiff[] {
  const final = new Map<string, MiniVMStorageWrite>(); for (const item of writes) final.set(`${item.target}:${item.slot}`,item);
  return Object.freeze([...final.values()].map((item)=>Object.freeze({...item,previousValue:original.storage.get(item.target)?.get(item.slot)??ZERO})));
}
function commit(state: MutableState, writes: readonly MiniVMStorageWrite[], deployments: readonly MiniVMDeployment[]): void {
  for(const item of writes){let slots=state.storage.get(item.target);if(slots===undefined){slots=new Map();state.storage.set(item.target,slots);}slots.set(item.slot,item.value);}
  for(const item of deployments){state.programs.set(item.contractId,item.codeHash);state.creatorNonces.set(item.creator,BigInt(item.nonceAfter));}
}
function encodedRecords(records: readonly MiniVMRecord[]): Hex { return bytesToHex(concatBytes(...records.map(encodeRecord))); }
function failureResult(original: MiniVMWorldState, rootTarget: Bytes32, error: VMFault): MiniVMSimulationResult { const failure:MiniVMFailure=Object.freeze({code:error.vmCode,pc:error.pc,opcode:error.opcode,depth:error.depth,data:error.faultData,details:Object.freeze(cloneRecord(error.faultDetails))});return Object.freeze({success:false,executedBytes:error.used,output:"0x",revertData:error.faultData,storageJournal:Object.freeze([]),storageDiff:Object.freeze([]),deploymentDiff:Object.freeze([]),virtualRecords:Object.freeze([]),encodedRecords:"0x",state:original,rootTarget,error:failure}); }

export function simulateMiniVM(input: SimulateMiniVMInput): MiniVMSimulationResult {
  if (typeof input!=="object"||input===null) throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID);
  const state=loadState(input.state);const original=exportState(state);const action=input.action;const actor=bytes32(action.actor,"action.actor");const targetOrHash=bytes32(action.targetOrCodeHash,"action.targetOrCodeHash");if(!isEoa(actor))throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID,{details:{field:"action.actor"}});
  if(!Number.isInteger(action.byteLimit)||action.byteLimit<0||action.byteLimit>0xffffffff)throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID,{details:{field:"action.byteLimit"}});
  const payload=hexToBytes(action.payload);const journal:Journal={used:0,writes:[],deployments:[],records:[],encodedLength:0};let rootTarget=targetOrHash;
  try{
    let pkg:ProgramPackageV1;let entry:number;
    if(action.op==="DEPLOY"){
      if(action.static===true)throw new VMFault(MiniVMErrorCode.STATIC_VIOLATION,0,1,null,0xf0);
      const found=state.packages.get(targetOrHash);if(found===undefined)throw new VMFault(MiniVMErrorCode.PACKAGE_NOT_REGISTERED,0,1,null,null,"0x",{codeHash:targetOrHash});
      const nonce=state.creatorNonces.get(actor)??0n;if(nonce===U64_MAX)throw new VMFault(MiniVMErrorCode.CREATOR_NONCE_OVERFLOW,0,1,null,null);rootTarget=deriveContractId(bytes32(input.context.worldId,"context.worldId"),actor,nonce,targetOrHash);
      journal.deployments.push(Object.freeze({contractId:rootTarget,creator:actor,codeHash:targetOrHash,nonceBefore:nonce.toString(),nonceAfter:(nonce+1n).toString(),root:true}));pkg=found.package;entry=pkg.constructorEntry;
    }else if(action.op==="CALL"){
      if(!isContract(rootTarget))throw new VMFault(MiniVMErrorCode.INVALID_CONTRACT_ACCOUNT,0,1,null,null,"0x",{target:rootTarget});const codeHash=state.programs.get(rootTarget);if(codeHash===undefined)throw new VMFault(MiniVMErrorCode.PROGRAM_NOT_FOUND,0,1,null,null,"0x",{target:rootTarget});pkg=state.packages.get(codeHash)!.package;entry=pkg.runtimeEntry;
    }else throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID,{details:{field:"action.op"}});
    const output=runFrame(state,journal,{code:pkg.code,input:payload,entry,byteLimit:action.byteLimit,staticMode:action.static===true,depth:1,ancestorMemory:0,context:context(input.context,actor,rootTarget)});
    const diff=normalizedDiff(state,journal.writes);commit(state,journal.writes,journal.deployments);
    return Object.freeze({success:true,executedBytes:journal.used,output:bytesToHex(output),revertData:"0x",storageJournal:Object.freeze([...journal.writes]),storageDiff:diff,deploymentDiff:Object.freeze([...journal.deployments]),virtualRecords:Object.freeze([...journal.records]),encodedRecords:encodedRecords(journal.records),state:exportState(state),rootTarget,error:null});
  }catch(error){if(error instanceof VMFault)return failureResult(original,rootTarget,error);if(error instanceof ToolchainError){const mapped=error.code===ToolchainErrorCode.EMPTY_CODE?MiniVMErrorCode.EMPTY_CODE:error.code===ToolchainErrorCode.CODE_TOO_LARGE?MiniVMErrorCode.CODE_TOO_LARGE:error.code===ToolchainErrorCode.UNKNOWN_OPCODE?MiniVMErrorCode.UNKNOWN_OPCODE:error.code===ToolchainErrorCode.TRUNCATED_IMMEDIATE?MiniVMErrorCode.TRUNCATED_IMMEDIATE:MiniVMErrorCode.INVALID_PACKAGE;return failureResult(original,rootTarget,new VMFault(mapped,journal.used,1,error.offset??null,null));}throw error;}
}

/** Low-level conformance entrypoint for malformed-code and individual-opcode differential tests. */
export function simulateMiniVMCode(input: SimulateMiniVMCodeInput): MiniVMSimulationResult {
  const state=loadState(input.state);const original=exportState(state);const actor=bytes32(input.actor,"actor");const rootTarget=bytes32(input.target,"target");
  if(!Number.isInteger(input.byteLimit)||input.byteLimit<0||input.byteLimit>0xffffffff||!Number.isInteger(input.entry)||input.entry<0)throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID);
  const journal:Journal={used:0,writes:[],deployments:[],records:[],encodedLength:0};
  try{
    const output=runFrame(state,journal,{code:hexToBytes(input.code),input:hexToBytes(input.input),entry:input.entry,byteLimit:input.byteLimit,staticMode:input.static===true,depth:1,ancestorMemory:0,context:context(input.context,actor,rootTarget)});
    const diff=normalizedDiff(state,journal.writes);commit(state,journal.writes,journal.deployments);
    return Object.freeze({success:true,executedBytes:journal.used,output:bytesToHex(output),revertData:"0x",storageJournal:Object.freeze([...journal.writes]),storageDiff:diff,deploymentDiff:Object.freeze([...journal.deployments]),virtualRecords:Object.freeze([...journal.records]),encodedRecords:encodedRecords(journal.records),state:exportState(state),rootTarget,error:null});
  }catch(error){if(error instanceof VMFault)return failureResult(original,rootTarget,error);if(error instanceof ToolchainError){const mapped=error.code===ToolchainErrorCode.EMPTY_CODE?MiniVMErrorCode.EMPTY_CODE:error.code===ToolchainErrorCode.CODE_TOO_LARGE?MiniVMErrorCode.CODE_TOO_LARGE:error.code===ToolchainErrorCode.TRUNCATED_IMMEDIATE?MiniVMErrorCode.TRUNCATED_IMMEDIATE:MiniVMErrorCode.UNKNOWN_OPCODE;return failureResult(original,rootTarget,new VMFault(mapped,journal.used,1,error.offset??null,null));}throw error;}
}
