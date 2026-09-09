#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = resolve(repositoryRoot, "release/npm/packages.json");
const publicationPath = resolve(repositoryRoot, "release/npm/swaputer-labs-publication.json");
const defaultOutput = resolve(repositoryRoot, "artifacts/npm");
const PACKAGE_SCOPE = "@swaputer-labs/";
const PACKAGE_NAME = /^@swaputer-labs\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_PACKAGE_NAMES = new Set([
  "@swaputer-labs/receipt-codec",
  "@swaputer-labs/tinysol",
  "@swaputer-labs/cli"
]);
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".map", ".md", ".ts", ".sol"]);
const MIT_LICENSE = `MIT License

Copyright (c) 2026 Swaputer contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function fail(message) {
  throw new Error(message);
}

function parseArguments(arguments_) {
  let output = defaultOutput;
  let config = defaultConfigPath;
  let skipTests = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--skip-tests") {
      skipTests = true;
      continue;
    }
    if (argument === "--output") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) fail("--output requires a directory");
      output = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--config") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) fail("--config requires a JSON file");
      config = resolve(value);
      if (config === repositoryRoot || !config.endsWith(".json")) fail("--config must identify a JSON file");
      index += 1;
      continue;
    }
    fail(`unknown argument: ${argument}`);
  }
  if (output === repositoryRoot || !relative(repositoryRoot, output)) fail("refusing to use the repository root as output");
  return { config, output, skipTests };
}

function object(value, field) {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${field} must be an object`);
  return value;
}

function string(value, field) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must be a non-empty array`);
  return value.map((entry, index) => string(entry, `${field}[${index}]`));
}

function safeRelativePath(value, field) {
  const path = string(value, field);
  if (!SAFE_PATH.test(path) || path.startsWith("/") || path.split("/").includes("..") || path.includes("//")) fail(`${field} is not a safe relative path`);
  return path;
}

export function validateConfig(raw) {
  const config = object(raw, "config");
  if (config.schemaVersion !== "swaputer-npm-release/1") fail("unsupported npm release schema");
  if (!["prepared-not-published", "published", "unpublished"].includes(config.status)) fail("invalid npm release status");
  if (config.registry !== "https://registry.npmjs.org") fail("unexpected npm registry");
  if (config.license !== "MIT") fail("the npm package license must be MIT");
  if (!Array.isArray(config.packages) || config.packages.length < 1 || config.packages.length > ALLOWED_PACKAGE_NAMES.size) {
    fail("between one and three packages are required");
  }
  const seen = new Set();
  const packages = config.packages.map((rawPackage, index) => {
    const entry = object(rawPackage, `packages[${index}]`);
    const name = string(entry.name, `packages[${index}].name`);
    const version = string(entry.version, `packages[${index}].version`);
    if (!PACKAGE_NAME.test(name) || !ALLOWED_PACKAGE_NAMES.has(name)) fail(`package is not allowlisted: ${name}`);
    if (!SEMVER.test(version)) fail(`invalid package version: ${version}`);
    if (seen.has(name)) fail(`duplicate package: ${name}`);
    seen.add(name);
    const dependencies = object(entry.dependencies, `packages[${index}].dependencies`);
    for (const [dependency, dependencyVersion] of Object.entries(dependencies)) {
      if (typeof dependencyVersion !== "string" || !SEMVER.test(dependencyVersion)) fail(`dependency ${dependency} must use an exact version`);
    }
    return {
      sourceDirectory: safeRelativePath(entry.sourceDirectory, `packages[${index}].sourceDirectory`),
      name,
      version,
      description: string(entry.description, `packages[${index}].description`),
      keywords: stringArray(entry.keywords, `packages[${index}].keywords`),
      include: stringArray(entry.include, `packages[${index}].include`).map((path, includeIndex) => safeRelativePath(path, `packages[${index}].include[${includeIndex}]`)),
      dependencies
    };
  });
  return { license: config.license, registry: config.registry, status: config.status, packages };
}

function validatePublication(raw, registry) {
  const publication = object(raw, "publication");
  if (publication.schemaVersion !== "swaputer-npm-publication/2") fail("unsupported npm publication schema");
  if (publication.registry !== registry) fail("npm release and publication registries differ");
  if (publication.status !== "published") fail("npm publication evidence must have published status");
  if (!Array.isArray(publication.packages) || publication.packages.length === 0) fail("npm publication evidence has no packages");
  const identities = new Set();
  for (const [index, rawPackage] of publication.packages.entries()) {
    const entry = object(rawPackage, `publication.packages[${index}]`);
    const name = string(entry.name, `publication.packages[${index}].name`);
    const version = string(entry.version, `publication.packages[${index}].version`);
    if (!PACKAGE_NAME.test(name) || !ALLOWED_PACKAGE_NAMES.has(name)) fail(`published package is not allowlisted: ${name}`);
    if (!SEMVER.test(version)) fail(`invalid published package version: ${version}`);
    if (entry.status !== "published") fail(`publication entry is not published: ${name}@${version}`);
    const identity = `${name}@${version}`;
    if (identities.has(identity)) fail(`duplicate published package identity: ${identity}`);
    identities.add(identity);
  }
  return identities;
}

export function assertNoPublishedIdentityReuse(config, rawPublication) {
  const published = validatePublication(rawPublication, config.registry);
  const collisions = config.packages
    .map((entry) => `${entry.name}@${entry.version}`)
    .filter((identity) => published.has(identity))
    .sort();
  if (collisions.length > 0) {
    fail(`refusing to prepare already-published npm identities: ${collisions.join(", ")}; create a new release config with unused versions`);
  }
  if (config.status !== "prepared-not-published") {
    fail("only a prepared-not-published release plan may create npm tarballs");
  }
}

export function assertRegistryIdentitiesUnused(config, runner = spawnSync) {
  for (const entry of config.packages) {
    const identity = `${entry.name}@${entry.version}`;
    const result = runner("npm", ["view", identity, "version", "--json", "--registry", config.registry], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status === 0) fail(`refusing to prepare npm identity that already exists in the registry: ${identity}`);
    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (!/(?:E404|404 Not Found)/i.test(diagnostic)) fail(`npm registry availability check failed for ${identity}`);
  }
}

function run(command, arguments_, cwd, capture = false) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.status !== 0) fail(`${command} ${arguments_.join(" ")} failed${capture ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout ?? "";
}

async function assertNoSymlinks(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) fail(`${label} contains a symlink: ${path}`);
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(path)) await assertNoSymlinks(join(path, entry), label);
}

async function listFiles(path, root = path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(absolute, root));
    else if (entry.isFile()) output.push(relative(root, absolute).split(sep).join("/"));
    else fail(`unsupported filesystem entry: ${absolute}`);
  }
  return output.sort();
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index);
}

async function scanStaging(stage) {
  const files = await listFiles(stage);
  const forbiddenNames = /(^|\/)(?:\.env(?:\..*)?|wallet\.txt|npmrc|.*\.(?:pem|key|keystore|p12|pfx))$/i;
  const forbiddenContent = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
    /https?:\/\/[^\s"']*(?:alchemy|infura|quicknode)[^\s"']*/i,
    /(?:api[_-]?key|private[_-]?key|secret|bearer)\s*[:=]\s*["'][^"']{8,}["']/i,
    /\/(?:Users|home)\/[A-Za-z0-9._-]+\//
  ];
  for (const file of files) {
    if (forbiddenNames.test(file)) fail(`forbidden file in package: ${file}`);
    if (!TEXT_EXTENSIONS.has(extension(file)) && basename(file) !== "README" && basename(file) !== "LICENSE") continue;
    const contents = await readFile(join(stage, file), "utf8");
    for (const pattern of forbiddenContent) if (pattern.test(contents)) fail(`sensitive-looking content in ${file}: ${pattern}`);
  }
  return files;
}

function publicManifest(source, entry, license) {
  if (source.private !== true) fail(`${entry.sourceDirectory} must remain private in the source tree`);
  if (source.name !== entry.name || source.version !== entry.version) fail(`${entry.name} source name/version drift`);
  const manifest = {
    name: entry.name,
    version: entry.version,
    description: entry.description,
    license,
    repository: {
      type: "git",
      url: "git+https://github.com/swaputer/tooling.git",
      directory: entry.sourceDirectory
    },
    homepage: `https://github.com/swaputer/tooling/tree/main/${entry.sourceDirectory}#readme`,
    keywords: entry.keywords,
    type: source.type,
    main: source.main,
    types: source.types,
    exports: source.exports,
    files: [...entry.include, "LICENSE"],
    sideEffects: false,
    dependencies: entry.dependencies,
    engines: source.engines,
    publishConfig: { access: "public" }
  };
  if (source.bin !== undefined) manifest.bin = source.bin;
  return manifest;
}

function gitMetadata() {
  const commit = run("git", ["rev-parse", "HEAD"], repositoryRoot, true).trim();
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], repositoryRoot, true);
  return { commit, dirty: status.length > 0 };
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function preparePackage(entry, config, stagingRoot, output, skipTests) {
  const sourceDirectory = resolve(repositoryRoot, entry.sourceDirectory);
  const sourceManifest = JSON.parse(await readFile(join(sourceDirectory, "package.json"), "utf8"));
  run("npm", ["run", skipTests ? "build" : "test"], sourceDirectory);
  const stage = join(stagingRoot, entry.name.slice(PACKAGE_SCOPE.length));
  await mkdir(stage, { recursive: true });
  for (const include of entry.include) {
    const source = join(sourceDirectory, include);
    await assertNoSymlinks(source, entry.name);
    await cp(source, join(stage, include), { recursive: true, errorOnExist: true });
  }
  const manifest = publicManifest(sourceManifest, entry, config.license);
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await writeFile(join(stage, "LICENSE"), MIT_LICENSE, { mode: 0o644 });
  const stagedFiles = await scanStaging(stage);
  if (manifest.bin !== undefined) {
    for (const binPath of Object.values(manifest.bin)) {
      const absolute = join(stage, binPath);
      const contents = await readFile(absolute, "utf8");
      if (!contents.startsWith("#!/usr/bin/env node\n")) fail(`${entry.name} binary lacks a Node shebang: ${binPath}`);
    }
  }
  const raw = run("npm", ["pack", stage, "--json", "--ignore-scripts", "--pack-destination", output], repositoryRoot, true);
  const packed = JSON.parse(raw);
  if (!Array.isArray(packed) || packed.length !== 1) fail(`unexpected npm pack result for ${entry.name}`);
  const result = packed[0];
  if (result.name !== entry.name || result.version !== entry.version) fail(`npm pack identity mismatch for ${entry.name}`);
  const packedFiles = result.files.map((file) => file.path).sort();
  const expectedFiles = stagedFiles;
  if (JSON.stringify(packedFiles) !== JSON.stringify(expectedFiles)) fail(`npm pack file-list drift for ${entry.name}`);
  const tarball = resolve(output, result.filename);
  return {
    name: entry.name,
    version: entry.version,
    sourceDirectory: entry.sourceDirectory,
    tarball: result.filename,
    sha256: await sha256(tarball),
    integrity: result.integrity,
    fileCount: result.entryCount,
    unpackedSize: result.unpackedSize,
    files: packedFiles
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = validateConfig(JSON.parse(await readFile(options.config, "utf8")));
  const publication = JSON.parse(await readFile(publicationPath, "utf8"));
  assertNoPublishedIdentityReuse(config, publication);
  assertRegistryIdentitiesUnused(config);
  if (options.output === defaultOutput) await rm(options.output, { recursive: true, force: true });
  await mkdir(options.output, { recursive: true });
  const existingOutput = await readdir(options.output);
  if (existingOutput.length !== 0) fail(`output directory must be empty: ${options.output}`);
  const stagingRoot = await mkdtemp(join(tmpdir(), "swaputer-npm-"));
  try {
    const packages = [];
    for (const entry of config.packages) packages.push(await preparePackage(entry, config, stagingRoot, options.output, options.skipTests));
    const evidence = {
      schemaVersion: "swaputer-npm-package-evidence/1",
      status: config.status,
      published: config.status === "published",
      registry: config.registry,
      license: config.license,
      generatedAt: new Date().toISOString(),
      source: gitMetadata(),
      packages
    };
    await writeFile(join(options.output, "npm-package-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
    process.stdout.write(`Prepared ${packages.length} publication-ready npm tarballs in ${options.output}\n`);
    for (const package_ of packages) process.stdout.write(`${package_.name}@${package_.version} ${package_.tarball} sha256=${package_.sha256}\n`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`npm package preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
