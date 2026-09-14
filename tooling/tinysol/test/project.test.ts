import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { compileTinySolProject } from "../src/project.js";
import { ToolchainErrorCode, isToolchainError } from "../src/errors.js";

async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tinysol-project-"));
  for (const [name, source] of Object.entries(files)) { await mkdir(join(root, name, "..").replace(/\/[^/]+\/\.\.$/, ""), { recursive: true }).catch(() => undefined); await mkdir(join(root, name.split("/").slice(0, -1).join("/")), { recursive: true }); await writeFile(join(root, name), source); }
  return root;
}

async function code(root: string, entry = "Main.tiny.sol"): Promise<string> {
  try { await compileTinySolProject({ projectRoot: root, entry }); return "NO_ERROR"; } catch (error) { return isToolchainError(error) ? error.code : "UNKNOWN"; }
}

describe("deterministic TinySol projects", () => {
  it("resolves local modules and statically links pure libraries", async () => {
    const files = {
      "lib/Math.tiny.sol": "library Math { function add(uint256 a, uint256 b) pure returns(uint256) { return a + b; } }",
      "Main.tiny.sol": "import \"./lib/Math.tiny.sol\"; contract Main { function sum(uint256 a, uint256 b) view returns(uint256) { return Math.add(a, b); } }"
    };
    const firstRoot = await project(files); const secondRoot = await project(files);
    const first = await compileTinySolProject({ projectRoot: firstRoot, entry: "Main.tiny.sol" });
    const second = await compileTinySolProject({ projectRoot: secondRoot, entry: "Main.tiny.sol" });
    assert.deepEqual(first.modules, ["Main.tiny.sol", "lib/Math.tiny.sol"]);
    assert.match(first.bundledSource, /function Math_add/);
    assert.deepEqual(first.packageBytes, second.packageBytes);
    assert.equal(first.abi.abiCanonical, second.abi.abiCanonical);
  });

  it("rejects cycles, non-relative imports, root escapes and mutable libraries", async () => {
    const cycle = await project({ "A.tiny.sol": "import \"./B.tiny.sol\"; contract A {}", "B.tiny.sol": "import \"./A.tiny.sol\";" });
    assert.equal(await code(cycle, "A.tiny.sol"), ToolchainErrorCode.IMPORT_CYCLE);
    const remote = await project({ "Main.tiny.sol": "import \"https://example.com/x\"; contract C {}" });
    assert.equal(await code(remote), ToolchainErrorCode.IMPORT_INVALID);
    const escape = await project({ "Main.tiny.sol": "import \"../outside.tiny.sol\"; contract C {}" });
    assert.equal(await code(escape), ToolchainErrorCode.IMPORT_OUTSIDE_ROOT);
    const mutable = await project({ "Bad.tiny.sol": "library Bad { uint256 value; }", "Main.tiny.sol": "import \"./Bad.tiny.sol\"; contract C {}" });
    assert.equal(await code(mutable), ToolchainErrorCode.LIBRARY_STATE);
  });

  it("resolves hash-pinned npm-style imports deterministically", async () => {
    const library = "library Math { function add(uint256 a,uint256 b) pure returns(uint256){ return a+b; } }";
    const hash = createHash("sha256").update(library).digest("hex");
    const root = await project({
      "node_modules/@tiny/math/Math.tiny.sol": library,
      "tinysol.lock.json": JSON.stringify({ version: 1, imports: { "@tiny/math": { path: "node_modules/@tiny/math/Math.tiny.sol", sha256: hash } } }),
      "Main.tiny.sol": "import \"@tiny/math\"; contract Main { function sum(uint256 a,uint256 b) view returns(uint256){ return Math.add(a,b); } }"
    });
    const result = await compileTinySolProject({ projectRoot: root, entry: "Main.tiny.sol" });
    assert.deepEqual(result.modules, ["Main.tiny.sol", "node_modules/@tiny/math/Math.tiny.sol"]);
    assert.equal(result.moduleHashes["node_modules/@tiny/math/Math.tiny.sol"], hash);
    assert.match(result.importLockHash, /^[0-9a-f]{64}$/);
    const tampered = await project({
      "node_modules/@tiny/math/Math.tiny.sol": `${library} `,
      "tinysol.lock.json": JSON.stringify({ version: 1, imports: { "@tiny/math": { path: "node_modules/@tiny/math/Math.tiny.sol", sha256: hash } } }),
      "Main.tiny.sol": "import \"@tiny/math\"; contract Main {}"
    });
    assert.equal(await code(tampered), ToolchainErrorCode.IMPORT_INVALID);
  });
});
