import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { browserErrorLines, CLI_VERSION, executeBrowserCommand } from "../src/browser.js";

const PAYLOAD = "0x0100000100000105ff00000000000000000000000000000000000000000000000000000000000001013112cedead241c6530b184adc877ddaf0a4157aa13a4a0988b4bde6ce794defc000000c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000e8d4a510000000000000000000000000000000000000000000000000000dd60d504991f6f10000000000000000000000000000000000000000000000000dd60c6774ece6f1";

test("browser commands expose help and the package version", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.match((await executeBrowserCommand("help")).lines.join("\n"), /inspect <transaction-hash>/);
  assert.equal(CLI_VERSION, manifest.version);
  assert.deepEqual((await executeBrowserCommand("version")).lines, [`@swaputer-labs/cli ${manifest.version}`]);
  assert.equal((await executeBrowserCommand("clear")).clear, true);
});

test("browser command decodes receipts with the same codec as the CLI", async () => {
  assert.match((await executeBrowserCommand(`decode-receipt ${PAYLOAD}`)).lines[0] ?? "", /Valid VMReceiptV1: records=1 bytes=1/);
  await assert.rejects(() => executeBrowserCommand("unknown"), (error: unknown) => browserErrorLines(error)[0] === 'error: CLI_USAGE {"command":"unknown"}');
});
