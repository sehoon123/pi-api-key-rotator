import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigValidationError, loadConfig, resolveConfig } from "../src/config.ts";
import type { RawRotatorConfig } from "../src/types.ts";

const CONFIG_FILE = "/tmp/pi-key-rotator-test/key-rotator.json";
const HOME_DIR = "/tmp/pi-key-rotator-test/home";

function resolve(raw: unknown, env: NodeJS.ProcessEnv = {}) {
  return resolveConfig(raw as RawRotatorConfig, {
    configFile: CONFIG_FILE,
    env,
    homeDir: HOME_DIR,
  });
}

function base(keys: unknown[]) {
  return {
    provider: "test-provider",
    api: "openai-completions",
    keys,
  };
}

function captureValidationError(fn: () => unknown): ConfigValidationError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigValidationError);
    return error;
  }
  assert.fail("Expected ConfigValidationError");
}

test("accepts API keys supplied directly through value", () => {
  const config = resolve(
    base([
      { id: "literal-1", value: "sk-literal-one" },
      { id: "literal-2", value: "sk-literal-two" },
    ]),
  );

  assert.deepEqual(
    config.keys.map(({ id, env, value }) => ({ id, env, value })),
    [
      { id: "literal-1", env: "<literal>", value: "sk-literal-one" },
      { id: "literal-2", env: "<literal>", value: "sk-literal-two" },
    ],
  );
});

test("keeps the existing environment-variable mode", () => {
  const config = resolve(
    base([
      { id: "env-1", env: "TEST_KEY_1" },
      { id: "env-2", env: "TEST_KEY_2" },
    ]),
    { TEST_KEY_1: "sk-env-one", TEST_KEY_2: "sk-env-two" },
  );

  assert.equal(config.keys[0]?.value, "sk-env-one");
  assert.equal(config.keys[0]?.env, "TEST_KEY_1");
  assert.equal(config.keys[1]?.value, "sk-env-two");
});

test("allows literal and environment-backed keys in the same pool", () => {
  const config = resolve(
    base([
      { id: "literal", value: "sk-literal" },
      { id: "environment", env: "TEST_KEY" },
    ]),
    { TEST_KEY: "sk-environment" },
  );

  assert.deepEqual(
    config.keys.map((key) => [key.id, key.env, key.value]),
    [
      ["literal", "<literal>", "sk-literal"],
      ["environment", "TEST_KEY", "sk-environment"],
    ],
  );
});

test("does not expand a literal value beginning with a dollar sign", () => {
  const value = "$NOT_AN_ENVIRONMENT_REFERENCE";
  const config = resolve(base([{ id: "one", value }, { id: "two", value: "second" }]));
  assert.equal(config.keys[0]?.value, value);
});

test("preserves braces and shell-sensitive characters in literal keys", () => {
  const value = "${still-literal}:abc/DEF+123=_-.";
  const config = resolve(base([{ id: "one", value }, { id: "two", value: "second" }]));
  assert.equal(config.keys[0]?.value, value);
});

test("rejects a key definition containing both env and value", () => {
  const error = captureValidationError(() =>
    resolve(
      base([
        { id: "invalid", env: "TEST_KEY", value: "sk-must-not-leak" },
        { id: "valid", value: "second" },
      ]),
      { TEST_KEY: "environment-secret" },
    ),
  );

  assert.match(error.message, /exactly one of "env" or "value"/);
  assert.doesNotMatch(error.message, /sk-must-not-leak|environment-secret/);
});

test("rejects a key definition containing neither env nor value", () => {
  const error = captureValidationError(() => resolve(base([{ id: "invalid" }, { id: "valid", value: "second" }])));
  assert.match(error.message, /exactly one of "env" or "value"/);
});

test("treats an explicitly supplied null value as invalid", () => {
  const error = captureValidationError(() =>
    resolve(base([{ id: "invalid", value: null }, { id: "valid", value: "second" }])),
  );
  assert.match(error.message, /keys\[0\]\.value.*non-empty string/);
});

test("rejects an empty literal key", () => {
  const error = captureValidationError(() => resolve(base([{ id: "invalid", value: "" }, { id: "valid", value: "second" }])));
  assert.match(error.message, /non-empty string/);
});

test("rejects a whitespace-only literal key", () => {
  const error = captureValidationError(() =>
    resolve(base([{ id: "invalid", value: "   " }, { id: "valid", value: "second" }])),
  );
  assert.match(error.message, /non-empty string/);
});

test("rejects leading whitespace instead of silently changing the key", () => {
  const secret = " sk-leading-space";
  const error = captureValidationError(() =>
    resolve(base([{ id: "invalid", value: secret }, { id: "valid", value: "second" }])),
  );
  assert.match(error.message, /leading or trailing whitespace/);
  assert.doesNotMatch(error.message, new RegExp(secret));
});

test("rejects trailing whitespace instead of silently changing the key", () => {
  const secret = "sk-trailing-space ";
  const error = captureValidationError(() =>
    resolve(base([{ id: "invalid", value: secret }, { id: "valid", value: "second" }])),
  );
  assert.match(error.message, /leading or trailing whitespace/);
  assert.ok(!error.message.includes(secret));
});

test("rejects control characters in literal keys", () => {
  const secret = "sk-line-one\nline-two";
  const error = captureValidationError(() =>
    resolve(base([{ id: "invalid", value: secret }, { id: "valid", value: "second" }])),
  );
  assert.match(error.message, /control characters/);
  assert.ok(!error.message.includes(secret));
});

test("rejects duplicate literal secrets without printing the secret", () => {
  const secret = "sk-duplicate-literal";
  const error = captureValidationError(() =>
    resolve(base([{ id: "first", value: secret }, { id: "second", value: secret }])),
  );

  assert.match(error.message, /same secret value/);
  assert.match(error.message, /first/);
  assert.match(error.message, /second/);
  assert.ok(!error.message.includes(secret));
});

test("rejects duplicate resolved secrets across value and env sources", () => {
  const secret = "sk-duplicate-mixed";
  const error = captureValidationError(() =>
    resolve(
      base([
        { id: "literal", value: secret },
        { id: "environment", env: "TEST_KEY" },
      ]),
      { TEST_KEY: secret },
    ),
  );

  assert.match(error.message, /same secret value/);
  assert.ok(!error.message.includes(secret));
});

test("does not mistake two different keys with common prefixes for duplicates", () => {
  const config = resolve(
    base([
      { id: "one", value: "sk-common-prefix-111" },
      { id: "two", value: "sk-common-prefix-222" },
    ]),
  );
  assert.equal(config.keys.length, 2);
});

test("accepts a UTF-8 BOM commonly added by Windows editors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-bom-"));
  const configFile = join(directory, "key-rotator.json");
  try {
    const document = base([
      { id: "one", value: "sk-one" },
      { id: "two", value: "sk-two" },
    ]);
    await writeFile(configFile, `\uFEFF${JSON.stringify(document)}`, "utf8");

    const config = await loadConfig({ configFile, env: {}, homeDir: directory });
    assert.equal(config.keys[0]?.value, "sk-one");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sanitizes malformed JSON errors so source excerpts cannot leak a literal key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-json-error-"));
  const configFile = join(directory, "key-rotator.json");
  const secret = "sk-never-print-this-secret";
  try {
    await writeFile(
      configFile,
      `{"provider":"test","api":"openai-completions","keys":[{"id":"one","value":"${secret}"},]}`,
      "utf8",
    );

    await assert.rejects(
      loadConfig({ configFile, env: {}, homeDir: directory }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigValidationError);
        assert.match(error.message, /JSON parsing failed/);
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.message.includes('"value"'));
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects pathologically large literal values without echoing them", () => {
  const secret = `sk-${"x".repeat(65_534)}`;
  const error = captureValidationError(() =>
    resolve(base([{ id: "invalid", value: secret }, { id: "valid", value: "second" }])),
  );
  assert.match(error.message, /maximum supported length/);
  assert.ok(!error.message.includes(secret.slice(0, 64)));
});
