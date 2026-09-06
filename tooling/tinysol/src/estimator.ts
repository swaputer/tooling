import { ToolchainError, ToolchainErrorCode } from "./errors.js";
import { simulateMiniVM } from "./simulator.js";
import type { EstimateMiniVMInput, MiniVMFeeEstimate } from "./simulator-types.js";

const U128_MAX = (1n << 128n) - 1n;
function amount(value: string, field: string, maximum?: bigint): bigint { if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID,{details:{field}}); const parsed=BigInt(value);if(maximum!==undefined&&parsed>maximum)throw new ToolchainError(ToolchainErrorCode.SIMULATION_INPUT_INVALID,{details:{field}});return parsed; }

export function estimateMiniVMFee(input: EstimateMiniVMInput): MiniVMFeeEstimate {
  const simulation=simulateMiniVM(input);const price=amount(input.context.byteGasPrice,"context.byteGasPrice",U128_MAX);const gross=amount(input.context.buy.grossTokenOut,"context.buy.grossTokenOut",U128_MAX);const minimum=amount(input.minNetTokenOut,"minNetTokenOut",U128_MAX);const maximum=BigInt(input.action.byteLimit)*price;const covers=gross>=maximum+minimum;
  if(!simulation.success)return Object.freeze({mode:"unavailable",estimatedExecutedBytes:null,byteGasPrice:price.toString(),estimatedActualBurn:null,byteGasLimit:input.action.byteLimit,maximumTokenExposure:maximum.toString(),grossTokenOutput:gross.toString(),estimatedNetTokenOutput:null,minNetTokenOut:minimum.toString(),coversMaximumExposureAndMinNet:covers,signable:false,simulation});
  const burn=BigInt(simulation.executedBytes)*price;const net=gross>=burn?(gross-burn).toString():null;return Object.freeze({mode:"exact",estimatedExecutedBytes:simulation.executedBytes,byteGasPrice:price.toString(),estimatedActualBurn:burn.toString(),byteGasLimit:input.action.byteLimit,maximumTokenExposure:maximum.toString(),grossTokenOutput:gross.toString(),estimatedNetTokenOutput:net,minNetTokenOut:minimum.toString(),coversMaximumExposureAndMinNet:covers,signable:covers&&net!==null&&BigInt(net)>=minimum,simulation});
}
