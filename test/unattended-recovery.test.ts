import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { resolveConfig } from "../src/config.ts";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { createRotatingStream } from "../src/rotating-stream.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type { ModelLike, RotatorConfig, StreamSimpleLike } from "../src/types.ts";
import { assistantMessage, collect, makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

const model: ModelLike = { provider: "test-provider", api: "openai-completions", id: "test-model" };
const errorPolicy = {
  isContextOverflow: (message: Parameters<typeof assistantMessage>[1]) => isContextOverflow(message as never),
  isRetryableAssistantError: (message: Parameters<typeof assistantMessage>[1]) => isRetryableAssistantError(message as never),
};

function harness(baseStreamSimple: StreamSimpleLike, overrides: Partial<RotatorConfig> = {},
  customSleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>) {
  const config = makeConfig({ retryTransientAtAgentLevel: true, maxAttemptsPerRequest: 1, ...overrides });
  const time = mutableClock(1_000);
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, time.clock.now())), time.clock);
  const waits: number[] = [];
  const rotating = createRotatingStream({
    config, pool, baseStreamSimple, errorPolicy,
    createEventStream: () => new TestEventStream(), now: time.clock.now,
    sleep: customSleep ?? (async (delayMs) => { waits.push(delayMs); time.advance(delayMs); }),
  });
  return { rotating, pool, time, waits };
}

function responseStream(status: number, detail: string, headers: Record<string, string> = {}): StreamSimpleLike {
  return (receivedModel, _context, options) => {
    const stream = new TestEventStream();
    queueMicrotask(() => {
      void (async () => {
        await options?.onResponse?.({ status, headers }, receivedModel);
        stream.push({ type: "error", reason: "error", error: assistantMessage("error", {
          content: [], errorMessage: detail,
        }) });
      })();
    });
    return stream;
  };
}

async function finalError(h: ReturnType<typeof harness>, selectedModel = model) {
  const events = await collect(h.rotating(selectedModel, { messages: [] }));
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  return terminal!.error as ReturnType<typeof assistantMessage>;
}

test("local recovery configuration is opt-in, bounded, and present in both schema forms", async () => {
  const raw = { provider: "test", api: "openai-completions", keys: [
    { id: "one", value: "fake-one" }, { id: "two", value: "fake-two" },
  ] };
  const options = { configFile: "/tmp/local-recovery-config.json", homeDir: "/tmp", env: {} };
  const defaults = resolveConfig(raw, options);
  assert.equal(defaults.retryTransientAtAgentLevel, false);
  assert.equal(defaults.maxCooldownWaitMs, 0);
  const enabled = resolveConfig({ ...raw, retryTransientAtAgentLevel: true, maxCooldownWaitMs: 900_000 }, options);
  assert.equal(enabled.maxCooldownWaitMs, 900_000);
  for (const invalid of [-1, 900_001, 1.5, "60000"]) {
    assert.throws(() => resolveConfig({ ...raw, retryTransientAtAgentLevel: true, maxCooldownWaitMs: invalid } as never, options));
  }
  assert.throws(() => resolveConfig({ ...raw, retryTransientAtAgentLevel: "yes" } as never, options));
  assert.throws(() => resolveConfig({ ...raw, maxCooldownWaitMs: 1 }, options), /requires/);
  const schema = JSON.parse(await readFile(new URL("../docs/key-rotator.schema.json", import.meta.url), "utf8"));
  for (const properties of [schema.oneOf[0].properties, schema.$defs.pool.properties]) {
    assert.equal(properties.retryTransientAtAgentLevel.type, "boolean");
    assert.equal(properties.maxCooldownWaitMs.maximum, 900_000);
  }
});

for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
  test(`pre-output HTTP ${status} can use Pi's bounded outer retry`, async () => {
    const h = harness(responseStream(status, `${status} temporary provider failure; secret-one`));
    const error = await finalError(h);
    assert.equal(isRetryableAssistantError(error as never), true);
    assert.equal(isContextOverflow(error as never), false);
    assert.doesNotMatch(JSON.stringify(error), /secret-one/);
    assert.equal((await h.pool.snapshot()).totalAttempts, 1);
  });
}

for (const [status, detail] of [
  [400, "400 invalid request"], [401, "401 invalid key"], [402, "402 payment required"], [403, "403 permission denied"],
  [429, '{"error":{"type":"budget_exceeded","message":"budget empty"}}'],
  [429, '{"error":{"code":"insufficient_quota","message":"quota empty"}}'],
  [429, "429 quota exceeded"], [500, "500 billing problem"],
] as const) {
  test(`permanent/auth/quota failure remains terminal: ${status} ${detail}`, async () => {
    const h = harness(responseStream(status, detail));
    assert.equal(isRetryableAssistantError(await finalError(h) as never), false);
    assert.deepEqual(h.waits, []);
  });
}

test("outer retry remains off unless explicitly enabled", async () => {
  const h = harness(responseStream(503, "503 Service unavailable"), { retryTransientAtAgentLevel: false });
  assert.equal(isRetryableAssistantError(await finalError(h) as never), false);
});

test("Anthropic's exact in-band api_error is accounted as 500, not network/HTTP 200 success", async () => {
  const detail = JSON.stringify({ type: "error", error: { details: null, type: "api_error", message: "Internal server error" },
    request_id: "req_local_fixture_only" });
  const h = harness(responseStream(200, detail), { api: "anthropic-messages" });
  const error = await finalError(h, { ...model, api: "anthropic-messages" });
  assert.equal(isRetryableAssistantError(error as never), true);
  const snapshot = await h.pool.snapshot();
  assert.equal(snapshot.keys[0]?.lastStatus, 500);
  assert.equal(snapshot.keys[0]?.successes, 0);
  assert.equal(snapshot.targets[0]?.lastStatus, 500);
});

test("an in-band api_error does not override a real HTTP permission failure", async () => {
  const h = harness(responseStream(403, '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}'),
    { api: "anthropic-messages" });
  assert.equal(isRetryableAssistantError(await finalError(h, { ...model, api: "anthropic-messages" }) as never), false);
  assert.equal((await h.pool.snapshot()).keys[0]?.lastStatus, 403);
});

for (const detail of ["Connection error.", "Provider stream ended without a terminal event", "unknown deterministic rejection"]) {
  test(`status-less failures use the running host classifier: ${detail}`, async () => {
    const h = harness(() => { throw new Error(detail); });
    const error = await finalError(h);
    assert.equal(isRetryableAssistantError(error as never), detail !== "unknown deterministic rejection");
  });
}

for (const content of [
  [{ type: "text", text: "already visible" }],
  [{ type: "thinking", thinking: "already visible" }],
  [{ type: "toolCall", id: "fixture-call", name: "write", arguments: { path: "never-executed" } }],
]) {
  test(`visible ${content[0]?.type} is never replayed even with the outer-retry opt-in`, async () => {
    let calls = 0;
    const partial = assistantMessage("pending", { content });
    const h = harness((_model, _context, options) => {
      calls++;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          stream.push({ type: "start", partial });
          stream.push({ type: "error", reason: "error", error: { ...partial, stopReason: "error", errorMessage: "Internal server error" } });
        })();
      });
      return stream;
    });
    const error = await finalError(h);
    assert.equal(calls, 1);
    assert.equal(isRetryableAssistantError(error as never), false);
    assert.deepEqual(error.content, content);
  });
}

test("tool-call content present only in an error terminal cannot become retryable", async () => {
  const h = harness(() => {
    const stream = new TestEventStream();
    queueMicrotask(() => stream.push({ type: "error", reason: "error", error: assistantMessage("error", {
      content: [{ type: "toolCall", id: "fixture", name: "write", arguments: {} }], errorMessage: "Connection error.",
    }) }));
    return stream;
  });
  assert.equal(isRetryableAssistantError(await finalError(h) as never), false);
});

test("cooling healthy keys are awaited without a provider call or a health reset", async () => {
  let calls = 0;
  const h = harness(() => {
    calls++;
    const stream = new TestEventStream();
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") }));
    return stream;
  }, { maxCooldownWaitMs: 60_000 });
  for (const id of ["key-1", "key-2", "key-3"]) await h.pool.recordFailure(id, { status: 429, headers: { "retry-after": "10" } });
  const events = await collect(h.rotating(model, { messages: [] }));
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(calls, 1);
  assert.deepEqual(h.waits, [10_000]);
  const snapshot = await h.pool.snapshot();
  assert.equal(snapshot.totalAttempts, 1);
  assert.deepEqual(snapshot.keys.map((key) => key.failures), [1, 1, 1]);
});

test("503 Retry-After immediately stops all keys on that target and is waited out", async () => {
  let calls = 0;
  const h = harness(() => {
    calls++;
    const stream = new TestEventStream();
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") }));
    return stream;
  }, { targetFailureThreshold: 4, maxCooldownWaitMs: 60_000 });
  await h.pool.recordFailure("key-1", { status: 503, headers: { "Retry-After": "30" } });
  assert.equal(await h.pool.select(), null, "must not try another credential before Retry-After");
  await collect(h.rotating(model, { messages: [] }));
  assert.deepEqual(h.waits, [30_000]);
  assert.equal(calls, 1);
});

test("all-disabled credentials and over-budget cooldowns do not enter a wait/retry loop", async () => {
  for (const mode of ["disabled", "budget"] as const) {
    let calls = 0;
    const h = harness(() => { calls++; throw new Error("must not dispatch"); }, { maxCooldownWaitMs: 900_000 });
    for (const id of ["key-1", "key-2", "key-3"]) {
      await h.pool.recordFailure(id, mode === "disabled" ? { status: 401, headers: {} } :
        { status: 429, headers: {}, budgetExhausted: true });
    }
    const before = await h.pool.snapshot();
    assert.equal(isRetryableAssistantError(await finalError(h) as never), false);
    assert.equal(calls, 0);
    assert.deepEqual(h.waits, []);
    assert.deepEqual(await h.pool.snapshot(), before);
  }
});

test("cooldown waiting has a cumulative budget even if other workers extend the circuit", async () => {
  let calls = 0;
  let h: ReturnType<typeof harness>;
  h = harness(() => { calls++; throw new Error("must not dispatch"); }, {
    transientCooldownMs: 100, targetFailureThreshold: 1, maxCooldownWaitMs: 150,
  }, async (delay) => {
    h.waits.push(delay);
    h.time.advance(delay);
    await h.pool.recordNetworkFailure("key-1");
  });
  await h.pool.recordNetworkFailure("key-1");
  assert.equal(isRetryableAssistantError(await finalError(h) as never), false);
  assert.deepEqual(h.waits, [100]);
  assert.equal(calls, 0);
});

test("caller abort interrupts cooldown waiting and does not issue a request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const h = harness(() => { calls++; throw new Error("must not dispatch"); }, { maxCooldownWaitMs: 60_000 },
    async (_delay, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();
    });
  for (const id of ["key-1", "key-2", "key-3"]) await h.pool.recordFailure(id, { status: 429, headers: {} });
  const events = await collect(h.rotating(model, { messages: [] }, { signal: controller.signal }));
  assert.equal((events.at(-1)?.error as ReturnType<typeof assistantMessage>).stopReason, "aborted");
  assert.equal(calls, 0);
});

test("a state-write failure cannot acquire an outer retry just because its text mentions 503", async () => {
  const h = harness(responseStream(503, "503 Service unavailable"));
  h.pool.recordFailure = async () => { throw new Error("local write failed 503 secret-one"); };
  const error = await finalError(h);
  assert.equal(isRetryableAssistantError(error as never), false);
  assert.doesNotMatch(JSON.stringify(error), /secret-one/);
});
