import assert from "node:assert/strict";
import { test } from "node:test";
import { registerKeyRotatorExtension } from "../src/extension.ts";
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

  on(event: "session_start" | "model_select" | "session_shutdown", handler: (event: unknown, ctx: ExtensionContextLike) => Promise<void> | void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
}

function multiConfig(overrides: Partial<RotatorConfig> = {}): RotatorConfig {
  return {
    ...makeConfig(),
    poolId: "ibm-ica-shared",
    targets: [
      { provider: "ibm-ica-claude", api: "anthropic-messages" },
      { provider: "ibm-ica", api: "openai-completions" },
    ],
    provider: "ibm-ica-claude",
    api: "anthropic-messages",
    requestsPerKey: 2,
    ...overrides,
  };
}

function model(provider: string, api: string): ModelLike {
  return { provider, api, id: `${provider}-model` };
}

test("registers both IBM ICA providers against one shared key pool", async () => {
  const config = multiConfig();
  const time = mutableClock(1_000);
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, time.clock.now())), time.clock);
  const calls: Array<{ provider: string; apiKey: string | undefined }> = [];

  const baseStream: StreamSimpleLike = (selectedModel, _context, options) => {
    calls.push({ provider: selectedModel.provider, apiKey: options?.apiKey });
    const stream = new TestEventStream();
    queueMicrotask(async () => {
      await options?.onResponse?.({ status: 200, headers: {} }, selectedModel);
      const message = assistantMessage("stop", {
        provider: selectedModel.provider,
        api: selectedModel.api,
        model: selectedModel.id,
      });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };

  const pi = new MockPi();
  registerKeyRotatorExtension(pi, {
    config,
    pool,
    baseStreamSimple: baseStream,
    createEventStream: () => new TestEventStream(),
  });

  assert.deepEqual([...pi.providers.keys()], ["ibm-ica-claude", "ibm-ica"]);
  assert.equal(pi.providers.get("ibm-ica-claude")?.api, "anthropic-messages");
  assert.equal(pi.providers.get("ibm-ica")?.api, "openai-completions");

  await collect(pi.providers.get("ibm-ica-claude")!.streamSimple(model("ibm-ica-claude", "anthropic-messages"), {}));
  await collect(pi.providers.get("ibm-ica")!.streamSimple(model("ibm-ica", "openai-completions"), {}));
  await collect(pi.providers.get("ibm-ica")!.streamSimple(model("ibm-ica", "openai-completions"), {}));

  assert.deepEqual(calls, [
    { provider: "ibm-ica-claude", apiKey: "secret-one" },
    { provider: "ibm-ica", apiKey: "secret-one" },
    { provider: "ibm-ica", apiKey: "secret-two" },
  ]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.totalAttempts, 3);
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.attempts, 2);
  assert.equal(snapshot.keys.find((key) => key.id === "key-2")?.attempts, 1);
});

test("an authentication failure on the Claude target disables that key for the OpenAI target", async () => {
  const config = multiConfig({ requestsPerKey: 20 });
  const time = mutableClock(1_000);
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, time.clock.now())), time.clock);
  const calls: Array<{ provider: string; apiKey: string | undefined }> = [];

  const baseStream: StreamSimpleLike = (selectedModel, _context, options) => {
    calls.push({ provider: selectedModel.provider, apiKey: options?.apiKey });
    const stream = new TestEventStream();
    queueMicrotask(async () => {
      const status = selectedModel.provider === "ibm-ica-claude" && options?.apiKey === "secret-one" ? 401 : 200;
      await options?.onResponse?.({ status, headers: {} }, selectedModel);
      const message = assistantMessage(status === 200 ? "stop" : "error", {
        provider: selectedModel.provider,
        api: selectedModel.api,
        model: selectedModel.id,
        ...(status === 200 ? {} : { errorMessage: "unauthorized" }),
      });
      if (status === 200) stream.push({ type: "done", reason: "stop", message });
      else stream.push({ type: "error", reason: "error", error: message });
    });
    return stream;
  };

  const pi = new MockPi();
  registerKeyRotatorExtension(pi, {
    config,
    pool,
    baseStreamSimple: baseStream,
    createEventStream: () => new TestEventStream(),
  });

  await collect(pi.providers.get("ibm-ica-claude")!.streamSimple(model("ibm-ica-claude", "anthropic-messages"), {}));
  await collect(pi.providers.get("ibm-ica")!.streamSimple(model("ibm-ica", "openai-completions"), {}));

  assert.deepEqual(calls, [
    { provider: "ibm-ica-claude", apiKey: "secret-one" },
    { provider: "ibm-ica-claude", apiKey: "secret-two" },
    { provider: "ibm-ica", apiKey: "secret-two" },
  ]);
  assert.equal((await pool.snapshot()).keys.find((key) => key.id === "key-1")?.disabled, true);
});
