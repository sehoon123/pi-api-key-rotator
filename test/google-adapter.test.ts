import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { createRotatingStream } from "../src/rotating-stream.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type { EventStreamFactory, StreamSimpleLike, ModelLike } from "../src/types.ts";
import { assistantMessage, collect, makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

for (const firstError of [
  { code: 429, status: "RESOURCE_EXHAUSTED", message: "rate limited" },
  { code: "429", type: "budget_exceeded", message: "budget exhausted" },
]) {
  test(`real Google adapter rotates JSON-only ${firstError.type ?? firstError.status} without custom fetch`, async (t) => {
    const seen: string[] = [];
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain the local fixture */ }
      seen.push(String(request.headers["x-goog-api-key"]));
      if (seen.length === 1) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: firstError }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = makeConfig({ api: "google-generative-ai", requestsPerKey: 20 });
    const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, Date.now())));
    const model = {
      api: config.api, provider: config.provider, id: "gemini-2.5-flash", name: "Local Google fixture",
      baseUrl: `http://127.0.0.1:${address.port}/v1beta`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 128,
    };
    const rotating = createRotatingStream({
      config, pool, baseStreamSimple: streamSimple as unknown as StreamSimpleLike,
      createEventStream: createAssistantMessageEventStream as unknown as EventStreamFactory,
    });
    const events = await collect(rotating(model, { messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }] }));
    assert.equal(events.at(-1)?.type, "done");
    assert.deepEqual(seen, ["secret-one", "secret-two"]);
    const snapshot = await pool.snapshot();
    assert.equal(snapshot.totalAttempts, 2);
    assert.equal(snapshot.keys[0]?.lastStatus, 429);
    assert.equal(snapshot.keys[0]?.disabled, false);
    assert.equal(snapshot.keys[0]?.available, false);
    assert.equal(snapshot.keys[1]?.successes, 1);
    assert.equal(snapshot.targets[0]?.failures, 0, "not a transport/circuit failure");
  });
}

for (const api of ["google-generative-ai", "google-vertex"]) {
  test(`${api} preserves native fetch and refuses caller custom transport before selecting a key`, async () => {
    const time = mutableClock(1000);
    const config = makeConfig({ api });
    const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, 1000)), time.clock);
    const model: ModelLike = { id: "google-test", api, provider: config.provider };
    let calls = 0;
    const rotating = createRotatingStream({
      config, pool,
      baseStreamSimple: (_model, _ctx, options) => {
        calls++;
        assert.ok(options?.fetch === undefined || options.fetch === globalThis.fetch);
        const stream = new TestEventStream();
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage() }));
        return stream;
      },
      createEventStream: () => new TestEventStream(),
    });
    assert.equal((await collect(rotating(model, { messages: [] }))).at(-1)?.type, "done");
    assert.equal((await collect(rotating(model, { messages: [] }, { fetch: globalThis.fetch }))).at(-1)?.type, "done");
    const events = await collect(rotating(model, { messages: [] }, { fetch: async () => new Response("unused") }));
    assert.equal(events.at(-1)?.type, "error");
    assert.match(JSON.stringify(events.at(-1)), /custom fetch/i);
    assert.equal(calls, 2);
    assert.equal((await pool.snapshot()).totalAttempts, 2);
  });
}

for (const [text, expected] of [
  ['{"error":{"code":403,"message":"forbidden"}}', 403],
  ['{"error":{"code":400,"message":"bad input"}}', 400],
  ['{"error":{"code":"429","type":"budget_exceeded"}}', 429],
  ['{"error":{"code":200,"message":"not an error status"}}', null],
  ['{"code":429,"message":"not a Google error envelope"}', null],
  ['{"error":{"code":"429foo"}}', null],
  ['some request said 429 {"error":{"code":429}}', null],
  ['{"error":{"message":"429 budget_exceeded"}}', null],
  ['{"error":{"code":429}}' + ' '.repeat(16384), null],
] as const) {
  test(`Google JSON status fallback: ${text.slice(0, 75)}`, async () => {
    const config = makeConfig({ api: "google-generative-ai", maxAttemptsPerRequest: 1 });
    const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, 1000)));
    const rotating = createRotatingStream({
      config, pool, createEventStream: () => new TestEventStream(),
      baseStreamSimple: () => {
        const stream = new TestEventStream();
        queueMicrotask(() => stream.push({ type: "error", reason: "error", error: assistantMessage("error", { content: [], errorMessage: text }) }));
        return stream;
      },
    });
    await collect(rotating({ id: "g", api: config.api, provider: config.provider }, { messages: [] }));
    assert.equal((await pool.snapshot()).keys[0]?.lastStatus, expected);
  });
}
