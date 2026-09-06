import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const fixtureRoot = resolve(packageRoot, "fixtures");
const scenarios = [
  "unsigned-nop",
  "authenticated-call",
  "deploy",
  "src20-transfer",
  "src721-transfer",
  "cpamm-swap"
];

function topics(packed, count) {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(packed) || packed.length !== 2 + count * 64) {
    throw new Error(`invalid packed topics: count=${count}`);
  }
  return Array.from({ length: count }, (_, index) =>
    `0x${packed.slice(2 + index * 64, 2 + (index + 1) * 64)}`
  );
}

for (const scenario of scenarios) {
  const raw = JSON.parse(await readFile(resolve(fixtureRoot, "raw", `${scenario}.json`), "utf8"));
  const count = Number(raw.recordCount);
  const fields = ["recordLengths", "emitters", "topicCounts", "topicsPacked", "dataLengths", "data"];
  for (const field of fields) {
    if (!Array.isArray(raw[field]) || raw[field].length !== count) throw new Error(`${scenario}: invalid ${field}`);
  }
  const records = Array.from({ length: count }, (_, index) => ({
    index,
    recordLength: Number(raw.recordLengths[index]),
    emitter: raw.emitters[index],
    topicCount: Number(raw.topicCounts[index]),
    topics: topics(raw.topicsPacked[index], Number(raw.topicCounts[index])),
    dataLength: Number(raw.dataLengths[index]),
    data: raw.data[index]
  }));
  const fixture = {
    scenario: raw.scenario,
    worldId: raw.worldId,
    executionHeight: Number(raw.executionHeight),
    payload: raw.payload,
    recordCount: count,
    records,
    expectedRecordOrder: raw.expectedRecordOrder
  };
  const generated = `${JSON.stringify(fixture, null, 2)}\n`;
  const destination = resolve(fixtureRoot, `${scenario}.json`);
  if (process.argv.includes("--check")) {
    const current = await readFile(destination, "utf8");
    if (current !== generated) throw new Error(`${scenario}: materialized fixture is stale`);
  } else {
    await writeFile(destination, generated);
  }
}
