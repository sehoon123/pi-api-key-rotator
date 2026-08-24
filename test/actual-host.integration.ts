import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { streamSimple as piAnthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as piOpenAIStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { createRotatingStream } from "../src/rotating-stream.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type { AssistantEventLike, ModelLike, StreamSimpleLike } from "../src/types.ts";
import { assistantMessage, collect, makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

function successfulSse(model: string): string {
  const first = {
    id: "chatcmpl-local",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
  };
  const last = {
    id: "chatcmpl-local",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
}

function actualModel(baseUrl: string): ModelLike {
  return {
    api: "openai-completions",
    provider: "test-provider",
    id: "local-model",
    name: "Local model",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  } as ModelLike;
}

function terminalError(event: AssistantEventLike | undefined): Record<PropertyKey, unknown> {
  assert.equal(event?.type, "error");
  return (event as Extract<AssistantEventLike, { type: "error" }>).error as unknown as Record<PropertyKey, unknown>;
}

test("Pi 0.84.x OpenAI adapter stays within maxAttempts and emits a retry-neutral terminal", async (t) => {
  const authorization: string[] = [];
  let returnSuccess = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before replying so the real adapter completes normally.
    }
    authorization.push(String(request.headers.authorization ?? ""));
    if (!returnSuccess || authorization.length % 2 === 1) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
      response.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(successfulSse("local-model"));
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const baseUrl = await listen(server);

  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const time = mutableClock(1_000);
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: piOpenAIStreamSimple as unknown as StreamSimpleLike,
    createEventStream: () => new TestEventStream(),
  });

  // Pi would retry both of these raw messages. The rotator must never expose
  // either phrase after it has consumed its own attempt budget.
  for (const errorMessage of ["429 rate limited", "rate_limit_error"]) {
    const raw = assistantMessage("error", { errorMessage });
    assert.equal(isRetryableAssistantError(raw as never), true);
  }

  let hostInvocations = 0;
  let events: AssistantEventLike[] = [];
  do {
    hostInvocations += 1;
    events = await collect(rotating(actualModel(baseUrl), { messages: [] }));
  } while (
    events.at(-1)?.type === "error" &&
    isRetryableAssistantError(terminalError(events.at(-1)) as never) &&
    hostInvocations < 4
  );

  assert.equal(hostInvocations, 1);
  assert.equal(authorization.length, config.maxAttemptsPerRequest);
  assert.deepEqual(authorization, ["Bearer secret-one", "Bearer secret-two"]);
  const finalized = terminalError(events.at(-1));
  assert.equal(isRetryableAssistantError(finalized as never), false);
  assert.match(JSON.stringify(finalized.diagnostics), /slow down/);
  assert.doesNotMatch(JSON.stringify(finalized), /secret-one|secret-two/);
  assert.deepEqual((await pool.snapshot()).keys.map((key) => key.cooldownUntil), [121_000, 121_000]);

  // A separate logical request may succeed after one in-wrapper failover. It
  // still makes exactly two physical calls and produces one semantic stream.
  returnSuccess = true;
  authorization.length = 0;
  time.advance(121_000);
  const successEvents = await collect(rotating(actualModel(baseUrl), { messages: [] }));
  assert.equal(authorization.length, 2);
  assert.equal(successEvents.at(-1)?.type, "done");
  assert.equal(successEvents.filter((event) => event.type === "text_delta").length, 1);
});


test("Pi 0.84.x Anthropic HTTP-200 SSE failures fail over without leaking structural output", async (t) => {
  const apiKeys: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain request body.
    }
    apiKeys.push(String(request.headers["x-api-key"] ?? ""));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n',
    );
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const openAiBaseUrl = await listen(server);
  const baseUrl = new URL(openAiBaseUrl).origin;

  const base = makeConfig();
  const config = makeConfig({
    provider: "anthropic-target",
    api: "anthropic-messages",
    keys: base.keys.slice(0, 2),
    maxAttemptsPerRequest: 2,
  });
  const time = mutableClock(1_000);
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, time.clock.now())), time.clock);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: piAnthropicStreamSimple as unknown as StreamSimpleLike,
    createEventStream: () => new TestEventStream(),
  });
  const anthropicModel = {
    api: "anthropic-messages",
    provider: "anthropic-target",
    id: "local-claude",
    name: "Local Claude",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  } as ModelLike;

  const events = await collect(rotating(anthropicModel, { messages: [] }));
  assert.deepEqual(apiKeys, ["secret-one", "secret-two"]);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const finalized = terminalError(events[0]);
  assert.equal(isRetryableAssistantError(finalized as never), false);
  assert.match(JSON.stringify(finalized.diagnostics), /rate_limit_error/);
  const snapshot = await pool.snapshot();
  assert.deepEqual(snapshot.keys.map((key) => key.lastStatus), [429, 429]);
});
