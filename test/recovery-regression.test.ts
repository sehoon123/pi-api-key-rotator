import assert from "node:assert/strict";
import { test } from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { createRotatingStream } from "../src/rotating-stream.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type { AssistantEventLike, ModelLike, RotatorConfig, StreamSimpleLike } from "../src/types.ts";
import { assistantMessage, collect, makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

const model: ModelLike = { provider: "test-provider", api: "openai-completions", id: "test-model" };

function harness(baseStreamSimple: StreamSimpleLike, overrides: Partial<RotatorConfig> = {}) {
  const config = makeConfig(overrides);
  const { clock } = mutableClock(1_000);
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, clock.now())), clock);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple,
    createEventStream: () => new TestEventStream(),
    errorPolicy: {
      isContextOverflow: (message) => isContextOverflow(message as never),
      isRetryableAssistantError: (message) => isRetryableAssistantError(message as never),
    },
  });
  return { rotating, pool };
}

function terminalError(events: AssistantEventLike[]) {
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  return terminal!.error as ReturnType<typeof assistantMessage>;
}

for (const [api, status, detail] of [
  ["anthropic-messages", 400, "400 prompt is too long: 213462 tokens > 200000 maximum"],
  ["anthropic-messages", 413, '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}'],
  ["openai-responses", 400, "OpenAI API error (400): Your input exceeds the context window of this model"],
  ["google-generative-ai", 400, "400 The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"],
] as const) {
  test(`context overflow remains recognizable to Pi: ${api} / ${status}`, async () => {
    let calls = 0;
    const { rotating, pool } = harness((receivedModel, _context, options) => {
      calls++;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status, headers: {} }, receivedModel);
          stream.push({ type: "error", reason: "error", error: assistantMessage("error", {
            content: [], errorMessage: `${detail}; credential secret-one`,
          }) });
        })();
      });
      return stream;
    }, { api });
    const error = terminalError(await collect(rotating({ ...model, api }, { messages: [] })));
    assert.equal(calls, 1);
    assert.equal(isContextOverflow(error as never), true);
    assert.equal(isRetryableAssistantError(error as never), false);
    assert.doesNotMatch(JSON.stringify(error), /secret-one/);
    const snapshot = await pool.snapshot();
    assert.equal(snapshot.keys[0]?.disabled, false);
    assert.equal(snapshot.targets[0]?.consecutiveFailures, 0);
  });
}

test("a transient terminal after HTTP 200 and empty structure fails over", async () => {
  let calls = 0;
  const { rotating, pool } = harness((receivedModel, _context, options) => {
    const call = ++calls;
    const stream = new TestEventStream();
    queueMicrotask(() => {
      void (async () => {
        await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
        if (call === 1) {
          stream.push({ type: "start", partial: assistantMessage("pending", { content: [] }) });
          stream.push({ type: "text_start", contentIndex: 0, partial: assistantMessage("pending", { content: [] }) });
          stream.push({ type: "error", reason: "error", error: assistantMessage("error", {
            content: [], errorMessage: "Connection error.",
          }) });
        } else stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
      })();
    });
    return stream;
  });
  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys[0]?.lastStatus, null);
  assert.equal(snapshot.keys[0]?.failures, 1);
  assert.equal(snapshot.keys[1]?.successes, 1);
});

for (const failure of ["throw", "missing-terminal"] as const) {
  test(`an HTTP 200 body ${failure} before semantic output can fail over`, async () => {
    let calls = 0;
    const { rotating, pool } = harness((receivedModel, _context, options) => {
      if (++calls === 1) return {
        push(_event: AssistantEventLike) {},
        result: async () => assistantMessage("error"),
        async *[Symbol.asyncIterator]() {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          yield { type: "start", partial: assistantMessage("pending", { content: [] }) };
          if (failure === "throw") throw new Error("terminated");
        },
      };
      const stream = new TestEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") }));
      return stream;
    });
    const events = await collect(rotating(model, { messages: [] }));
    assert.equal(calls, 2);
    assert.deepEqual(events.map((event) => event.type), ["done"]);
    assert.equal((await pool.snapshot()).keys[0]?.lastStatus, null);
  });
}

for (const [status, detail, retryNetworkErrors] of [
  [200, "Connection error.", false],
  [400, "400 invalid request: network error is not a valid field", true],
  [429, "429 rate limit: prompt is too long", true],
] as const) {
  test(`recovery respects HTTP ${status} and retryNetworkErrors=${retryNetworkErrors}`, async () => {
    let calls = 0;
    const { rotating } = harness((receivedModel, _context, options) => {
      calls++;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status, headers: {} }, receivedModel);
          stream.push({ type: "error", reason: "error", error: assistantMessage("error", {
            content: [], errorMessage: detail,
          }) });
        })();
      });
      return stream;
    }, { maxAttemptsPerRequest: 1, retryNetworkErrors });
    const error = terminalError(await collect(rotating(model, { messages: [] })));
    assert.equal(calls, 1);
    assert.equal(isContextOverflow(error as never), false);
    assert.equal(isRetryableAssistantError(error as never), false);
  });
}

test("already visible output is never replayed for either overflow or transport failure", async () => {
  for (const detail of ["prompt is too long", "Connection error."]) {
    let calls = 0;
    const visible = assistantMessage("pending", { content: [{ type: "text", text: "already visible" }] });
    const { rotating } = harness((receivedModel, _context, options) => {
      calls++;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          stream.push({ type: "start", partial: visible });
          stream.push({ type: "error", reason: "error", error: { ...visible, stopReason: "error", errorMessage: detail } });
        })();
      });
      return stream;
    });
    const error = terminalError(await collect(rotating(model, { messages: [] })));
    assert.equal(calls, 1);
    assert.equal(isContextOverflow(error as never), false);
    assert.equal(isRetryableAssistantError(error as never), false);
    assert.deepEqual(error.content, visible.content);
  }
});

test("HTTP 200 transport failures still obey the target circuit and wrapper attempt budget", async () => {
  let calls = 0;
  const { rotating, pool } = harness((receivedModel, _context, options) => {
    calls++;
    const stream = new TestEventStream();
    queueMicrotask(() => {
      void (async () => {
        await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
        stream.push({ type: "error", reason: "error", error: assistantMessage("error", {
          content: [], errorMessage: "Connection error.",
        }) });
      })();
    });
    return stream;
  });
  const error = terminalError(await collect(rotating(model, { messages: [] })));
  assert.equal(calls, 2);
  assert.equal(isRetryableAssistantError(error as never), false);
  assert.match(JSON.stringify(error.diagnostics), /exhausted 2 attempt/);
  assert.equal((await pool.snapshot()).targets[0]?.consecutiveFailures, 2);
});
