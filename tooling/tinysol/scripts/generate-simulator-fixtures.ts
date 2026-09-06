import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, functionSelector } from "../src/abi.js";
import type { Bytes32, Hex } from "../src/bytes.js";
import { simulateMiniVM, simulateMiniVMCode } from "../src/simulator.js";
import type { MiniVMContextInput, MiniVMWorldState, SimulateMiniVMInput } from "../src/simulator-types.js";

const here=dirname(fileURLToPath(import.meta.url));const root=resolve(here,"../../../..");const outputPath=resolve(here,"../../fixtures/simulator-corpus.json");const differentialPath=resolve(here,"../../fixtures/simulator-solidity-differential.json");const check=process.argv.includes("--check");
const WORLD=`0x${"11".repeat(32)}` as Bytes32;const ACTOR=`0x${"00".repeat(12)}00000000000000000000000000000000000a11ce` as Bytes32;const TARGET=`0x01${"22".repeat(31)}` as Bytes32;const TARGET2=`0x01${"33".repeat(31)}` as Bytes32;
const RECIPIENT=`0x000000000000000000000000000000000000beef` as Bytes32;const ABI_NOTE=`0x${Buffer.from("TinySol ABI conformance").toString("hex").padEnd(64,"0")}` as Bytes32;
const context:MiniVMContextInput={worldId:WORLD,executionHeight:"77",byteGasPrice:"11",buy:{ethAmountIn:"123",grossTokenOut:"1000000",tickAfter:-17,liquidityAfter:"789"},block:{number:"999",timestamp:"1234"}};
const word=(value:bigint)=>value.toString(16).padStart(64,"0");const ascii=(value:string)=>Buffer.from(value).toString("hex").padEnd(64,"0");const calldata=(signature:string,...values:bigint[])=>`${functionSelector(signature)}${values.map(word).join("")}` as Hex;
type Artifact={name:string;package:Hex;codeHash:Bytes32};const artifacts=new Map<string,Artifact>();
for(const name of ["Context","ControlFlow","Counter","EventDemo","Factory","Mapping","MiniNFT","MiniToken","NestedCaller"]){const item=JSON.parse(await readFile(resolve(root,`tooling/tinysol/fixtures/compiler/${name}.json`),"utf8"));artifacts.set(name,{name,package:item.package,codeHash:item.codeHash});}
for(const name of ["SRC20-v1","SRC721-v1","SRC1155-v1","CPAMM-v1"]){const item=JSON.parse(await readFile(resolve(root,`reference/${name}.json`),"utf8"));artifacts.set(name,{name,package:item.package,codeHash:item.codeHash});}
{
  const item=JSON.parse(await readFile(resolve(root,"tooling/tinysol/fixtures/compiler/Conformance.json"),"utf8"));
  artifacts.set("Conformance",{name:"Conformance",package:item.package,codeHash:item.codeHash});
}
const packages=Object.fromEntries([...artifacts.values()].map((item)=>[item.codeHash,item.package]));
function state(programs:Record<string,{codeHash:Bytes32}>={},storage:MiniVMWorldState["storage"]={},creatorNonces:MiniVMWorldState["creatorNonces"]={}):MiniVMWorldState{return {packages,programs,storage,creatorNonces};}
const cases:{id:string;input:SimulateMiniVMInput;result:ReturnType<typeof simulateMiniVM>;solidity:{recordCount:number;storageJournalCount:number;internalDeploymentCount:number}}[]=[];function add(id:string,input:SimulateMiniVMInput){const result=simulateMiniVM(input);cases.push({id,input,result,solidity:{recordCount:result.virtualRecords.length,storageJournalCount:result.storageJournal.length,internalDeploymentCount:result.deploymentDiff.filter((item)=>!item.root).length}});return result;}
const deployInputs:Record<string,Hex>={Context:"0x",ControlFlow:"0x",Counter:`0x${word(5n)}`,EventDemo:"0x",Factory:"0x",Mapping:"0x",MiniNFT:`0x${word(1n)}`,MiniToken:`0x${word(1000n)}${word(BigInt(ACTOR))}`,NestedCaller:"0x",
  "SRC20-v1":`0x${ascii("Token")}${ascii("TOK")}${word(18n)}${word(1000n)}${word(BigInt(ACTOR))}`,
  "SRC721-v1":`0x${ascii("NFT")}${ascii("NFT")}${word(1n)}${word(BigInt(ACTOR))}${word(0x1234n)}`,
  "SRC1155-v1":`0x${word(0x5678n)}${word(1n)}${word(500n)}${word(BigInt(ACTOR))}`,"CPAMM-v1":"0x",Conformance:`0x${word(5n)}`};
for(const name of ["Context","ControlFlow","Counter","EventDemo","Factory","Mapping","MiniNFT","MiniToken","NestedCaller","SRC20-v1","SRC721-v1","SRC1155-v1","CPAMM-v1"]){const item=artifacts.get(name)!;add(`deploy-${name}`,{state:state(),action:{op:"DEPLOY",actor:ACTOR,targetOrCodeHash:item.codeHash,payload:deployInputs[name]!,byteLimit:1_000_000},context});}
const counter=artifacts.get("Counter")!,control=artifacts.get("ControlFlow")!,event=artifacts.get("EventDemo")!,mapping=artifacts.get("Mapping")!,factory=artifacts.get("Factory")!,nested=artifacts.get("NestedCaller")!;
add("counter-increment",{state:state({[TARGET]:{codeHash:counter.codeHash}},{[TARGET]:{[`0x${word(0n)}`]:`0x${word(5n)}` as Bytes32}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("increment(uint256)",3n),byteLimit:1_000_000},context});
add("control-loop",{state:state({[TARGET]:{codeHash:control.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("arithmetic(uint256)",1n),byteLimit:1_000_000},context});
add("control-revert",{state:state({[TARGET]:{codeHash:control.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("setOrFail(bool,uint256)",0n,9n),byteLimit:1_000_000},context});
add("event-log",{state:state({[TARGET]:{codeHash:event.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("set(uint256,bool)",55n,1n),byteLimit:1_000_000},context});
add("mapping-write",{state:state({[TARGET]:{codeHash:mapping.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("set(bytes32,uint256)",BigInt(ACTOR),42n),byteLimit:1_000_000},context});
add("nested-call",{state:state({[TARGET]:{codeHash:nested.codeHash},[TARGET2]:{codeHash:counter.codeHash}},{[TARGET2]:{[`0x${word(0n)}`]:`0x${word(2n)}` as Bytes32}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("increment(bytes32,uint256)",BigInt(TARGET2),4n),byteLimit:1_000_000},context});
add("nested-staticcall",{state:state({[TARGET]:{codeHash:nested.codeHash},[TARGET2]:{codeHash:counter.codeHash}},{[TARGET2]:{[`0x${word(0n)}`]:`0x${word(7n)}` as Bytes32}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("read(bytes32)",BigInt(TARGET2)),byteLimit:1_000_000},context});
add("internal-create",{state:state({[TARGET]:{codeHash:factory.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("spawn(bytes32,uint256)",BigInt(counter.codeHash),91n),byteLimit:1_000_000},context});
add("out-of-byte-gas",{state:state({[TARGET]:{codeHash:control.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("arithmetic(uint256)",1n),byteLimit:40},context});
add("static-violation",{state:state({[TARGET]:{codeHash:event.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("set(uint256,bool)",1n,1n),byteLimit:1_000_000,static:true},context});
add("nested-child-revert",{state:state({[TARGET]:{codeHash:nested.codeHash},[TARGET2]:{codeHash:control.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("setOrFail(bytes32,bool,uint256)",BigInt(TARGET2),0n,88n),byteLimit:1_000_000},context});
add("static-descendant-write",{state:state({[TARGET]:{codeHash:nested.codeHash},[TARGET2]:{codeHash:counter.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("increment(bytes32,uint256)",BigInt(TARGET2),1n),byteLimit:1_000_000,static:true},context});
const contextProgram=artifacts.get("Context")!;
add("context-actors",{state:state({[TARGET]:{codeHash:contextProgram.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("actors()"),byteLimit:1_000_000},context});
add("context-world",{state:state({[TARGET]:{codeHash:contextProgram.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("worldValues()"),byteLimit:1_000_000},context});
add("context-chain-gas",{state:state({[TARGET]:{codeHash:contextProgram.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("chainValues()"),byteLimit:1_000_000},context});
const conformance=artifacts.get("Conformance")!;
add("conformance-deploy",{state:state(),action:{op:"DEPLOY",actor:ACTOR,targetOrCodeHash:conformance.codeHash,payload:deployInputs.Conformance!,byteLimit:1_000_000},context});
add("conformance-arithmetic",{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("arithmetic(uint256,uint256)",9n,4n),byteLimit:1_000_000},context});
add("conformance-control-flow-storage",{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("controlFlow(uint256,bool)",4n,1n),byteLimit:1_000_000},context});
add("conformance-internal-call",{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("internalCall(uint256)",12n),byteLimit:1_000_000},context});
add("conformance-abi-event-storage",{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),BigInt(RECIPIENT),BigInt(ABI_NOTE),1n,73n),byteLimit:1_000_000},context});
add("conformance-revert-rollback",{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),BigInt(RECIPIENT),BigInt(ABI_NOTE),0n,73n),byteLimit:1_000_000},context});
const arithmeticCaseIds=["conformance-arithmetic-small","conformance-arithmetic-balanced","conformance-arithmetic-large"];
add(arithmeticCaseIds[0]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("arithmetic(uint256,uint256)",1n,0n),byteLimit:1_000_000},context});
add(arithmeticCaseIds[1]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("arithmetic(uint256,uint256)",2n,3n),byteLimit:1_000_000},context});
add(arithmeticCaseIds[2]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("arithmetic(uint256,uint256)",1_000_000_000_000_000_000n,2_000_000_000_000_000_000n),byteLimit:1_000_000},context});
const controlFlowCaseIds=["conformance-control-zero-single","conformance-control-zero-double","conformance-control-large-single"];
add(controlFlowCaseIds[0]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("controlFlow(uint256,bool)",0n,0n),byteLimit:1_000_000},context});
add(controlFlowCaseIds[1]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("controlFlow(uint256,bool)",0n,1n),byteLimit:1_000_000},context});
add(controlFlowCaseIds[2]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("controlFlow(uint256,bool)",17n,0n),byteLimit:1_000_000},context});
const internalCallCaseIds=["conformance-internal-zero","conformance-internal-one","conformance-internal-large"];
add(internalCallCaseIds[0]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("internalCall(uint256)",0n),byteLimit:1_000_000},context});
add(internalCallCaseIds[1]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("internalCall(uint256)",1n),byteLimit:1_000_000},context});
add(internalCallCaseIds[2]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("internalCall(uint256)",1_000_000_000_000_000_000n),byteLimit:1_000_000},context});
const alternateOwner=`0x${"ab".repeat(32)}` as Bytes32;
const abiCaseIds=["conformance-abi-zero","conformance-abi-large","conformance-abi-invalid-bool","conformance-abi-invalid-address","conformance-abi-short-calldata","conformance-abi-extra-calldata","conformance-abi-unknown-selector"];
const abiZero=calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(TARGET2),0n,0n,1n,0n);
const abiLarge=calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(alternateOwner),(1n<<160n)-1n,(1n<<256n)-1n,1n,(1n<<255n)+123n);
add(abiCaseIds[0]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:abiZero,byteLimit:1_000_000},context});
add(abiCaseIds[1]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:abiLarge,byteLimit:1_000_000},context});
add(abiCaseIds[2]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),BigInt(RECIPIENT),BigInt(ABI_NOTE),2n,73n),byteLimit:1_000_000},context});
add(abiCaseIds[3]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),1n<<160n,BigInt(ABI_NOTE),1n,73n),byteLimit:1_000_000},context});
add(abiCaseIds[4]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:abiZero.slice(0,-2) as Hex,byteLimit:1_000_000},context});
add(abiCaseIds[5]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:`${abiZero}${word(0n)}` as Hex,byteLimit:1_000_000},context});
add(abiCaseIds[6]!,{state:state({[TARGET]:{codeHash:conformance.codeHash}}),action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:"0xdeadbeef",byteLimit:1_000_000},context});
const storageCaseIds=["conformance-storage-control","conformance-storage-internal","conformance-storage-mapping-write","conformance-storage-mapping-overwrite","conformance-storage-revert","conformance-storage-mapping-read","conformance-storage-scalar-read"];
let sequenceState=state({[TARGET]:{codeHash:conformance.codeHash}});
let sequenceResult=add(storageCaseIds[0]!,{state:sequenceState,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("controlFlow(uint256,bool)",4n,1n),byteLimit:1_000_000},context});sequenceState=sequenceResult.state;
sequenceResult=add(storageCaseIds[1]!,{state:sequenceState,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("internalCall(uint256)",100n),byteLimit:1_000_000},context});sequenceState=sequenceResult.state;
sequenceResult=add(storageCaseIds[2]!,{state:sequenceState,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),BigInt(RECIPIENT),BigInt(ABI_NOTE),1n,211n),byteLimit:1_000_000},context});sequenceState=sequenceResult.state;
sequenceResult=add(storageCaseIds[3]!,{state:sequenceState,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),BigInt(RECIPIENT),BigInt(ABI_NOTE),1n,377n),byteLimit:1_000_000},context});sequenceState=sequenceResult.state;
sequenceResult=add(storageCaseIds[4]!,{state:sequenceState,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("abiRoundTrip(bytes32,address,bytes32,bool,uint256)",BigInt(ACTOR),BigInt(RECIPIENT),BigInt(ABI_NOTE),0n,999n),byteLimit:1_000_000},context});sequenceState=sequenceResult.state;
sequenceResult=add(storageCaseIds[5]!,{state:sequenceState,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("balanceOf(bytes32)",BigInt(ACTOR)),byteLimit:1_000_000},context});sequenceState=sequenceResult.state;
add(storageCaseIds[6]!,{state:sequenceState,action:{op:"CALL",actor:ACTOR,targetOrCodeHash:TARGET,payload:calldata("getScalar()"),byteLimit:1_000_000},context});
const conformanceMatrix={format:"TinySolSVMConformanceMatrix",version:1,categories:{arithmetic:arithmeticCaseIds,controlFlow:controlFlowCaseIds,internalCalls:internalCallCaseIds,abiEncoding:abiCaseIds,storage:storageCaseIds},caseCount:arithmeticCaseIds.length+controlFlowCaseIds.length+internalCallCaseIds.length+abiCaseIds.length+storageCaseIds.length};
const rawCases:{id:string;code:Hex;result:ReturnType<typeof simulateMiniVMCode>}[]=[];
let seed=0x6d3c0den;
for(let index=0;index<64;index+=1){
  seed=(seed*1664525n+1013904223n)&0xffffffffn;
  const value=seed;const shift=Number((seed>>27n)&31n);
  const code=`0x63${value.toString(16).padStart(8,"0")}60${shift.toString(16).padStart(2,"0")}1b5f5260205ff3` as Hex;
  const result=simulateMiniVMCode({state:state(),code,input:"0x",entry:0,actor:ACTOR,target:TARGET,byteLimit:1_000_000,context});
  rawCases.push({id:`fixed-seed-${index.toString().padStart(2,"0")}`,code,result});
}
const output=`${canonicalJson({format:"SwapVMMiniVMDifferentialCorpus",version:1,context,cases,rawCases,conformanceMatrix})}\n`;
const differential=`${canonicalJson({format:"SwapVMMiniVMSolidityDifferential",version:1,cases:cases.map(({id,result,solidity})=>({id,result:{success:result.success,errorCode:result.error?.code??null,executedBytes:result.executedBytes,output:result.output,encodedRecords:result.encodedRecords,rootTarget:result.rootTarget,storageJournal:result.storageJournal,deploymentDiff:result.deploymentDiff},solidity})),rawCases:rawCases.map(({id,code,result})=>({id,code,result:{success:result.success,errorCode:result.error?.code??null,executedBytes:result.executedBytes,output:result.output}})),conformanceMatrix})}\n`;
if(check){const current=await readFile(outputPath,"utf8").catch(()=>"");const currentDifferential=await readFile(differentialPath,"utf8").catch(()=>"");if(current!==output||currentDifferential!==differential)throw new Error("SIMULATOR_FIXTURE_DRIFT");}else{await writeFile(outputPath,output);await writeFile(differentialPath,differential);}
process.stdout.write(`MiniVM simulator corpus: ${cases.length} scenarios and ${rawCases.length} fixed-seed cases verified\n`);
