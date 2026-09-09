import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  assertNoPublishedIdentityReuse,
  assertRegistryIdentitiesUnused,
  publicManifest,
  validateConfig
} from "./prepare-npm-packages.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishedPlan = JSON.parse(await readFile(join(repositoryRoot, "release/npm/packages.json"), "utf8"));
const publication = JSON.parse(await readFile(join(repositoryRoot, "release/npm/swaputer-labs-publication.json"), "utf8"));
const receiptCodecPackage = JSON.parse(await readFile(join(repositoryRoot, "tooling/receipt-codec/package.json"), "utf8"));

test("published npm identities cannot be prepared again", () => {
  const config = validateConfig(publishedPlan);
  assert.throws(
    () => assertNoPublishedIdentityReuse(config, publication),
    /refusing to prepare already-published npm identities: @swaputer-labs\/cli@0\.1\.2, @swaputer-labs\/receipt-codec@0\.1\.2, @swaputer-labs\/tinysol@0\.3\.2/
  );
});

test("a future release plan may contain only the package being released", () => {
  const config = validateConfig({
    ...publishedPlan,
    status: "prepared-not-published",
    packages: [{ ...publishedPlan.packages[2], version: "0.1.3" }]
  });
  assert.equal(config.packages.length, 1);
  assert.doesNotThrow(() => assertNoPublishedIdentityReuse(config, publication));
});

test("future public manifests link to public documentation without private repository metadata", () => {
  const entry = {
    ...publishedPlan.packages[0],
    version: "0.1.3"
  };
  const source = {
    ...JSON.parse(JSON.stringify(publication.packages[0])),
    name: entry.name,
    version: entry.version,
    private: true,
    type: "module",
    main: "./dist/src/index.js",
    types: "./dist/src/index.d.ts",
    exports: {
      ".": {
        types: "./dist/src/index.d.ts",
        import: "./dist/src/index.js"
      }
    },
    engines: { node: ">=20" },
    repository: {
      type: "git",
      url: "git+https://github.com/swaputer/private-tooling.git"
    },
    bugs: { url: "https://github.com/swaputer/private-tooling/issues" }
  };

  const manifest = publicManifest(source, entry, "MIT");

  assert.equal(manifest.homepage, "https://docs.swaputer.xyz/developers/tooling-packages");
  assert.equal(Object.hasOwn(manifest, "repository"), false);
  assert.equal(Object.hasOwn(manifest, "bugs"), false);
});

test("local receipt-codec lockfile identities match the source package", async () => {
  const lockfiles = [
    ["apps/swaputer-inspector/package-lock.json", "../../tooling/receipt-codec"],
    ["tooling/indexer/package-lock.json", "../receipt-codec"]
  ];

  for (const [relativePath, packageKey] of lockfiles) {
    const lock = JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"));
    assert.equal(
      lock.packages?.[packageKey]?.version,
      receiptCodecPackage.version,
      `${relativePath} must identify the current local receipt-codec version`
    );
  }
});

test("only a pre-publication plan may create tarballs", () => {
  const config = validateConfig({
    ...publishedPlan,
    status: "published",
    packages: [{ ...publishedPlan.packages[2], version: "9.9.9" }]
  });
  assert.throws(
    () => assertNoPublishedIdentityReuse(config, publication),
    /only a prepared-not-published release plan may create npm tarballs/
  );
});

test("registry availability checks fail closed", () => {
  const config = validateConfig({
    ...publishedPlan,
    status: "prepared-not-published",
    packages: [{ ...publishedPlan.packages[2], version: "9.9.9" }]
  });
  assert.doesNotThrow(() => assertRegistryIdentitiesUnused(config, () => ({ status: 1, stdout: "", stderr: "npm error E404" })));
  assert.throws(
    () => assertRegistryIdentitiesUnused(config, () => ({ status: 0, stdout: '"9.9.9"', stderr: "" })),
    /identity that already exists in the registry/
  );
  assert.throws(
    () => assertRegistryIdentitiesUnused(config, () => ({ status: 1, stdout: "", stderr: "network timeout" })),
    /registry availability check failed/
  );
});

test("the guard rejects the historical plan before touching its output directory", async () => {
  const output = await mkdtemp(join(tmpdir(), "swaputer-npm-guard-"));
  const sentinel = join(output, "sentinel.txt");
  await writeFile(sentinel, "keep\n");
  try {
    const result = spawnSync(process.execPath, [
      join(repositoryRoot, "script/prepare-npm-packages.mjs"),
      "--config",
      join(repositoryRoot, "release/npm/packages.json"),
      "--output",
      output,
      "--skip-tests"
    ], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to prepare already-published npm identities/);
    assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
