import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigValidationError } from "../src/config.ts";
import { resolveConfigSet } from "../src/config-set.ts";
import type { RawMultiPoolConfig } from "../src/config-set.ts";
import { registerMultiPoolKeyRotatorExtension } from "../src/multi-pool-extension.ts";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type {
  ExtensionApiLike,
  ExtensionContextLike,
  ModelLike,
  RotatorConfig,
  StreamSimpleLike,
} from "../src/types.ts";
import { assistantMessage, collect, makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

const RESOLVE_OPTIONS = {
  configFile: "/tmp/key-rotator.json",
  homeDir: "/tmp/home",
  env: {},
};

function rawPools(): RawMultiPoolConfig {
  return {
    pools: [
      {
        poolId: "primary",
        targets: [
          { provider: "ibm-ica-claude", api: "anthropic-messages" },
          { provider: "ibm-ica", api: "openai-completions" },
        ],
        keys: [
          { id: "key-1", value: "primary-one" },
          { id: "key-2", value: "primary-two" },
        ],
        requestsPerKey: 2,
      },
      {
        poolId: "secondary",
        provider: "ibm-ica-secondary",
        api: "openai-completions",
        keys: [
          { id: "key-1", value: "secondary-one" },
          { id: "key-2", value: "secondary-two" },
        ],
        requestsPerKey: 3,
      },
    ],
  };
}

test("resolves endpoint pools with independent keys, policies, and state files", () => {
  const set = resolveConfigSet(rawPools(), RESOLVE_OPTIONS);
  assert.equal(set.pools.length, 2);
  assert.deepEqual(set.pools.map((pool) => pool.poolId), ["primary", "secondary"]);
  assert.deepEqual(set.pools.map((pool) => pool.requestsPerKey), [2, 3]);
  assert.notEqual(set.pools[0]?.stateFile, set.pools[1]?.stateFile);
  assert.deepEqual(set.pools[0]?.keys.map((key) => key.value), ["primary-one", "primary-two"]);
  assert.deepEqual(set.pools[1]?.keys.map((key) => key.value), ["secondary-one", "secondary-two"]);
});

test("rejects provider, pool ID, and state-file collisions before runtime", () => {
  const duplicateProvider = rawPools();
  duplicateProvider.pools[1]!.provider = "ibm-ica";
  assert.throws(() => resolveConfigSet(duplicateProvider, RESOLVE_OPTIONS), /assigned to both pool/);

  const duplicateId = rawPools();
  duplicateId.pools[1]!.poolId = "PRIMARY";
  assert.throws(() => resolveConfigSet(duplicateId, RESOLVE_OPTIONS), /Pool IDs must be unique/);

  const duplicateState = rawPools();
  duplicateState.pools[0]!.stateFile = "same/state.json";
  duplicateState.pools[1]!.stateFile = "same/STATE.json";
  assert.throws(() => resolveConfigSet(duplicateState, RESOLVE_OPTIONS), /same state file/);

  const sidecarCollision = rawPools();
  sidecarCollision.pools[0]!.stateFile = "same/state.json";
  sidecarCollision.pools[1]!.stateFile = "same/state.json.lock";
  assert.throws(() => resolveConfigSet(sidecarCollision, RESOLVE_OPTIONS), /State paths.*collide/);
});

test("rejects ambiguous top-level fields without exposing literal keys", () => {
  const raw = { ...rawPools(), keys: [{ id: "x", value: "never-print-this" }] };
  assert.throws(
    () => resolveConfigSet(raw, RESOLVE_OPTIONS),
    (error: unknown) =>
      error instanceof ConfigValidationError &&
      /cannot be combined/.test(error.message) &&
      !error.message.includes("never-print-this"),
  );
});

class MockPi implements ExtensionApiLike {
  readonly providers = new Map<string, Parameters<ExtensionApiLike["registerProvider"]>[1]>();
  readonly commands = new Map<string, Parameters<ExtensionApiLike["registerCommand"]>[1]>();
  readonly handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContextLike) => Promise<void> | void>>();

  registerProvider(name: string, config: Parameters<ExtensionApiLike["registerProvider"]>[1]): void {
    this.providers.set(name, config);
  }
  registerCommand(name: string, options: Parameters<ExtensionApiLike["registerCommand"]>[1]): void {
    this.commands.set(name, options);
  }
  on(
    event: "session_start" | "model_select" | "session_shutdown",
    handler: (event: unknown, ctx: ExtensionContextLike) => Promise<void> | void,
  ): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
}

function config(poolId: string, provider: string, prefix: string): RotatorConfig {
  return makeConfig({
    poolId,
    provider,
    api: "openai-completions",
    targets: [{ provider, api: "openai-completions" }],
    keys: [
      { id: "key-1", source: "literal", env: "<literal>", value: `${prefix}-one` },
      { id: "key-2", source: "literal", env: "<literal>", value: `${prefix}-two` },
    ],
    requestsPerKey: 2,
    maxAttemptsPerRequest: 2,
    stateFile: `/tmp/${poolId}.state.json`,
  });
}

function model(provider: string): ModelLike {
  return { provider, api: "openai-completions", id: `${provider}-model` };
}

function runtimes() {
  const clock = mutableClock(1_000).clock;
  const primary = config("primary", "provider-primary", "primary");
  const secondary = config("secondary", "provider-secondary", "secondary");
  return {
    primary,
    secondary,
    primaryPool: new KeyPool(primary, new InMemoryStateStore(createInitialPoolState(primary, clock.now())), clock),
    secondaryPool: new KeyPool(secondary, new InMemoryStateStore(createInitialPoolState(secondary, clock.now())), clock),
  };
}

function successfulStream(calls: Array<{ provider: string; apiKey: string | undefined }>): StreamSimpleLike {
  return (selectedModel, _context, options) => {
    calls.push({ provider: selectedModel.provider, apiKey: options?.apiKey });
    const stream = new TestEventStream();
    queueMicrotask(async () => {
      await options?.onResponse?.({ status: 200, headers: {} }, selectedModel);
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage("stop", {
          provider: selectedModel.provider,
          api: selectedModel.api,
          model: selectedModel.id,
        }),
      });
    });
    return stream;
  };
}

test("requests rotate only inside the endpoint pool that owns the provider", async () => {
  const { primary, secondary, primaryPool, secondaryPool } = runtimes();
  const calls: Array<{ provider: string; apiKey: string | undefined }> = [];
  const pi = new MockPi();
  registerMultiPoolKeyRotatorExtension(pi, {
    pools: [
      { config: primary, pool: primaryPool },
      { config: secondary, pool: secondaryPool },
    ],
    baseStreamSimple: successfulStream(calls),
    createEventStream: () => new TestEventStream(),
  });

  await collect(pi.providers.get("provider-primary")!.streamSimple(model("provider-primary"), {}));
  await collect(pi.providers.get("provider-primary")!.streamSimple(model("provider-primary"), {}));
  await collect(pi.providers.get("provider-primary")!.streamSimple(model("provider-primary"), {}));
  await collect(pi.providers.get("provider-secondary")!.streamSimple(model("provider-secondary"), {}));

  assert.deepEqual(calls, [
    { provider: "provider-primary", apiKey: "primary-one" },
    { provider: "provider-primary", apiKey: "primary-one" },
    { provider: "provider-primary", apiKey: "primary-two" },
    { provider: "provider-secondary", apiKey: "secondary-one" },
  ]);
  assert.equal((await primaryPool.snapshot()).totalAttempts, 3);
  assert.equal((await secondaryPool.snapshot()).totalAttempts, 1);
});

test("401 in one pool does not disable a key in another pool", async () => {
  const { primary, secondary, primaryPool, secondaryPool } = runtimes();
  const calls: Array<{ provider: string; apiKey: string | undefined }> = [];
  const stream: StreamSimpleLike = (selectedModel, _context, options) => {
    calls.push({ provider: selectedModel.provider, apiKey: options?.apiKey });
    const output = new TestEventStream();
    queueMicrotask(async () => {
      const status = selectedModel.provider === "provider-primary" && options?.apiKey === "primary-one" ? 401 : 200;
      await options?.onResponse?.({ status, headers: {} }, selectedModel);
      const message = assistantMessage(status === 200 ? "stop" : "error", {
        provider: selectedModel.provider,
        api: selectedModel.api,
        model: selectedModel.id,
        ...(status === 200 ? {} : { errorMessage: "unauthorized" }),
      });
      output.push(status === 200 ? { type: "done", reason: "stop", message } : { type: "error", reason: "error", error: message });
    });
    return output;
  };

  const pi = new MockPi();
  registerMultiPoolKeyRotatorExtension(pi, {
    pools: [
      { config: primary, pool: primaryPool },
      { config: secondary, pool: secondaryPool },
    ],
    baseStreamSimple: stream,
    createEventStream: () => new TestEventStream(),
  });

  await collect(pi.providers.get("provider-primary")!.streamSimple(model("provider-primary"), {}));
  await collect(pi.providers.get("provider-secondary")!.streamSimple(model("provider-secondary"), {}));
  assert.deepEqual(calls.map((call) => call.apiKey), ["primary-one", "primary-two", "secondary-one"]);
  assert.equal((await primaryPool.snapshot()).keys[0]?.disabled, true);
  assert.equal((await secondaryPool.snapshot()).keys[0]?.disabled, false);
});

test("commands target one named pool and do not print raw keys", async () => {
  const { primary, secondary, primaryPool, secondaryPool } = runtimes();
  const pi = new MockPi();
  registerMultiPoolKeyRotatorExtension(pi, {
    pools: [
      { config: primary, pool: primaryPool },
      { config: secondary, pool: secondaryPool },
    ],
    baseStreamSimple: () => new TestEventStream(),
    createEventStream: () => new TestEventStream(),
  });

  const notifications: string[] = [];
  const ctx: ExtensionContextLike = {
    ui: {
      notify(message) { notifications.push(message); },
      setStatus() {},
    },
  };
  const command = pi.commands.get("key-rotator");
  assert.ok(command);
  await command.handler("next", ctx);
  assert.match(notifications.at(-1) ?? "", /specify a poolId/i);
  await command.handler("next secondary", ctx);
  assert.equal((await secondaryPool.snapshot()).currentKeyId, "key-2");
  assert.equal((await primaryPool.snapshot()).currentKeyId, "key-1");
  await command.handler("status", ctx);
  assert.match(notifications.at(-1) ?? "", /Pool: primary/);
  assert.match(notifications.at(-1) ?? "", /Pool: secondary/);
  assert.doesNotMatch(notifications.join("\n"), /primary-one|secondary-one/);
});

test("each direct Pi registration guards both its provider and API", async () => {
  const { primary, secondary, primaryPool, secondaryPool } = runtimes();
  const calls: Array<{ provider: string; api: string; apiKey: string | undefined }> = [];
  const base: StreamSimpleLike = (selectedModel, _context, options) => {
    calls.push({ provider: selectedModel.provider, api: selectedModel.api, apiKey: options?.apiKey });
    const stream = new TestEventStream();
    queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage("stop", {
          provider: selectedModel.provider,
          api: selectedModel.api,
          model: selectedModel.id,
        }),
      });
    });
    return stream;
  };
  const pi = new MockPi();
  registerMultiPoolKeyRotatorExtension(pi, {
    pools: [
      { config: primary, pool: primaryPool },
      { config: secondary, pool: secondaryPool },
    ],
    baseStreamSimple: base,
    createEventStream: () => new TestEventStream(),
  });

  const primaryRegistration = pi.providers.get("provider-primary");
  const secondaryRegistration = pi.providers.get("provider-secondary");
  assert.ok(primaryRegistration);
  assert.ok(secondaryRegistration);
  assert.notEqual(primaryRegistration.streamSimple, secondaryRegistration.streamSimple);

  await collect(primaryRegistration.streamSimple(model("provider-secondary"), {}, { apiKey: "caller-key" }));
  await collect(
    primaryRegistration.streamSimple(
      { provider: "provider-primary", api: "anthropic-messages", id: "wrong-api" },
      {},
      { apiKey: "caller-key" },
    ),
  );

  assert.deepEqual(calls, [
    { provider: "provider-secondary", api: "openai-completions", apiKey: "caller-key" },
    { provider: "provider-primary", api: "anthropic-messages", apiKey: "caller-key" },
  ]);
  assert.equal((await primaryPool.snapshot()).totalAttempts, 0);
  assert.equal((await secondaryPool.snapshot()).totalAttempts, 0);
});

test("a command reuses its atomic snapshot for the footer", async () => {
  const { primary, primaryPool } = runtimes();
  const originalSnapshot = primaryPool.snapshot.bind(primaryPool);
  let snapshotReads = 0;
  primaryPool.snapshot = async () => {
    snapshotReads += 1;
    return originalSnapshot();
  };
  const pi = new MockPi();
  registerMultiPoolKeyRotatorExtension(pi, {
    pools: [{ config: primary, pool: primaryPool }],
    baseStreamSimple: () => new TestEventStream(),
    createEventStream: () => new TestEventStream(),
  });
  const statuses: string[] = [];
  const ctx: ExtensionContextLike = {
    ui: {
      notify() {},
      setStatus(_key, text) {
        if (text) statuses.push(text);
      },
    },
  };

  await pi.commands.get("key-rotator")!.handler("status primary", ctx);
  assert.equal(snapshotReads, 1);
  assert.match(statuses.at(-1) ?? "", /^primary:/);
});

test("doctor FAIL uses an error notification and never refreshes a broken footer", async () => {
  const { primary, primaryPool } = runtimes();
  const pi = new MockPi();
  registerMultiPoolKeyRotatorExtension(pi, {
    pools: [{ config: primary, pool: primaryPool }],
    baseStreamSimple: successfulStream([]),
    createEventStream: () => new TestEventStream(),
    doctor: async () => ({ text: "[FAIL] State: corrupt", severity: "FAIL" }),
  });
  const notices: Array<{ text: string; type: string | undefined }> = [];
  const ctx: ExtensionContextLike = {
    ui: {
      notify: (text, type) => notices.push({ text, type }),
      setStatus: () => {
        throw new Error("footer must not run after doctor failure");
      },
    },
  };
  const command = pi.commands.get("key-rotator");
  assert.ok(command);
  await command.handler("doctor", ctx);
  assert.deepEqual(notices, [{ text: "[FAIL] State: corrupt", type: "error" }]);
});
