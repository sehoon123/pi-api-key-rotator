import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigNotFoundError, ConfigValidationError, loadConfig, resolveConfig } from "../src/config.ts";
import type { RawRotatorConfig } from "../src/types.ts";

const validRaw: RawRotatorConfig = {
  provider: "company-ai",
  api: "openai-completions",
  keys: [
    { id: "primary", env: "KEY_ONE" },
    { id: "secondary", env: "KEY_TWO" },
  ],
  requestsPerKey: 7,
};

test("loadConfig resolves key values and a provider-scoped state file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-config-"));
  const configFile = join(directory, "key-rotator.json");
  await writeFile(configFile, JSON.stringify(validRaw), "utf8");

  try {
    const config = await loadConfig({
      configFile,
      homeDir: directory,
      env: { KEY_ONE: "one-secret", KEY_TWO: "two-secret" },
    });

    assert.equal(config.provider, "company-ai");
    assert.equal(config.api, "openai-completions");
    assert.equal(config.requestsPerKey, 7);
    assert.equal(config.maxAttemptsPerRequest, 2);
    assert.deepEqual(
      config.keys.map(({ id, env, value }) => ({ id, env, value })),
      [
        { id: "primary", env: "KEY_ONE", value: "one-secret" },
        { id: "secondary", env: "KEY_TWO", value: "two-secret" },
      ],
    );
    assert.equal(config.stateFile, join(directory, ".pi", "agent", "key-rotator-company-ai.state.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadConfig reports a missing configuration file distinctly", async () => {
  const missing = join(tmpdir(), `missing-${crypto.randomUUID()}.json`);
  await assert.rejects(
    () => loadConfig({ configFile: missing, env: {}, homeDir: tmpdir() }),
    (error: unknown) => error instanceof ConfigNotFoundError && error.configFile === missing,
  );
});

test("resolveConfig rejects missing environment variables without exposing secret values", () => {
  assert.throws(
    () =>
      resolveConfig(validRaw, {
        configFile: "/tmp/config.json",
        homeDir: "/tmp",
        env: { KEY_ONE: "present" },
      }),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      error.message.includes("KEY_TWO") &&
      !error.message.includes("present"),
  );
});

test("resolveConfig rejects duplicate secret values", () => {
  assert.throws(
    () =>
      resolveConfig(validRaw, {
        configFile: "/tmp/config.json",
        homeDir: "/tmp",
        env: { KEY_ONE: "same-secret", KEY_TWO: "same-secret" },
      }),
    /same secret value/i,
  );
});

test("disable and cooldown statuses must also be retry statuses", () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          ...validRaw,
          retryStatuses: [429],
          disableStatuses: [401],
          cooldownStatuses: [429],
        },
        {
          configFile: "/tmp/config.json",
          homeDir: "/tmp",
          env: { KEY_ONE: "one", KEY_TWO: "two" },
        },
      ),
    /must also appear in "retryStatuses"/,
  );
});

test("stateFile can be relative to the configuration directory", () => {
  const config = resolveConfig(
    { ...validRaw, stateFile: "runtime/state.json" },
    {
      configFile: "/opt/pi/key-rotator.json",
      homeDir: "/home/tester",
      env: { KEY_ONE: "one", KEY_TWO: "two" },
    },
  );
  assert.equal(config.stateFile, "/opt/pi/runtime/state.json");
});
