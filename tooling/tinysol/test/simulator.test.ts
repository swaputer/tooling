import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  MiniVMErrorCode, ToolchainError, ToolchainErrorCode, assemble, buildProgramPackage, bytesToHex, emptyMiniVMWorldState, encodeProgramPackageHex,
  estimateMiniVMFee, functionSelector, programPackageCodeHash, simulateMiniVM, simulateMiniVMCode, compileTinySol,
  type Bytes32, type Hex, type MiniVMContextInput, type MiniVMWorldState
} from "../src/index.js";

const here=dirname(fileURLToPath(import.meta.url));const fixtures=resolve(here,"../../fixtures/compiler");
const WORLD=`0x${"11".repeat(32)}` as Bytes32;const ACTOR=`0x${"00".repeat(12)}00000000000000000000000000000000000a11ce` as Bytes32;
const TARGET=`0x01${"22".repeat(31)}` as Bytes32;const context:MiniVMContextInput=Object.freeze({worldId:WORLD,executionHeight:"77",byteGasPrice:"11",buy:{ethAmountIn:"123",grossTokenOut:"1000000",tickAfter:-17,liquidityAfter:"789"},block:{number:"999",timestamp:"1234"}});
const TX_ROUTER="0x0000000000000000000000000000000000000a01";const TX_EXECUTOR="0x0000000000000000000000000000000000000b02";const TX_RECIPIENT="0x0000000000000000000000000000000000000c03";
const contextWithTx:MiniVMContextInput=Object.freeze({...context,tx:{router:TX_ROUTER,executor:TX_EXECUTOR,recipient:TX_RECIPIENT}});
const arg=(value:bigint)=>value.toString(16).padStart(64,"0");
const call=(signature:string,...values:bigint[])=>`${functionSelector(signature)}${values.map(arg).join("")}` as Hex;
async function fixture(name:string){return JSON.parse(await readFile(resolve(fixtures,`${name}.json`),"utf8")) as {package:Hex;codeHash:Bytes32};}
function installed(item:{package:Hex;codeHash:Bytes32},target=TARGET):MiniVMWorldState{return Object.freeze({packages:{[item.codeHash]:item.package},programs:{[target]:{codeHash:item.codeHash}},storage:{},creatorNonces:{}});}
function raw(code:string,byteLimit=1_000_000,staticMode=false,state=emptyMiniVMWorldState()){return simulateMiniVMCode({state,code:`0x${code}` as Hex,input:"0x",entry:0,actor:ACTOR,target:TARGET,byteLimit,static:staticMode,context});}

test("Counter executes exact concrete path and commits deterministic storage",async()=>{const item=await fixture("Counter");let result=simulateMiniVM({state:{packages:{[item.codeHash]:item.package},programs:{},storage:{},creatorNonces:{}},action:{op:"DEPLOY",actor:ACTOR,targetOrCodeHash:item.codeHash,payload:`0x${arg(5n)}`,byteLimit:1_000_000},context});assert.equal(result.success,true);assert.equal(result.executedBytes,19);assert.equal(result.deploymentDiff.length,1);result=simulateMiniVM({state:result.state,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:result.rootTarget,payload:call("increment(uint256)",3n),byteLimit:1_000_000},context});assert.equal(result.success,true);assert.equal(result.executedBytes,60);assert.equal(result.output,`0x${arg(8n)}`);assert.equal(result.storageDiff[0]?.previousValue,`0x${arg(5n)}`);});

test("internal helper calls execute with return value propagation",async()=>{
  const source = `contract C { function nested(uint256 x) internal view returns(uint256){ return x + 1; } function sumAndAdd(uint256 x) view returns(uint256){ return nested(x) + nested(x + 1); } }`;
  const item = compileTinySol(source);
  const state = { packages: { [item.codeHash]: encodeProgramPackageHex(item.package) }, programs: {}, storage: {}, creatorNonces: {} };
  const deployed = simulateMiniVM({ state, action: { op: "DEPLOY", actor: ACTOR, targetOrCodeHash: item.codeHash, payload: "0x", byteLimit: 1_000_000 }, context });
  assert.equal(deployed.success, true);
  const called = simulateMiniVM({ state: deployed.state, action: { op: "CALL", actor: ACTOR, targetOrCodeHash: deployed.rootTarget, payload: call("sumAndAdd(uint256)", 5n), byteLimit: 1_000_000 }, context });
  assert.equal(called.success, true);
  assert.equal(called.output, `0x${arg(13n)}`);
});

test("compiled Conformance corpus fixes TinySol arithmetic, flow, ABI, events, storage and rollback",async()=>{
  const source=await readFile(resolve(here,"../../examples/Conformance.tiny.sol"),"utf8");
  const compiled=compileTinySol(source,{sourceName:"examples/Conformance.tiny.sol"});
  const fixtureItem=await fixture("Conformance");
  assert.equal(compiled.codeHash,fixtureItem.codeHash);
  assert.equal(encodeProgramPackageHex(compiled.package),fixtureItem.package);
  assert.match(compiled.assembly,/__internal_1_addSeven/);

  const state={packages:{[compiled.codeHash]:fixtureItem.package},programs:{[TARGET]:{codeHash:compiled.codeHash}},storage:{},creatorNonces:{}};
  const arithmetic=simulateMiniVM({state,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("arithmetic(uint256,uint256)",9n,4n),byteLimit:1_000_000},context});
  assert.equal(arithmetic.success,true);
  assert.equal(arithmetic.output,`0x${arg(37n)}`);

  const control=simulateMiniVM({state,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("controlFlow(uint256,bool)",4n,1n),byteLimit:1_000_000},context});
  assert.equal(control.success,true);
  assert.equal(control.output,`0x${arg(14n)}`);
  assert.equal(control.storageDiff[0]?.value,`0x${arg(14n)}`);

  const internal=simulateMiniVM({state,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("internalCall(uint256)",12n),byteLimit:1_000_000},context});
  assert.equal(internal.success,true);
  assert.equal(internal.output,`0x${arg(19n)}`);

  const recipient=`0x000000000000000000000000000000000000beef` as Bytes32;
  const note=`0x${Buffer.from("TinySol ABI conformance").toString("hex").padEnd(64,"0")}` as Bytes32;
  const abi=simulateMiniVM({state,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),BigInt(recipient),BigInt(note),1n,73n),byteLimit:1_000_000},context});
  assert.equal(abi.success,true);
  assert.equal(abi.output,`0x${arg(73n)}`);
  assert.equal(abi.virtualRecords.length,1);
  assert.equal(abi.virtualRecords[0]?.topics[1],ACTOR);
  assert.equal(abi.virtualRecords[0]?.data,`0x${arg(BigInt(recipient))}${arg(BigInt(note))}${arg(1n)}${arg(73n)}`);
  assert.equal(abi.storageDiff.length,1);

  const reverted=simulateMiniVM({state,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),BigInt(recipient),BigInt(note),0n,73n),byteLimit:1_000_000},context});
  assert.equal(reverted.success,false);
  assert.equal(reverted.error?.code,MiniVMErrorCode.EXPLICIT_REVERT);
  assert.deepEqual(reverted.storageDiff,[]);
  assert.deepEqual(reverted.virtualRecords,[]);
});

test("explicit child/root failure exposes no partial state, deployments, or records",async()=>{const item=await fixture("ControlFlow");const state={...installed(item),storage:{[TARGET]:{[`0x${arg(0n)}`]:`0x${arg(7n)}` as Bytes32}}};const result=simulateMiniVM({state,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("setOrFail(bool,uint256)",0n,9n),byteLimit:1_000_000},context});assert.equal(result.success,false);assert.equal(result.error?.code,MiniVMErrorCode.EXPLICIT_REVERT);assert.deepEqual(result.storageDiff,[]);assert.deepEqual(result.deploymentDiff,[]);assert.deepEqual(result.virtualRecords,[]);assert.deepEqual(result.state,simulateMiniVMCode({state,code:"0x00",input:"0x",entry:0,actor:ACTOR,target:TARGET,byteLimit:1,context}).state);});

test("events preserve emitter, topics, data and deterministic encoding",async()=>{const item=await fixture("EventDemo");const result=simulateMiniVM({state:installed(item),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("set(uint256,bool)",55n,1n),byteLimit:1_000_000},context});assert.equal(result.success,true);assert.equal(result.virtualRecords.length,1);assert.equal(result.virtualRecords[0]?.emitter,TARGET);assert.equal(result.virtualRecords[0]?.topics.length,2);assert.equal(result.virtualRecords[0]?.data,`0x${arg(55n)}${arg(1n)}`);assert.ok(result.encodedRecords.length>2);});

test("exact fee report distinguishes actual burn from maximum exposure",async()=>{const item=await fixture("Counter");const estimate=estimateMiniVMFee({state:installed(item),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("get()"),byteLimit:1000},context,minNetTokenOut:"900000"});assert.equal(estimate.mode,"exact");assert.equal(estimate.estimatedExecutedBytes,59);assert.equal(estimate.estimatedActualBurn,"649");assert.equal(estimate.maximumTokenExposure,"11000");assert.equal(estimate.estimatedNetTokenOutput,"999351");assert.equal(estimate.signable,true);});

test("fee estimate rejects values outside signed uint128 fields",async()=>{const item=await fixture("Counter");assert.throws(()=>estimateMiniVMFee({state:installed(item),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:call("get()"),byteLimit:1000},context,minNetTokenOut:(1n<<128n).toString()}),(error:unknown)=>error instanceof ToolchainError&&error.code===ToolchainErrorCode.SIMULATION_INPUT_INVALID&&error.details.field==="minNetTokenOut");});

test("OutOfByteGas boundary includes the rejected next instruction and rolls back",()=>{assert.equal(raw("600100",3).success,true);const failed=raw("600100",1);assert.equal(failed.success,false);assert.equal(failed.error?.code,MiniVMErrorCode.OUT_OF_BYTE_GAS);assert.equal(failed.executedBytes,2);assert.deepEqual(failed.storageDiff,[]);});

test("repeated SSTORE coalesces the journal exactly like the Solidity interpreter",()=>{const result=raw("60015f5560025f5500");assert.equal(result.success,true);assert.equal(result.executedBytes,9);assert.equal(result.storageJournal.length,1);assert.equal(result.storageJournal[0]?.target,TARGET);assert.equal(result.storageJournal[0]?.slot,`0x${arg(0n)}`);assert.equal(result.storageJournal[0]?.value,`0x${arg(2n)}`);assert.equal(result.storageDiff.length,1);assert.equal(result.storageDiff[0]?.previousValue,`0x${arg(0n)}`);assert.equal(result.state.storage[TARGET]?.[`0x${arg(0n)}`],`0x${arg(2n)}`);});

test("static descendants reject writes and malformed bytecode fails before execution",()=>{const staticFailure=raw("600160005500",100,true);assert.equal(staticFailure.success,false);assert.equal(staticFailure.error?.code,MiniVMErrorCode.STATIC_VIOLATION);assert.equal(staticFailure.executedBytes,5);const unknown=raw("fe");assert.equal(unknown.success,false);assert.equal(unknown.error?.code,MiniVMErrorCode.UNKNOWN_OPCODE);assert.equal(unknown.executedBytes,0);const truncated=raw("61ff");assert.equal(truncated.error?.code,MiniVMErrorCode.TRUNCATED_IMMEDIATE);});

test("arithmetic, memory, calldata, branching, return and signed operations match word rules",()=>{const code=assemble(`.constructor start\n.runtime start\n.code\nstart:\nPUSH1 0x09\nPUSH1 0x02\nSDIV\nPUSH0\nMSTORE\nPUSH1 0x20\nPUSH0\nRETURN\n`).codeHex.slice(2);const result=raw(code);assert.equal(result.success,true);assert.equal(result.output,`0x${arg(4n)}`);assert.equal(result.executedBytes,11);});

test("v1.2 TXROUTER, TXEXECUTOR and TXRECIPIENT expose deterministic EVM address words",()=>{const code=assemble(`.constructor x\n.runtime x\n.code\nx:\nTXROUTER\nPUSH0\nMSTORE\nTXEXECUTOR\nPUSH1 0x20\nMSTORE\nTXRECIPIENT\nPUSH1 0x40\nMSTORE\nPUSH1 0x60\nPUSH0\nRETURN\n`).codeHex.slice(2);const result=simulateMiniVMCode({state:emptyMiniVMWorldState(),code:`0x${code}` as Hex,input:"0x",entry:0,actor:ACTOR,target:TARGET,byteLimit:1_000_000,context:contextWithTx});assert.equal(result.success,true);assert.equal(result.output,`0x${arg(BigInt(TX_ROUTER))}${arg(BigInt(TX_EXECUTOR))}${arg(BigInt(TX_RECIPIENT))}`);assert.equal(result.executedBytes,15);});

test("all ten compiler fixtures validate as executable packages",async()=>{for(const name of ["Context","ControlFlow","Counter","EventDemo","Factory","Mapping","MiniNFT","MiniToken","NestedCaller","Conformance"]){const item=await fixture(name);const state=installed(item);const result=simulateMiniVMCode({state,code:"0x00",input:"0x",entry:0,actor:ACTOR,target:TARGET,byteLimit:1,context});assert.equal(result.success,true,name);}});

test("fixed-seed raw programs are deterministic byte-for-byte",()=>{let seed=0x6d3;const next=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};for(let i=0;i<128;i++){const value=BigInt(next());const shift=BigInt(next()%256);const assembly=`.constructor x\n.runtime x\n.code\nx:\nPUSH4 0x${value.toString(16).padStart(8,"0")}\nPUSH1 0x${shift.toString(16).padStart(2,"0")}\nSHL\nPUSH0\nMSTORE\nPUSH1 0x20\nPUSH0\nRETURN\n`;const code=assemble(assembly).codeHex.slice(2);assert.deepEqual(raw(code),raw(code));}});

test("call depth is capped at 32 with one shared meter",()=>{const built=buildProgramPackage({constructorEntry:0,runtimeEntry:0,abiHash:`0x${"00".repeat(32)}`,code:`0x7f${TARGET.slice(2)}5f5f5f5ff100`});const packageHex=encodeProgramPackageHex(built);const codeHash=programPackageCodeHash(packageHex);const result=simulateMiniVM({state:{packages:{[codeHash]:packageHex},programs:{[TARGET]:{codeHash}},storage:{},creatorNonces:{}},action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:"0x",byteLimit:1_000_000},context});assert.equal(result.success,false);assert.equal(result.error?.code,MiniVMErrorCode.CALL_DEPTH_EXCEEDED);assert.equal(result.error?.depth,33);assert.ok(result.executedBytes>32);});

test("receipt and memory ceilings fail atomically",()=>{const tooLarge=raw("6110015fa000");assert.equal(tooLarge.error?.code,MiniVMErrorCode.RECORD_DATA_TOO_LARGE);let logs="";for(let i=0;i<64;i++)logs+="6110005fa0";const payload=raw(`${logs}00`);assert.equal(payload.error?.code,MiniVMErrorCode.RECEIPT_PAYLOAD_TOO_LARGE);const memory=raw("6001620100005200");assert.equal(memory.error?.code,MiniVMErrorCode.MEMORY_OUT_OF_BOUNDS);});

test("ECRECOVER returns the canonical zero-tag EOA AccountId",()=>{const privateKey=new Uint8Array(32);privateKey[31]=7;const hash=keccak_256(new TextEncoder().encode("SwapVM Stage6D3 ecrecover"));const signature=secp256k1.sign(hash,privateKey,{lowS:true});const compact=signature.toCompactRawBytes();const r=bytesToHex(compact.slice(0,32));const s=bytesToHex(compact.slice(32));const publicKey=secp256k1.getPublicKey(privateKey,false);const expected=bytesToHex(keccak_256(publicKey.slice(1)).slice(12)).slice(2).padStart(64,"0");const code=assemble(`.constructor x\n.runtime x\n.code\nx:\nPUSH32 ${bytesToHex(hash)}\nPUSH1 0x${(27+(signature.recovery??0)).toString(16)}\nPUSH32 ${r}\nPUSH32 ${s}\nECRECOVER\nPUSH0\nMSTORE\nPUSH1 0x20\nPUSH0\nRETURN\n`).codeHex.slice(2);const result=raw(code);assert.equal(result.success,true);assert.equal(result.output,`0x${expected}`);});

test("MiniToken transfer has a frozen exact concrete-byte estimate",async()=>{const item=await fixture("MiniToken");const deployed=simulateMiniVM({state:{packages:{[item.codeHash]:item.package},programs:{},storage:{},creatorNonces:{}},action:{op:"DEPLOY",actor:ACTOR,targetOrCodeHash:item.codeHash,payload:`0x${arg(1000n)}${ACTOR.slice(2)}` as Hex,byteLimit:1_000_000},context});assert.equal(deployed.success,true);const recipient=`0x${"00".repeat(12)}000000000000000000000000000000000000beef` as Bytes32;const estimate=estimateMiniVMFee({state:deployed.state,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:deployed.rootTarget,payload:call("transfer(bytes32,uint256)",BigInt(recipient),7n),byteLimit:1000},context,minNetTokenOut:"900000"});assert.equal(estimate.estimatedExecutedBytes,373);assert.equal(estimate.estimatedActualBurn,"4103");assert.equal(estimate.maximumTokenExposure,"11000");assert.equal(estimate.estimatedNetTokenOutput,"995897");assert.equal(estimate.simulation.virtualRecords.length,1);});

test("Stage 7B threat-class regressions remain bound to Solidity differential fixtures",async()=>{const root=resolve(here,"../../fixtures");const index=JSON.parse(await readFile(resolve(root,"security-regressions.json"),"utf8")) as {cases:{id:string;threat:string;expected:string}[]};const differential=JSON.parse(await readFile(resolve(root,"simulator-solidity-differential.json"),"utf8")) as {cases:{id:string}[];rawCases:{id:string}[]};const ids=new Set([...differential.cases,...differential.rawCases].map(item=>item.id));assert.equal(index.cases.length,10);for(const item of index.cases){assert.ok(item.threat.length>0&&item.expected.length>0);assert.ok(ids.has(item.id),`${item.id} must stay in the Solidity differential corpus`);}});
