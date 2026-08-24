import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  ConfigNotFoundError,
  ConfigSecurityError,
  ConfigValidationError,
  loadConfig,
  physicalInodeIdentity,
  resolveConfig,
} from "../src/config.ts";
import { loadConfigSet } from "../src/config-set.ts";
import { PI_HOST_RESERVED_FILE_NAMES, resolveAgentDir } from "../src/pi-host.ts";
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

const commandRaw: RawRotatorConfig = {
  provider: "company-ai",
  api: "openai-completions",
  keys: [
    { id: "primary", command: "resolve-primary" },
    { id: "secondary", command: "resolve-secondary" },
  ],
};

test("zero inode values are treated as unavailable rather than shared identity", () => {
  assert.equal(physicalInodeIdentity(7n, 0n), undefined);
  assert.equal(physicalInodeIdentity(7n, 42n), "7:42");
});

test("loadConfig resolves key values and a provider-scoped state file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-config-"));
  const configFile = join(directory, "key-rotator.json");
  await writeFile(configFile, JSON.stringify(validRaw), { encoding: "utf8", mode: 0o600 });

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
  assert.equal(config.stateFile, resolve("/opt/pi/runtime/state.json"));
});

test("the default state file stays under the Pi agent directory", () => {
  const config = resolveConfig(validRaw, {
    configFile: "/etc/pi/key-rotator.json",
    homeDir: "/home/tester",
    env: { KEY_ONE: "one", KEY_TWO: "two" },
  });
  assert.equal(config.stateFile, resolve("/home/tester/.pi/agent/key-rotator-company-ai.state.json"));
});

test("PI_CODING_AGENT_DIR moves the default config and state together", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-agent-dir-"));
  const agentDirectory = join(root, "custom-agent");
  const configFile = join(agentDirectory, "key-rotator.json");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(configFile, JSON.stringify(validRaw), { encoding: "utf8", mode: 0o600 });
  try {
    const config = await loadConfig({
      homeDir: root,
      env: {
        KEY_ONE: "one",
        KEY_TWO: "two",
        PI_CODING_AGENT_DIR: "~/custom-agent",
      },
    });
    assert.equal(config.configFile, configFile);
    assert.equal(config.stateFile, join(agentDirectory, "key-rotator-company-ai.state.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plain relative PI_CODING_AGENT_DIR is made absolute exactly once", async () => {
  const root = await mkdtemp(join(process.cwd(), ".pi-key-rotator-relative-agent-"));
  const agentDirectory = join(root, "agent-relative");
  const relativeOverride = relative(process.cwd(), agentDirectory);
  const configFile = join(agentDirectory, "key-rotator.json");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(configFile, JSON.stringify(validRaw), { encoding: "utf8", mode: 0o600 });
  try {
    const env = {
      KEY_ONE: "one",
      KEY_TWO: "two",
      PI_CODING_AGENT_DIR: relativeOverride,
    };
    assert.equal(resolveAgentDir({ env, homeDir: root }), agentDirectory);
    assert.equal(isAbsolute(resolveAgentDir({ env, homeDir: root })), true);

    const config = await loadConfig({ homeDir: root, env });
    assert.equal(config.configFile, configFile);
    assert.equal(config.stateFile, join(agentDirectory, "key-rotator-company-ai.state.json"));
    assert.doesNotMatch(config.stateFile, /agent-relative[/\\]agent-relative/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PI_KEY_ROTATOR_CONFIG wins over PI_CODING_AGENT_DIR for the config path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-env-"));
  const configFile = join(directory, "custom.json");
  const agentDirectory = join(directory, "agent-override");
  await writeFile(configFile, JSON.stringify(validRaw), { encoding: "utf8", mode: 0o600 });
  try {
    const config = await loadConfig({
      homeDir: directory,
      env: {
        KEY_ONE: "one",
        KEY_TWO: "two",
        PI_KEY_ROTATOR_CONFIG: configFile,
        PI_CODING_AGENT_DIR: agentDirectory,
      },
    });
    assert.equal(config.configFile, configFile);
    assert.equal(config.stateFile, join(agentDirectory, "key-rotator-company-ai.state.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicit config path wins over PI_KEY_ROTATOR_CONFIG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-explicit-"));
  const environmentFile = join(directory, "environment.json");
  const explicitFile = join(directory, "explicit.json");
  await writeFile(environmentFile, JSON.stringify(validRaw), { encoding: "utf8", mode: 0o600 });
  await writeFile(explicitFile, JSON.stringify({ ...validRaw, requestsPerKey: 3 }), { encoding: "utf8", mode: 0o600 });
  try {
    const config = await loadConfig({
      configFile: explicitFile,
      homeDir: directory,
      env: {
        KEY_ONE: "one",
        KEY_TWO: "two",
        PI_KEY_ROTATOR_CONFIG: environmentFile,
        PI_CODING_AGENT_DIR: join(directory, "agent-override"),
      },
    });
    assert.equal(config.configFile, explicitFile);
    assert.equal(config.requestsPerKey, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a key may not combine two secret sources", () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          ...validRaw,
          keys: [
            { id: "a", env: "KEY_ONE", value: "never-print-this" } as never,
            { id: "b", env: "KEY_TWO" },
          ],
        },
        { configFile: "/tmp/config.json", homeDir: "/tmp", env: { KEY_ONE: "one", KEY_TWO: "two" } },
      ),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      /exactly one of "env", "value", or "command"/.test(error.message) &&
      !error.message.includes("never-print-this"),
  );
});


test("stateFile cannot collide with the configuration or its state sidecars", () => {
  const options = {
    configFile: "/opt/pi/key-rotator.json",
    homeDir: "/home/tester",
    env: { KEY_ONE: "one", KEY_TWO: "two" },
  };
  assert.throws(
    () => resolveConfig({ ...validRaw, stateFile: "/opt/pi/key-rotator.json" }, options),
    /must not resolve to the configuration file/,
  );
  assert.throws(
    () =>
      resolveConfig(
        { ...validRaw, stateFile: "/opt/pi/runtime-state.json" },
        { ...options, configFile: "/opt/pi/runtime-state.json.lock" },
      ),
    /must not resolve to the configuration file/,
  );
});

test("Pi host-reserved files are refused before command resolvers run", async () => {
  const requiredNames = [
    "auth.json",
    "models.json",
    "settings.json",
    "keybindings.json",
    "models-store.json",
  ];
  const reservedNames = new Set<string>(PI_HOST_RESERVED_FILE_NAMES);
  for (const name of requiredNames) assert.ok(reservedNames.has(name));

  const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-host-files-"));
  const agentDirectory = join(root, "agent");
  const configFile = join(agentDirectory, "key-rotator.json");
  await mkdir(agentDirectory, { recursive: true });
  let commandRuns = 0;
  try {
    for (const name of PI_HOST_RESERVED_FILE_NAMES) {
      await writeFile(
        configFile,
        JSON.stringify({ ...commandRaw, stateFile: join(agentDirectory, name) }),
        { encoding: "utf8", mode: 0o600 },
      );
      await assert.rejects(
        () =>
          loadConfig({
            configFile,
            homeDir: root,
            env: { PI_CODING_AGENT_DIR: agentDirectory },
            runCommand: async () => {
              commandRuns += 1;
              return { stdout: "must-not-run", code: 0, timedOut: false };
            },
          }),
        (error: unknown) =>
          error instanceof ConfigValidationError &&
          error.message.includes(`Pi host file "${name}"`),
      );
    }
    assert.equal(commandRuns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every fixed and unique state sidecar namespace is reserved before commands run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-sidecars-"));
  const agentDirectory = join(root, "agent");
  const nonce = crypto.randomUUID();
  const cases = [
    ["state", (base: string) => base],
    ["lock", (base: string) => `${base}.lock`],
    ["reclaim", (base: string) => `${base}.lock.reclaim`],
    ["backup", (base: string) => `${base}.bak`],
    ["state-temp", (base: string) => `${base}.${process.pid}.${nonce}.tmp`],
    ["backup-temp", (base: string) => `${base}.bak.${process.pid}.${nonce}.tmp`],
    ["lock-candidate", (base: string) => `${base}.lock.${nonce}.candidate`],
  ] as const;
  let commandRuns = 0;
  try {
    for (const [label, configPath] of cases) {
      const stateFile = join(root, `${label}.state.json`);
      const configFile = configPath(stateFile);
      await writeFile(configFile, JSON.stringify({ ...commandRaw, stateFile }), {
        encoding: "utf8",
        mode: 0o600,
      });
      await assert.rejects(
        () =>
          loadConfig({
            configFile,
            homeDir: root,
            env: { PI_CODING_AGENT_DIR: agentDirectory },
            runCommand: async () => {
              commandRuns += 1;
              return { stdout: "must-not-run", code: 0, timedOut: false };
            },
          }),
        (error: unknown) =>
          error instanceof ConfigValidationError && /state sidecar|sidecars overlap/u.test(error.message),
      );
    }
    assert.equal(commandRuns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "physical validation resolves absent leaves through symlinked directories without rejecting safe paths",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-absent-alias-"));
    const realAgentDirectory = join(root, "real-agent");
    const aliasAgentDirectory = join(root, "alias-agent");
    const configFile = join(root, "key-rotator.json");
    await mkdir(realAgentDirectory);
    await symlink(realAgentDirectory, aliasAgentDirectory, "dir");
    let commandRuns = 0;
    const runCommand = async (command: string) => {
      commandRuns += 1;
      return { stdout: `secret-${command}`, code: 0, timedOut: false };
    };
    try {
      await writeFile(
        configFile,
        JSON.stringify({ ...commandRaw, stateFile: join(realAgentDirectory, "auth.json") }),
        { mode: 0o600 },
      );
      await assert.rejects(
        () =>
          loadConfig({
            configFile,
            homeDir: root,
            env: { PI_CODING_AGENT_DIR: aliasAgentDirectory },
            runCommand,
          }),
        /Pi host file "auth\.json"|same file or location/u,
      );
      assert.equal(commandRuns, 0);

      const safeStateFile = join(aliasAgentDirectory, "safe-state.json");
      await writeFile(configFile, JSON.stringify({ ...commandRaw, stateFile: safeStateFile }), { mode: 0o600 });
      const loaded = await loadConfig({
        configFile,
        homeDir: root,
        env: { PI_CODING_AGENT_DIR: aliasAgentDirectory },
        runCommand,
      });
      assert.equal(loaded.stateFile, safeStateFile);
      assert.equal(commandRuns, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("existing hard-link aliases to Pi host files are refused before commands run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-hardlink-host-"));
  const agentDirectory = join(root, "agent");
  const configFile = join(root, "key-rotator.json");
  const authFile = join(agentDirectory, "auth.json");
  const stateFile = join(root, "state-hardlink.json");
  await mkdir(agentDirectory);
  await writeFile(authFile, "host-owned\n", { mode: 0o600 });
  await link(authFile, stateFile);
  await writeFile(configFile, JSON.stringify({ ...commandRaw, stateFile }), { mode: 0o600 });
  let commandRuns = 0;
  try {
    await assert.rejects(
      () =>
        loadConfig({
          configFile,
          homeDir: root,
          env: { PI_CODING_AGENT_DIR: agentDirectory },
          runCommand: async () => {
            commandRuns += 1;
            return { stdout: "must-not-run", code: 0, timedOut: false };
          },
        }),
      /same file or location/u,
    );
    assert.equal(commandRuns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-pool state paths cannot enter another pool's unique sidecar namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-pool-sidecars-"));
  const configFile = join(root, "key-rotator.json");
  const firstState = join(root, "first.state.json");
  const secondState = `${firstState}.lock.${crypto.randomUUID()}.candidate`;
  await writeFile(
    configFile,
    JSON.stringify({
      pools: [
        { ...commandRaw, poolId: "first", provider: "first-provider", stateFile: firstState },
        { ...commandRaw, poolId: "second", provider: "second-provider", stateFile: secondState },
      ],
    }),
    { mode: 0o600 },
  );
  let commandRuns = 0;
  try {
    await assert.rejects(
      () =>
        loadConfigSet({
          configFile,
          homeDir: root,
          env: { PI_CODING_AGENT_DIR: join(root, "agent") },
          runCommand: async () => {
            commandRuns += 1;
            return { stdout: "must-not-run", code: 0, timedOut: false };
          },
        }),
      /lock candidate sidecars overlap/u,
    );
    assert.equal(commandRuns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maxStateFileBytes is bounded and defaults to one MiB", () => {
  const options = {
    configFile: "/tmp/config.json",
    homeDir: "/tmp",
    env: { KEY_ONE: "one", KEY_TWO: "two" },
  };
  assert.equal(resolveConfig(validRaw, options).maxStateFileBytes, 1_048_576);
  assert.equal(resolveConfig({ ...validRaw, maxStateFileBytes: 524_288 }, options).maxStateFileBytes, 524_288);
  assert.throws(() => resolveConfig({ ...validRaw, maxStateFileBytes: 262_144 }, options), /maxStateFileBytes/);
  assert.throws(() => resolveConfig({ ...validRaw, maxStateFileBytes: 2_048 }, options), /maxStateFileBytes/);
  assert.throws(() => resolveConfig({ ...validRaw, maxStateFileBytes: 512 }, options), /maxStateFileBytes/);
});


test("dynamic state minimum covers maximum-width retained target identifiers", () => {
  const wideTargets = Array.from({ length: 128 }, (_unused, index) => ({
    provider: `${"\u0800".repeat(255)}${String.fromCharCode(0x0800 + index)}`,
    api: "openai-completions",
  }));
  const raw = {
    poolId: "wide-targets",
    targets: wideTargets,
    keys: validRaw.keys,
    maxStateFileBytes: 1_024,
  };
  const options = {
    configFile: "/tmp/config.json",
    homeDir: "/tmp",
    env: { KEY_ONE: "one", KEY_TWO: "two" },
  };
  let required = 0;
  assert.throws(
    () => resolveConfig(raw, options),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const match = /at least (\d+) bytes/u.exec(error.message);
      assert.ok(match);
      required = Number(match[1]);
      return true;
    },
  );
  const config = resolveConfig({ ...raw, maxStateFileBytes: required }, options);
  const maximum = Number.MAX_SAFE_INTEGER;
  const keyState = {
    credentialFingerprint: "f".repeat(64),
    configRevision: "9".repeat(40),
    attempts: maximum,
    successes: maximum,
    failures: maximum,
    lastOutcomeAttempt: maximum,
    disabled: true,
    cooldownUntil: maximum,
    lastStatus: 599,
    lastAttemptAt: maximum,
    lastSuccessAt: maximum,
    lastFailureAt: maximum,
  };
  const targetState = {
    failures: maximum,
    consecutiveFailures: maximum,
    cooldownUntil: maximum,
    lastStatus: 599,
    lastFailureAt: maximum,
    lastSuccessAt: maximum,
    lastOutcomeAttempt: maximum,
  };
  const keys = Object.fromEntries([
    ...config.keys.map((key) => [key.id, keyState] as const),
    ...Array.from({ length: 256 }, (_unused, index) => [
      `r${index.toString(36).padStart(63, "0")}`,
      keyState,
    ] as const),
  ]);
  const targets = Object.fromEntries([
    ...wideTargets.map((target) => [target.provider, targetState] as const),
    ...Array.from({ length: 128 }, (_unused, index) => [
      `${"\u0900".repeat(255)}${String.fromCharCode(0x0980 + index)}`,
      targetState,
    ] as const),
  ]);
  const maximumState = {
    magic: "pi-api-key-rotator-state",
    version: 2,
    poolId: config.poolId,
    generation: maximum,
    currentKeyId: config.keys[0]!.id,
    requestsOnCurrent: maximum,
    totalAttempts: maximum,
    updatedAt: maximum,
    poolCooldownUntil: maximum,
    poolLastSuccessAttempt: maximum,
    keys,
    targets,
  };
  const bytes = Buffer.byteLength(`${JSON.stringify(maximumState, null, 2)}\n`, "utf8");
  assert.ok(bytes <= required, `${bytes} must fit the reported ${required}-byte minimum`);
});

test(
  "physical path validation catches a state/config collision through a symlinked parent",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-physical-"));
    const realDirectory = join(root, "real");
    const aliasDirectory = join(root, "alias");
    await mkdir(realDirectory);
    await symlink(realDirectory, aliasDirectory, "dir");
    const configFile = join(realDirectory, "key-rotator.json");
    await writeFile(
      configFile,
      JSON.stringify({ ...validRaw, stateFile: join(aliasDirectory, "key-rotator.json") }),
      { mode: 0o600 },
    );
    try {
      await assert.rejects(
        () =>
          loadConfig({
            configFile,
            homeDir: root,
            env: { KEY_ONE: "one", KEY_TWO: "two" },
          }),
        /resolve to the same file or location/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a config with invalid UTF-8 is rejected without echoing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-utf8-"));
  const configFile = join(root, "key-rotator.json");
  await writeFile(configFile, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), {
    mode: 0o600,
  });
  try {
    await assert.rejects(
      () => loadConfig({ configFile, homeDir: root, env: {} }),
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        /valid UTF-8/.test(error.message) &&
        !error.message.includes("�"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "a FIFO config is refused without blocking",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-key-rotator-fifo-"));
    const configFile = join(root, "key-rotator.json");
    const made = spawnSync("mkfifo", [configFile]);
    assert.equal(made.status, 0);
    const started = performance.now();
    try {
      await assert.rejects(
        () => loadConfig({ configFile, homeDir: root, env: {} }),
        (error: unknown) => error instanceof ConfigSecurityError && /regular file/.test(error.message),
      );
      assert.ok(performance.now() - started < 1_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);


test("rate-limit scope and target circuit threshold are strictly validated", () => {
  const options = {
    configFile: "/tmp/config.json",
    homeDir: "/tmp",
    env: { KEY_ONE: "one", KEY_TWO: "two" },
  };
  const resolved = resolveConfig(
    { ...validRaw, rateLimitScope: "target", targetFailureThreshold: 4 },
    options,
  );
  assert.equal(resolved.rateLimitScope, "target");
  assert.equal(resolved.targetFailureThreshold, 4);
  assert.throws(
    () => resolveConfig({ ...validRaw, rateLimitScope: "credential" as never }, options),
    /rateLimitScope/,
  );
  assert.throws(
    () => resolveConfig({ ...validRaw, targetFailureThreshold: 0 }, options),
    /targetFailureThreshold/,
  );
});


test("config version, unknown fields, empty policies, and the default attempt budget are strict", () => {
  const options = {
    configFile: "/tmp/config.json",
    homeDir: "/tmp",
    env: { KEY_ONE: "one", KEY_TWO: "two", KEY_THREE: "three", KEY_FOUR: "four" },
  };
  const fourKeys: RawRotatorConfig = {
    ...validRaw,
    configVersion: 1,
    keys: [
      ...validRaw.keys,
      { id: "third", env: "KEY_THREE" },
      { id: "fourth", env: "KEY_FOUR" },
    ],
    disableStatuses: [],
    cooldownStatuses: [],
  };
  const resolved = resolveConfig(fourKeys, options);
  assert.equal(resolved.maxAttemptsPerRequest, 3);
  assert.deepEqual([...resolved.disableStatuses], []);
  assert.deepEqual([...resolved.cooldownStatuses], []);

  assert.throws(
    () => resolveConfig({ ...fourKeys, configVersion: 2 as never }, options),
    /configVersion/,
  );
  assert.throws(
    () => resolveConfig({ ...fourKeys, requestPerKey: "never-print-this" } as never, options),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      /Unknown field/.test(error.message) &&
      /requestsPerKey/.test(error.message) &&
      !error.message.includes("never-print-this"),
  );
  assert.throws(
    () => resolveConfig({ ...fourKeys, retryStatuses: [429], disableStatuses: [429], cooldownStatuses: [429] }, options),
    /must not overlap/,
  );
});
