import type { VMRecord } from "@swaputer/receipt-codec";

const APPLICATION_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "0xbc7a322f72742a0c810e1f76615f57ed3a5bbfcbd956d3d451b3158968faace9": "Transfer",
  "0xf6d2c55c8d7458b3b22f5534fd41ebe91e2a7da94922c17c1fe9e4d209dca04a": "Approval",
  "0x28862e7805ae53ee989ad468b1843e931598e3ac6df1e691796983fffb198950": "ApprovalForAll",
  "0xb9bd49522586e066622eaf610f7f98f97af55571f0361ee042033b555811f344": "TransferSingle",
  "0x8b3c3daa1d92cee07428f2119de551c7a1ea39c8200b79a5cf1cb1a2b2b4fb4d": "PairCreated"
});

export function shorten(value: string, leading = 8, trailing = 6): string {
  if (value.length <= leading + trailing + 3) return value;
  return `${value.slice(0, leading)}…${value.slice(-trailing)}`;
}

export function formatInteger(value: bigint | number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatToken(value: bigint, decimals = 18, fractionDigits = 6): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const remainder = absolute % scale;
  const fraction = remainder.toString().padStart(decimals, "0").slice(0, fractionDigits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString()}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

export function recordName(record: VMRecord): string {
  if (record.kind === "worldExecution") return "WorldExecution";
  if (record.kind === "miniContractDeployed") return "MiniContractDeployed";
  return APPLICATION_NAMES[record.topics[0]?.toLowerCase() ?? ""] ?? "Application record";
}

export function copyText(value: string): Promise<void> {
  return navigator.clipboard.writeText(value);
}
