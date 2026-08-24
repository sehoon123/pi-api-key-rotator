import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigValidationError, resolveCommandKeys, resolveConfig } from "../src/config.ts";
import { loadConfigSet } from "../src/config-set.ts";
import { runShellCommand } from "../src/pi-host.ts";
import type { CommandRunner } from "../src/pi-host.ts";
import type { RawRotatorConfig } from "../src/types.ts";

const RESOLVE_OPTIONS = { configFile: "/tmp/key-rotator.json", homeDir: "/tmp/home", env: {} };

function rawCommandPool(overrides: Partial<RawRotatorConfig> = {}): RawRotatorConfig {
  return {
    poolId: "vault",
    provider: "vault-provider",
    api: "openai-completions",
    keys: [
      { id: "key-1", command: "secret-tool read key-1" },
      { id: "key-2", command: "secret-tool read key-2" },
    ],
    ...overrides,
  } as RawRotatorConfig;
}

test("command keys resolve once and are trimmed", async () => {
  const config = resolveConfig(rawCommandPool(), RESOLVE_OPTIONS);
  assert.deepEqual(
    config.keys.map((key) => [key.source, key.value, key.commandTimeoutMs]),
    [
      ["command", "", 10_000],
      ["command", "", 10_000],
    ],
  );

  let runs = 0;
  await resolveCommandKeys(config, {
    runCommand: async () => {
      runs += 1;
      return { stdout: `  secret-${runs}\n`, code: 0, timedOut: false };
    },
  });
  assert.equal(runs, 2);
  assert.deepEqual(
    config.keys.map((key) => key.value),
    ["secret-1", "secret-2"],
  );
});

test("a non-zero exit is reported with the key id and the code only", async () => {
  const config = resolveConfig(rawCommandPool(), RESOLVE_OPTIONS);
  await assert.rejects(
    () =>
      resolveCommandKeys(config, {
        runCommand: async () => ({ stdout: "partial-secret-value", code: 3, timedOut: false }),
      }),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      /Key "key-1": the "command" source exited with code 3/.test(error.message) &&
      !error.message.includes("partial-secret-value"),
  );
});

test("a timeout is reported without output", async () => {
  const config = resolveConfig(rawCommandPool(), RESOLVE_OPTIONS);
  await assert.rejects(
    () =>
      resolveCommandKeys(config, {
        runCommand: async () => ({ stdout: "slow-secret-value", code: null, timedOut: true }),
      }),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      /timed out/.test(error.message) &&
      !error.message.includes("slow-secret-value"),
  );
});

test("two commands returning the same secret are rejected by key id", async () => {
  const config = resolveConfig(rawCommandPool(), RESOLVE_OPTIONS);
  await assert.rejects(
    () =>
      resolveCommandKeys(config, {
        runCommand: async () => ({ stdout: "identical-secret", code: 0, timedOut: false }),
      }),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      /resolves to the same secret value/.test(error.message) &&
      !error.message.includes("identical-secret"),
  );
});

test("empty command output is rejected", async () => {
  const config = resolveConfig(rawCommandPool(), RESOLVE_OPTIONS);
  await assert.rejects(
    () => resolveCommandKeys(config, { runCommand: async () => ({ stdout: "   \n", code: 0, timedOut: false }) }),
    /must be a non-empty string/,
  );
});

test("a key may not mix command with env or value, and commandTimeoutMs needs command", () => {
  assert.throws(
    () =>
      resolveConfig(
        rawCommandPool({ keys: [{ id: "a", command: "x", value: "y" } as never, { id: "b", command: "z" }] }),
        RESOLVE_OPTIONS,
      ),
    /exactly one of "env", "value", or "command"/,
  );
  assert.throws(
    () =>
      resolveConfig(
        rawCommandPool({ keys: [{ id: "a", value: "y", commandTimeoutMs: 500 } as never, { id: "b", value: "z" }] }),
        RESOLVE_OPTIONS,
      ),
    /sets "commandTimeoutMs" without "command"/,
  );
  assert.throws(
    () =>
      resolveConfig(
        rawCommandPool({ keys: [{ id: "a", command: "same" }, { id: "b", command: "same" }] }),
        RESOLVE_OPTIONS,
      ),
    /Duplicate key command/,
  );
});

test("loadConfigSet resolves command keys through the injected runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-command-"));
  const configFile = join(directory, "key-rotator.json");
  await writeFile(configFile, JSON.stringify(rawCommandPool()), { encoding: "utf8", mode: 0o600 });
  try {
    const seen: string[] = [];
    const runCommand: CommandRunner = async (command, options) => {
      seen.push(`${command}|${options.timeoutMs}`);
      return { stdout: `value-${seen.length}`, code: 0, timedOut: false };
    };
    const set = await loadConfigSet({ configFile, homeDir: directory, env: {}, runCommand });
    assert.deepEqual(seen, ["secret-tool read key-1|10000", "secret-tool read key-2|10000"]);
    assert.deepEqual(
      set.pools[0]?.keys.map((key) => key.value),
      ["value-1", "value-2"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the real shell runner returns stdout, drops stderr, and reports the exit code", async () => {
  const node = JSON.stringify(process.execPath);
  const ok = await runShellCommand(
    `${node} -e "process.stdout.write('shell-secret\\n'); process.stderr.write('noise\\n')"`,
    { timeoutMs: 5_000 },
  );
  assert.equal(ok.stdout.trim(), "shell-secret");
  assert.equal(ok.code, 0);
  assert.equal(ok.timedOut, false);

  const failed = await runShellCommand(`${node} -e "process.exit(7)"`, { timeoutMs: 5_000 });
  assert.equal(failed.code, 7);

  const started = performance.now();
  const slow = await runShellCommand(`${node} -e "setTimeout(() => {}, 5000)"`, { timeoutMs: 150 });
  assert.equal(slow.timedOut, true);
  assert.ok(performance.now() - started < 1_000, "timeout must not wait for inherited pipes");
});

test("resolveCommandKeys enforces a deadline even when an injected runner ignores it", async () => {
  const config = resolveConfig(
    rawCommandPool({
      keys: [
        { id: "key-1", command: "ignored", commandTimeoutMs: 100 },
        { id: "key-2", value: "second-secret" },
      ],
    }),
    RESOLVE_OPTIONS,
  );
  const started = performance.now();
  await assert.rejects(
    () => resolveCommandKeys(config, { runCommand: async () => await new Promise(() => {}) }),
    /timed out/,
  );
  assert.ok(performance.now() - started < 500);
});

test("command resolution observes caller cancellation even with an uncooperative runner", async () => {
  const config = resolveConfig(rawCommandPool(), RESOLVE_OPTIONS);
  const controller = new AbortController();
  const pending = resolveCommandKeys(config, {
    signal: controller.signal,
    runCommand: async () => await new Promise(() => {}),
  });
  controller.abort();
  await assert.rejects(pending, /could not be started/);
});

test("secret and command output limits use UTF-8 bytes, not JavaScript characters", async () => {
  const config = resolveConfig(rawCommandPool(), RESOLVE_OPTIONS);
  const multiByteSecret = "€".repeat(45_000);
  await assert.rejects(
    () =>
      resolveCommandKeys(config, {
        runCommand: async () => ({ stdout: multiByteSecret, code: 0, timedOut: false }),
      }),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      /UTF-8 byte limit/.test(error.message) &&
      !error.message.includes(multiByteSecret.slice(0, 8)),
  );
});


test(
  "config permission warnings are emitted before any command-backed key runs",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-command-warning-"));
    const configFile = join(directory, "key-rotator.json");
    await writeFile(configFile, JSON.stringify(rawCommandPool()), { encoding: "utf8", mode: 0o600 });
    await chmod(configFile, 0o644);
    const warnings: string[] = [];
    const warningObservedByRunner: boolean[] = [];
    let runs = 0;
    try {
      await loadConfigSet({
        configFile,
        homeDir: directory,
        env: {},
        warn: (message) => warnings.push(message),
        runCommand: async () => {
          warningObservedByRunner.push(warnings.length > 0);
          runs += 1;
          return { stdout: `secret-${runs}`, code: 0, timedOut: false };
        },
      });
      assert.deepEqual(warningObservedByRunner, [true, true]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
