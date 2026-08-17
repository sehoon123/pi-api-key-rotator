import assert from "node:assert/strict";
import { test } from "node:test";
import { compactStatus, formatStatus, registerKeyRotatorExtension } from "../src/extension.ts";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type {
  ExtensionApiLike,
  ExtensionContextLike,
  PoolSnapshot,
  StreamSimpleLike,
} from "../src/types.ts";
import { makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

class MockPi implements ExtensionApiLike {
  provider:
    | {
        name: string;
        config: Parameters<ExtensionApiLike["registerProvider"]>[1];
      }
    | undefined;
  readonly commands = new Map<
    string,
    { description: string; handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void }
  >();
  readonly handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContextLike) => Promise<void> | void>
  >();

  registerProvider(name: string, config: Parameters<ExtensionApiLike["registerProvider"]>[1]): void {
    this.provider = { name, config };
  }

  registerCommand(name: string, options: Parameters<ExtensionApiLike["registerCommand"]>[1]): void {
    this.commands.set(name, options);
  }

  on(
    event: "session_start" | "model_select" | "session_shutdown",
    handler: (event: unknown, ctx: ExtensionContextLike) => Promise<void> | void,
  ): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async emit(event: "session_start" | "model_select" | "session_shutdown", payload: unknown, ctx: ExtensionContextLike) {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
}

function makeUi() {
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  return {
    notifications,
    statuses,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push(type === undefined ? { message } : { message, type });
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
    },
  };
}

const neverCalledStream: StreamSimpleLike = () => new TestEventStream();

test("registers a wrapper for the existing provider and uses only an env reference as fallback auth", () => {
  const time = mutableClock(100);
  const config = makeConfig();
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );
  const pi = new MockPi();

  registerKeyRotatorExtension(pi, {
    config,
    pool,
    baseStreamSimple: neverCalledStream,
    createEventStream: () => new TestEventStream(),
  });

  assert.equal(pi.provider?.name, "test-provider");
  assert.equal(pi.provider?.config.api, "openai-completions");
  assert.equal(pi.provider?.config.apiKey, "$TEST_KEY_1");
  assert.equal(typeof pi.provider?.config.streamSimple, "function");
  assert.ok(pi.commands.has("key-rotator"));
});

test("status, next, and reset commands never display raw API keys", async () => {
  const time = mutableClock(1_000);
  const config = makeConfig();
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );
  const pi = new MockPi();
  const ui = makeUi();
  const ctx: ExtensionContextLike = { ui: ui.ui };

  registerKeyRotatorExtension(pi, {
    config,
    pool,
    baseStreamSimple: neverCalledStream,
    createEventStream: () => new TestEventStream(),
  });

  await pi.emit("session_start", {}, ctx);
  const command = pi.commands.get("key-rotator");
  assert.ok(command);
  await command.handler("status", ctx);
  await command.handler("next", ctx);
  await command.handler("reset", ctx);

  const rendered = JSON.stringify({ notifications: ui.notifications, statuses: ui.statuses });
  assert.doesNotMatch(rendered, /secret-one|secret-two|secret-three/);
  assert.match(rendered, /key-1/);
  assert.match(rendered, /key-2/);
  assert.equal((await pool.snapshot()).totalAttempts, 0);
});

test("model_select warns when the configured API does not match the selected model", async () => {
  const time = mutableClock(1_000);
  const config = makeConfig();
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );
  const pi = new MockPi();
  const ui = makeUi();
  const ctx: ExtensionContextLike = { ui: ui.ui };

  registerKeyRotatorExtension(pi, {
    config,
    pool,
    baseStreamSimple: neverCalledStream,
    createEventStream: () => new TestEventStream(),
  });

  await pi.emit(
    "model_select",
    { model: { provider: "test-provider", api: "anthropic-messages", id: "claude" } },
    ctx,
  );
  assert.equal(ui.notifications.at(-1)?.type, "error");
  assert.match(ui.notifications.at(-1)?.message ?? "", /API values match/);
});

test("session shutdown clears the footer status", async () => {
  const time = mutableClock(1_000);
  const config = makeConfig();
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );
  const pi = new MockPi();
  const ui = makeUi();
  const ctx: ExtensionContextLike = { ui: ui.ui };

  registerKeyRotatorExtension(pi, {
    config,
    pool,
    baseStreamSimple: neverCalledStream,
    createEventStream: () => new TestEventStream(),
  });

  await pi.emit("session_start", {}, ctx);
  await pi.emit("session_shutdown", {}, ctx);
  assert.deepEqual(ui.statuses.at(-1), { key: "pi-api-key-rotator", text: undefined });
});

test("status formatting includes operational data but not environment values", () => {
  const snapshot: PoolSnapshot = {
    currentKeyId: "primary",
    requestsOnCurrent: 4,
    requestsPerKey: 20,
    totalAttempts: 24,
    updatedAt: 100,
    keys: [
      {
        id: "primary",
        env: "VERY_SECRET_ENV",
        current: true,
        available: true,
        attempts: 24,
        successes: 23,
        failures: 1,
        disabled: false,
        cooldownUntil: 0,
        lastStatus: 200,
        lastAttemptAt: 100,
        lastSuccessAt: 100,
        lastFailureAt: 50,
      },
    ],
  };

  assert.equal(compactStatus(snapshot, 100), "keys: primary 4/20");
  const detailed = formatStatus(snapshot, "company-ai", 100);
  assert.match(detailed, /attempts=24/);
  assert.doesNotMatch(detailed, /VERY_SECRET_ENV/);
});
