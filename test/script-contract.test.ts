import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

const root = process.cwd();

function globPattern(name: string): RegExp {
  const escaped = name.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "u");
}

test("every npm script test path exists and integration smokes stay separate", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};
  const references: Array<{ script: string; path: string }> = [];
  for (const [script, command] of Object.entries(scripts)) {
    for (const match of command.matchAll(/(?:^|\s)(test\/[^\s;&|]+)/gu)) {
      const path = match[1]?.replace(/^['"]|['"]$/gu, "");
      if (path) references.push({ script, path });
    }
  }
  assert.ok(references.length > 0, "package scripts contain no test paths");

  for (const reference of references) {
    if (!reference.path.includes("*") && !reference.path.includes("?")) {
      await access(join(root, reference.path));
      continue;
    }
    const directory = join(root, dirname(reference.path));
    const pattern = globPattern(basename(reference.path));
    const matches = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && pattern.test(entry.name));
    assert.ok(matches.length > 0, `${reference.script} pattern ${reference.path} matches no test file`);
  }

  assert.equal(scripts["test:package"], "node test/package-smoke.integration.mjs");
  assert.equal(
    scripts["test:host"],
    "node --experimental-strip-types --test test/actual-host.integration.ts",
  );
  assert.doesNotMatch(scripts.test ?? "", /\.integration\.(?:[cm]?js|ts)\b/u);
  assert.doesNotMatch(scripts["test:package"] ?? "", /actual-host/u);
  assert.doesNotMatch(scripts["test:host"] ?? "", /package-smoke/u);
});
