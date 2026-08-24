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
  PoolSnapshot,
  PoolState,
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
  async emit(
    event: "session_start" | "model_select" | "session_shutdown",
    payload: unknown,
    ctx: ExtensionContextLike,
  ): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
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

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

class TrackingStateStore {
  reads = 0;
  transactions = 0;
  state: PoolState;

  constructor(state: PoolState) {
    this.state = structuredClone(state);
  }

  async read(): Promise<PoolState> {
    this.reads += 1;
    return structuredClone(this.state);
  }

  async transact<R>(mutator: (state: PoolState) => R | Promise<R>): Promise<R> {
    this.transactions += 1;
    const working = structuredClone(this.state);
    const result = await mutator(working);
    this.state = working;
    return result;
  }
}

function uiRecorder(modelValue?: ModelLike) {
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const statuses: string[] = [];
  const ctx: ExtensionContextLike = {
    ...(modelValue ? { model: modelValue } : {}),
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus(_key, text) {
        if (text !== undefined) statuses.push(text);
      },
    },
  };
  return { ctx, notifications, statuses };
}

test("requests rotate only inside the endpoint pool that owns the provider", async () => {
  const { primary, secondary, primaryPool, secondaryPool } = runtimes();
  const calls: Array<{ provider: string; apiKey: string | undefined }> = [];
  const pi = new MockPi();
  await registerMultiPoolKeyRotatorExtension(pi, {
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
  await registerMultiPoolKeyRotatorExtension(pi, {
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
  await registerMultiPoolKeyRotatorExtension(pi, {
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

test("each direct Pi registration denies a mismatched provider or API", async () => {
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
  await registerMultiPoolKeyRotatorExtension(pi, {
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

  const mismatchEvents = [
    await collect(
      primaryRegistration.streamSimple(model("provider-secondary"), {}, { apiKey: "caller-key" }),
    ),
    await collect(
      primaryRegistration.streamSimple(
        { provider: "provider-primary", api: "anthropic-messages", id: "wrong-api" },
        {},
        { apiKey: "caller-key" },
      ),
    ),
  ];

  assert.deepEqual(calls, []);
  assert.deepEqual(
    mismatchEvents.map((events) => events.map((event) => event.type)),
    [["error"], ["error"]],
  );
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
  await registerMultiPoolKeyRotatorExtension(pi, {
    pools: [{ config: primary, pool: primaryPool }],
    baseStreamSimple: () => new TestEventStream(),
    createEventStream: () => new TestEventStream(),
  });
  const preflightReads = snapshotReads;
  const statuses: string[] = [];
  const ctx: ExtensionContextLike = {
    model: model("provider-primary"),
    ui: {
      notify() {},
      setStatus(_key, text) {
        if (text) statuses.push(text);
      },
    },
  };

  await pi.commands.get("key-rotator")!.handler("status primary", ctx);
  assert.equal(snapshotReads - preflightReads, 1);
  assert.match(statuses.at(-1) ?? "", /^primary:/);
});

test("doctor FAIL uses an error notification and never refreshes a broken footer", async () => {
  const { primary, primaryPool } = runtimes();
  const pi = new MockPi();
  await registerMultiPoolKeyRotatorExtension(pi, {
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


test("state preflight disables only the invalid pool and never mutates its evidence", async () => {
  const clock = mutableClock(1_000).clock;
  const primary = config("primary", "provider-primary", "primary");
  const secondary = config("secondary", "provider-secondary", "secondary");
  const primaryStore = new TrackingStateStore(createInitialPoolState(primary, clock.now()));
  const wrongPoolState = createInitialPoolState(secondary, clock.now());
  wrongPoolState.poolId = "some-other-pool";
  const secondaryStore = new TrackingStateStore(wrongPoolState);
  const evidenceBefore = JSON.stringify(secondaryStore.state);
  const registered = new Map<string, string>();
  const pi = new MockPi();

  await registerMultiPoolKeyRotatorExtension(pi, {
    pools: [
      { config: primary, pool: new KeyPool(primary, primaryStore, clock) },
      { config: secondary, pool: new KeyPool(secondary, secondaryStore, clock) },
    ],
    baseStreamSimple: () => new TestEventStream(),
    createEventStream: () => new TestEventStream(),
    onRegistered: (targets) => {
      for (const [provider, api] of targets) registered.set(provider, api);
    },
  });

  assert.ok(pi.providers.has("provider-primary"));
  assert.equal(pi.providers.has("provider-secondary"), false);
  assert.deepEqual([...registered], [["provider-primary", "openai-completions"]]);
  assert.equal(primaryStore.reads, 1);
  assert.equal(secondaryStore.reads, 1);
  assert.equal(primaryStore.transactions, 0);
  assert.equal(secondaryStore.transactions, 0);
  assert.equal(JSON.stringify(secondaryStore.state), evidenceBefore);

  const ui = uiRecorder(model("provider-secondary"));
  await pi.emit("session_start", {}, ui.ctx);
  assert.match(ui.statuses.at(-1) ?? "", /rotation inactive.*pool "secondary".*disabled/i);
  await pi.commands.get("key-rotator")!.handler("status secondary", ui.ctx);
  assert.match(ui.notifications.at(-1)?.message ?? "", /evidence is preserved/i);
  assert.equal(secondaryStore.transactions, 0);
  assert.equal(JSON.stringify(secondaryStore.state), evidenceBefore);
});

test("unmanaged and API-mismatched models clear active selection and fence bare mutations", async () => {
  const { primary, secondary, primaryPool, secondaryPool } = runtimes();
  const pi = new MockPi();
  await registerMultiPoolKeyRotatorExtension(pi, {
    pools: [
      { config: primary, pool: primaryPool },
      { config: secondary, pool: secondaryPool },
    ],
    baseStreamSimple: () => new TestEventStream(),
    createEventStream: () => new TestEventStream(),
  });
  const ui = uiRecorder(model("provider-primary"));
  const command = pi.commands.get("key-rotator")!;

  await pi.emit("session_start", {}, ui.ctx);
  await command.handler("next", ui.ctx);
  assert.equal((await primaryPool.snapshot()).currentKeyId, "key-2");

  const unmanaged = { provider: "ordinary-provider", api: "openai-completions", id: "ordinary" };
  await pi.emit("model_select", { model: unmanaged }, ui.ctx);
  assert.match(ui.statuses.at(-1) ?? "", /rotation inactive.*unmanaged/i);
  const primaryBeforeRefusedReset = await primaryPool.snapshot();
  await command.handler("reset", ui.ctx);
  const primaryAfterRefusedReset = await primaryPool.snapshot();
  assert.equal(primaryAfterRefusedReset.currentKeyId, "key-2");
  assert.equal(primaryAfterRefusedReset.generation, primaryBeforeRefusedReset.generation);
  assert.match(ui.notifications.at(-1)?.message ?? "", /bare destructive command was refused/i);

  const mismatch = { provider: "provider-secondary", api: "anthropic-messages", id: "wrong-api" };
  await pi.emit("model_select", { model: mismatch }, ui.ctx);
  assert.match(ui.statuses.at(-1) ?? "", /rotation inactive.*API mismatch/i);
  assert.match(ui.statuses.at(-1) ?? "", /selected "anthropic-messages".*configured "openai-completions"/i);
  await command.handler("next", ui.ctx);
  assert.equal((await secondaryPool.snapshot()).currentKeyId, "key-1");
  assert.match(ui.notifications.at(-1)?.message ?? "", /bare destructive command was refused/i);

  // An explicit selector remains an intentional administrative action.
  await command.handler("next secondary", ui.ctx);
  assert.equal((await secondaryPool.snapshot()).currentKeyId, "key-2");
  assert.match(ui.statuses.at(-1) ?? "", /rotation inactive.*API mismatch/i);
});

test("a deferred session snapshot cannot paint a newer UI owner", async () => {
  const { primary, primaryPool } = runtimes();
  const pi = new MockPi();
  await registerMultiPoolKeyRotatorExtension(pi, {
    pools: [{ config: primary, pool: primaryPool }],
    baseStreamSimple: () => new TestEventStream(),
    createEventStream: () => new TestEventStream(),
  });
  const originalSnapshot = primaryPool.snapshot.bind(primaryPool);
  const staleSnapshot = await originalSnapshot();
  const pending = deferred<PoolSnapshot>();
  let pendingReads = 0;
  primaryPool.snapshot = async () => {
    pendingReads += 1;
    return pending.promise;
  };

  const oldUi = uiRecorder(model("provider-primary"));
  const oldStart = pi.emit("session_start", {}, oldUi.ctx);
  await Promise.resolve();
  assert.equal(pendingReads, 1);

  const newUi = uiRecorder({
    provider: "ordinary-provider",
    api: "openai-completions",
    id: "ordinary",
  });
  await pi.emit("session_start", {}, newUi.ctx);
  assert.match(newUi.statuses.at(-1) ?? "", /rotation inactive.*unmanaged/i);
  pending.resolve(staleSnapshot);
  await oldStart;

  assert.deepEqual(oldUi.statuses, []);
  assert.match(newUi.statuses.at(-1) ?? "", /rotation inactive.*unmanaged/i);
  primaryPool.snapshot = originalSnapshot;
});

test("deferred command results are silent after model selection changes", async () => {
  const { primary, primaryPool } = runtimes();
  const pi = new MockPi();
  await registerMultiPoolKeyRotatorExtension(pi, {
    pools: [{ config: primary, pool: primaryPool }],
    baseStreamSimple: () => new TestEventStream(),
    createEventStream: () => new TestEventStream(),
  });
  const originalSnapshot = primaryPool.snapshot.bind(primaryPool);
  const result = await originalSnapshot();
  const ui = uiRecorder(model("provider-primary"));
  await pi.emit("session_start", {}, ui.ctx);

  const pending = deferred<PoolSnapshot>();
  let pendingReads = 0;
  primaryPool.snapshot = async () => {
    pendingReads += 1;
    return pending.promise;
  };
  const noticesBefore = ui.notifications.length;
  const commandResult = pi.commands.get("key-rotator")!.handler("status primary", ui.ctx);
  await Promise.resolve();
  assert.equal(pendingReads, 1);

  await pi.emit(
    "model_select",
    { model: { provider: "ordinary-provider", api: "openai-completions", id: "ordinary" } },
    ui.ctx,
  );
  pending.resolve(result);
  await commandResult;

  assert.equal(ui.notifications.length, noticesBefore);
  assert.match(ui.statuses.at(-1) ?? "", /rotation inactive.*unmanaged/i);
  primaryPool.snapshot = originalSnapshot;
});

test("a queued request footer stays newer than an earlier deferred snapshot", async () => {
  const { primary, primaryPool } = runtimes();
  const pi = new MockPi();
  await registerMultiPoolKeyRotatorExtension(pi, {
    pools: [{ config: primary, pool: primaryPool }],
    baseStreamSimple: successfulStream([]),
    createEventStream: () => new TestEventStream(),
  });
  const originalSnapshot = primaryPool.snapshot.bind(primaryPool);
  const staleSnapshot = await originalSnapshot();
  const pending = deferred<PoolSnapshot>();
  primaryPool.snapshot = async () => pending.promise;
  const ui = uiRecorder(model("provider-primary"));

  const startup = pi.emit("session_start", {}, ui.ctx);
  await Promise.resolve();
  await collect(pi.providers.get("provider-primary")!.streamSimple(model("provider-primary"), {}));
  await Promise.resolve();
  assert.match(ui.statuses.at(-1) ?? "", /^primary: key-1 1\/2$/);

  pending.resolve(staleSnapshot);
  await startup;
  assert.match(ui.statuses.at(-1) ?? "", /^primary: key-1 1\/2$/);
  primaryPool.snapshot = originalSnapshot;
});
