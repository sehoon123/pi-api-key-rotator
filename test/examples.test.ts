import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import type { RawRotatorConfig } from "../src/types.ts";

async function readExample(name: string): Promise<RawRotatorConfig> {
  const text = await readFile(join(process.cwd(), name), "utf8");
  return JSON.parse(text) as RawRotatorConfig;
}

test("packaged environment-variable example remains valid", async () => {
  const raw = await readExample("config.example.json");
  const config = resolveConfig(raw, {
    configFile: "/tmp/config.example.json",
    homeDir: "/tmp",
    env: {
      MY_COMPANY_API_KEY_1: "example-secret-1",
      MY_COMPANY_API_KEY_2: "example-secret-2",
      MY_COMPANY_API_KEY_3: "example-secret-3",
    },
  });
  assert.equal(config.targets?.length, 1);
  assert.equal(config.keys.length, 3);
});

test("packaged literal example remains valid", async () => {
  const raw = await readExample("config.literal.example.json");
  const config = resolveConfig(raw, {
    configFile: "/tmp/config.literal.example.json",
    homeDir: "/tmp",
    env: {},
  });
  assert.equal(config.targets?.length, 1);
  assert.ok(config.keys.every((key) => key.source === "literal"));
});

test("packaged IBM ICA example registers both required adapters in one pool", async () => {
  const raw = await readExample("config.ibm-ica.example.json");
  const config = resolveConfig(raw, {
    configFile: "/tmp/config.ibm-ica.example.json",
    homeDir: "/tmp",
    env: {},
  });

  assert.equal(config.poolId, "ibm-ica-shared");
  assert.deepEqual(config.targets, [
    { provider: "ibm-ica-claude", api: "anthropic-messages" },
    { provider: "ibm-ica", api: "openai-completions" },
  ]);
  assert.equal(config.keys.length, 3);
});
