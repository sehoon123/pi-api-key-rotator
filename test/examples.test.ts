import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { POOL_FIELDS, resolveCommandKeys, resolveConfig } from "../src/config.ts";
import { resolveConfigSet } from "../src/config-set.ts";
import type { RawRotatorConfig } from "../src/types.ts";

const EXAMPLES = join(process.cwd(), "examples");

async function readExample(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(EXAMPLES, name), "utf8")) as unknown;
}

test("the environment-variable example stays valid", async () => {
  const raw = (await readExample("key-rotator.env.example.json")) as RawRotatorConfig;
  const config = resolveConfig(raw, {
    configFile: "/tmp/key-rotator.json",
    homeDir: "/tmp/home",
    env: {
      MY_COMPANY_API_KEY_1: "example-secret-1",
      MY_COMPANY_API_KEY_2: "example-secret-2",
      MY_COMPANY_API_KEY_3: "example-secret-3",
    },
  });
  assert.equal(config.targets?.length, 1);
  assert.equal(config.keys.length, 3);
  assert.ok(config.keys.every((key) => key.source === "env"));
  assert.equal(config.stateFile, resolve("/tmp/home/.pi/agent/key-rotator-my-company-ai.state.json"));
});

test("the literal example stays valid and carries only placeholders", async () => {
  const text = await readFile(join(EXAMPLES, "key-rotator.literal.example.json"), "utf8");
  assert.match(text, /REPLACE-ME/);
  const config = resolveConfig(JSON.parse(text) as RawRotatorConfig, {
    configFile: "/tmp/key-rotator.json",
    homeDir: "/tmp/home",
    env: {},
  });
  assert.ok(config.keys.every((key) => key.source === "literal"));
  assert.ok(config.keys.every((key) => key.value.startsWith("sk-REPLACE-ME-")));
});

test("the command example resolves through an injected runner", async () => {
  const raw = (await readExample("key-rotator.command.example.json")) as RawRotatorConfig;
  const config = resolveConfig(raw, {
    configFile: "/tmp/key-rotator.json",
    homeDir: "/tmp/home",
    env: {},
  });
  assert.ok(config.keys.every((key) => key.source === "command"));
  assert.ok(config.keys.every((key) => key.value === ""));

  const commands: string[] = [];
  await resolveCommandKeys(config, {
    runCommand: async (command) => {
      commands.push(command);
      return { stdout: `resolved-${commands.length}\n`, code: 0, timedOut: false };
    },
  });
  assert.deepEqual(commands, [
    "op read op://Private/my-company-ai/key-1",
    "op read op://Private/my-company-ai/key-2",
  ]);
  assert.deepEqual(
    config.keys.map((key) => key.value),
    ["resolved-1", "resolved-2"],
  );
});

test("the IBM ICA example registers both Pi adapters in one pool", async () => {
  const raw = (await readExample("key-rotator.ibm-ica.example.json")) as RawRotatorConfig;
  const config = resolveConfig(raw, {
    configFile: "/tmp/key-rotator.json",
    homeDir: "/tmp/home",
    env: {},
  });
  assert.equal(config.poolId, "ibm-ica-shared");
  assert.deepEqual(config.targets, [
    { provider: "ibm-ica-claude", api: "anthropic-messages" },
    { provider: "ibm-ica", api: "openai-completions" },
  ]);
  assert.equal(config.keys.length, 3);
});

test("the multi-pool example defines two independent pools", async () => {
  const set = resolveConfigSet(await readExample("key-rotator.multi-pool.example.json"), {
    configFile: "/tmp/key-rotator.json",
    homeDir: "/tmp/home",
    env: {},
  });
  assert.deepEqual(
    set.pools.map((pool) => pool.poolId),
    ["ibm-ica-primary", "ibm-ica-secondary"],
  );
  assert.deepEqual(
    set.pools.map((pool) => pool.requestsPerKey),
    [20, 10],
  );
  assert.notEqual(set.pools[0]?.stateFile, set.pools[1]?.stateFile);
});

test("no packaged example contains a plausible real key", async () => {
  const names = [
    "key-rotator.env.example.json",
    "key-rotator.literal.example.json",
    "key-rotator.command.example.json",
    "key-rotator.multi-pool.example.json",
    "key-rotator.ibm-ica.example.json",
  ];
  for (const name of names) {
    const text = await readFile(join(EXAMPLES, name), "utf8");
    // A real key is long and random. Every literal here must be a placeholder.
    for (const match of text.matchAll(/"value":\s*"([^"]*)"/g)) {
      assert.match(match[1] ?? "", /REPLACE-ME/, `${name} has a non-placeholder value`);
    }
  }
});


test("the published JSON schema tracks every accepted pool field", async () => {
  const schema = JSON.parse(await readFile(join(process.cwd(), "docs", "key-rotator.schema.json"), "utf8")) as {
    $defs: { pool: { properties: Record<string, unknown> } };
  };
  assert.deepEqual(Object.keys(schema.$defs.pool.properties).sort(), [...POOL_FIELDS].sort());
  assert.equal(Object.hasOwn(schema.$defs.pool.properties, "configVersion"), false);
});
