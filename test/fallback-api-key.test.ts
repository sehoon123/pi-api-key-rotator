import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapePiConfigLiteral,
  fallbackApiKey,
  MANAGED_KEY_PLACEHOLDER,
  sanitizeProviderLiteral,
} from "../src/extension.ts";

// Pi requires a non-empty provider apiKey before it calls streamSimple. The
// rotating stream replaces this inert marker with the selected real key.

test("every key source registers only the managed placeholder", () => {
  const keys = [
    { id: "env", source: "env" as const, env: "MY_KEY_1", value: "env-secret-value" },
    { id: "legacy", env: "TEST_KEY_1", value: "legacy-secret-value" },
    { id: "literal", source: "literal" as const, env: "<literal>", value: "sk-a$b$$c" },
    {
      id: "command",
      source: "command" as const,
      command: "op read op://Private/x/key-1",
      value: "command-secret-value",
    },
  ];

  for (const key of keys) {
    const fallback = fallbackApiKey(key);
    assert.equal(fallback, MANAGED_KEY_PLACEHOLDER);
    assert.ok(!fallback.includes(key.value));
    if (key.env) assert.ok(!fallback.includes(key.env));
    if ("command" in key && key.command) assert.ok(!fallback.includes(key.command));
  }
});

test("compatibility literal helpers also refuse every configured value", () => {
  for (const value of ["ordinary-looking-secret", "!rm -rf /tmp/should-never-run", "$SECRET_ENV"]) {
    assert.equal(escapePiConfigLiteral(value), MANAGED_KEY_PLACEHOLDER);
    assert.equal(sanitizeProviderLiteral(value), MANAGED_KEY_PLACEHOLDER);
  }
});

test("the placeholder is non-empty and inert for Pi preflight", () => {
  assert.ok(MANAGED_KEY_PLACEHOLDER.length > 0);
  assert.ok(!MANAGED_KEY_PLACEHOLDER.startsWith("!"));
  assert.ok(!MANAGED_KEY_PLACEHOLDER.startsWith("$"));
  assert.match(MANAGED_KEY_PLACEHOLDER, /^[A-Za-z0-9_-]+$/);
});
