import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

// Patched Node releases reject direct .cmd spawning on Windows. Invoke npm's
// bundled JavaScript entry through Node instead of enabling a shell.
const npmInvocation = process.platform === "win32"
  ? {
      command: process.execPath,
      prefixArgs: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")],
    }
  : { command: "npm", prefixArgs: [] };

function runNpm(args, options = {}) {
  return run(npmInvocation.command, [...npmInvocation.prefixArgs, ...args], options);
}

const requiredFiles = [
  "package.json",
  "src/index.ts",
  "README.md",
  "README.ko.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/key-rotator.schema.json",
  "docs/MULTI_POOL.md",
  "docs/PI_INTERNALS.md",
  "docs/SECRETS.md",
  "examples/key-rotator.command.example.json",
  "examples/key-rotator.env.example.json",
  "examples/key-rotator.ibm-ica.example.json",
  "examples/key-rotator.literal.example.json",
  "examples/key-rotator.multi-pool.example.json",
];

function isForbidden(path) {
  const name = basename(path);
  return path.startsWith("test/") ||
    path.startsWith("node_modules/") ||
    path.startsWith(".github/") ||
    name === "key-rotator.json" ||
    name.endsWith(".state.json") ||
    name.includes(".state.json.") ||
    name.endsWith(".secrets.json") ||
    name === ".env";
}

const root = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "pi-rotator-pack-"));
try {
  const packed = JSON.parse(
    await runNpm(["pack", "--json", "--pack-destination", directory], { cwd: root }),
  );
  const filename = packed[0]?.filename;
  assert.equal(typeof filename, "string");
  const files = new Set((packed[0]?.files ?? []).map((entry) => entry.path));
  for (const required of requiredFiles) {
    assert.ok(files.has(required), `packed tarball is missing ${required}`);
  }
  assert.ok(![...files].some(isForbidden), "packed tarball contains a test, local config, or state artifact");

  const consumer = join(directory, "consumer");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(consumer));
  await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  const tarball = join(directory, filename);
  await runNpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--legacy-peer-deps",
      "--cache",
      join(directory, "cache"),
      tarball,
    ],
    { cwd: consumer },
  );

  const installedRoot = join(consumer, "node_modules", "pi-api-key-rotator");
  const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  assert.deepEqual(installedPackage.dependencies ?? {}, {});
  assert.deepEqual(installedPackage.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
  });
  assert.deepEqual(installedPackage.devDependencies, {
    "@earendil-works/pi-ai": "0.84.2",
    "@earendil-works/pi-coding-agent": "0.84.2",
    "@types/node": "22.19.0",
    typescript: "5.9.3",
  });
  assert.deepEqual(installedPackage.pi?.extensions, ["./src/index.ts"]);

  // The consumer install deliberately omits peers. Pi supplies its bundled core
  // modules through the extension loader; the package must not vendor a second copy.
  await assert.rejects(readFile(join(consumer, "node_modules", "@earendil-works", "pi-ai", "package.json")));

  // Node refuses native TypeScript stripping below node_modules. Stage a host-
  // independent packed module outside that boundary to catch missing relative imports.
  const stagedSource = join(consumer, "packed-source");
  await cp(join(installedRoot, "src"), stagedSource, { recursive: true });
  const moduleUrl = pathToFileURL(join(stagedSource, "key-pool.ts")).href;
  await run(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`],
    { cwd: consumer },
  );
  process.stdout.write("package/offline smoke passed\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
