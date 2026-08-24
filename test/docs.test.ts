import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const markdownFiles = [
  "README.md",
  "README.ko.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "docs/MULTI_POOL.md",
  "docs/PI_INTERNALS.md",
  "docs/SECRETS.md",
];

async function text(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

test("release-facing metadata agrees on Pi v0.4.0", async () => {
  const manifest = JSON.parse(await text("package.json")) as { name: string; version: string };
  const schema = JSON.parse(await text("docs/key-rotator.schema.json")) as {
    $id: string;
    title: string;
    description: string;
  };
  assert.equal(manifest.name, "pi-api-key-rotator");
  assert.equal(manifest.version, "0.4.0");
  assert.match(await text("README.md"), /Pi `0\.84\.2`/);
  assert.match(await text("README.ko.md"), /Pi `0\.84\.2`/);
  assert.match(await text("CHANGELOG.md"), /^## \[0\.4\.0\]/m);
  assert.match(schema.$id, /pi-api-key-rotator\/v0\.4\.0\/docs\/key-rotator\.schema\.json$/);
  assert.equal(schema.title, "pi-api-key-rotator configuration");
  assert.match(schema.description, /PI_CODING_AGENT_DIR/);
});

test("documentation uses Pi paths and has no stale Prime package identity", async () => {
  const forbidden = [
    "~/.prime/",
    "PRIME_KEY_ROTATOR_CONFIG",
    "PRIME_AGENT_CODING_AGENT_DIR",
    "prime-api-key-rotator",
    "prime-agent",
    "v0.5.0",
  ];
  for (const path of markdownFiles) {
    const contents = await text(path);
    for (const value of forbidden) {
      assert.equal(contents.includes(value), false, `${path} contains stale ${value}`);
    }
  }
  assert.match(await text("README.md"), /PI_CODING_AGENT_DIR/);
  assert.match(await text("README.md"), /PI_KEY_ROTATOR_CONFIG/);
  assert.match(await text("README.md"), /pi install git:github\.com\/sehoon123\/pi-api-key-rotator@v0\.4\.0/);
});

test("relative Markdown links resolve inside the repository", async () => {
  for (const path of markdownFiles) {
    const contents = await text(path);
    for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]?.trim();
      if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const file = target.split("#", 1)[0];
      if (!file) continue;
      await access(resolve(root, dirname(path), file));
    }
  }
});


test("quick start uses a reachable pinned example and documents real path/environment behavior", async () => {
  const english = await text("README.md");
  const korean = await text("README.ko.md");
  for (const contents of [english, korean]) {
    assert.doesNotMatch(contents, /cp examples\//u);
    assert.match(
      contents,
      /raw\.githubusercontent\.com\/sehoon123\/pi-api-key-rotator\/v0\.4\.0\/examples\/key-rotator\.literal\.example\.json/u,
    );
    assert.match(contents, /\[.*key-rotator\.env\.example\.json.*\]\(examples\/key-rotator\.env\.example\.json\)/u);
    assert.match(contents, /PI_KEY_ROTATOR_CONFIG/);
    assert.match(contents, /working directory/u);
    assert.match(contents, /<agent dir>\/models\.json/u);
  }
  const auditedPaths = markdownFiles.filter((path) => path !== "SECURITY.md");
  assert.doesNotMatch((await Promise.all(auditedPaths.map(text))).join("\n"), /explicit loader (?:option|path)/u);
});

test("request-fence and doctor claims stay within what Pi 0.84.2 proves", async () => {
  const english = await text("README.md");
  const internals = await text("docs/PI_INTERNALS.md");
  const changelog = await text("CHANGELOG.md");
  const security = await text("SECURITY.md");
  assert.match(english, /public post-bind provider-registration evidence/u);
  assert.match(english, /A Pi\s+version without both public lookup methods reports `WARN`/u);
  assert.match(english, /cannot contain a malicious trusted extension or provider/u);
  assert.match(internals, /does\s+not definitively reject duplicate provider registrations/u);
  assert.match(internals, /getRegisteredProviderConfig\(\).*getRegisteredNativeProvider\(\)/su);
  assert.match(internals, /no physical request and consumes no pool attempt/u);
  assert.match(changelog, /A request-boundary violation latches until reload/u);
  assert.match(security, /scoped to Pi's verified `AgentSession` lifecycle pipeline/u);
});
