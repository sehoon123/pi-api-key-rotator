import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { createRotatingStream } from "../src/rotating-stream.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type {
  AssistantEventLike,
  ModelLike,
  ProviderResponseLike,
  RotatorConfig,
  StreamOptionsLike,
  StreamSimpleLike,
} from "../src/types.ts";
import { assistantMessage, collect, makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

const model: ModelLike = {
  api: "openai-completions",
  provider: "test-provider",
  id: "test-model",
  baseUrl: "https://example.invalid/v1",
};

function setup(config: RotatorConfig, time = mutableClock(1_000)) {
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);
  return { pool, time };
}

function scriptedHttpStream(
  script: Array<{ status?: number; headers?: Record<string, string>; networkError?: string }>,
  observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }>,
): StreamSimpleLike {
  let call = 0;
  return (receivedModel, _context, options) => {
    const step = script[call];
    call += 1;
    observed.push({ apiKey: options?.apiKey, maxRetries: options?.maxRetries });
    const stream = new TestEventStream();

    queueMicrotask(() => {
      void (async () => {
        stream.push({ type: "start", partial: assistantMessage("pending") });
        if (!step || step.networkError) {
          stream.push({
            type: "error",
            reason: "error",
            error: assistantMessage("error", {
              content: [],
              errorMessage: step?.networkError ?? "network error",
            }),
          });
          return;
        }

        const response: ProviderResponseLike = { status: step.status ?? 200, headers: step.headers ?? {} };
        await options?.onResponse?.(response, receivedModel);
        if (response.status >= 400) {
          stream.push({
            type: "error",
            reason: "error",
            error: assistantMessage("error", {
              content: [],
              errorMessage: `HTTP ${response.status}`,
            }),
          });
          return;
        }

        stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: assistantMessage("pending") });
        stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
      })();
    });
    return stream;
  };
}

test("429 is discarded and the same logical request succeeds with the next key", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2, requestsPerKey: 20 });
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const seenResponses: number[] = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream(
      [
        { status: 429, headers: { "retry-after": "3" } },
        { status: 200 },
      ],
      observed,
    ),
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(
    rotating(model, { messages: [] }, {
      maxRetries: 9,
      onResponse: (response) => {
        seenResponses.push(response.status);
      },
    }),
  );

  assert.deepEqual(
    observed.map((entry) => entry.apiKey),
    ["secret-one", "secret-two"],
  );
  assert.deepEqual(
    observed.map((entry) => entry.maxRetries),
    [0, 0],
  );
  assert.deepEqual(seenResponses, [429, 200]);
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(events.filter((event) => event.type === "error").length, 0);

  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.failures, 1);
  assert.equal(snapshot.keys.find((key) => key.id === "key-2")?.successes, 1);
});

test("rotation counts actual provider calls across independent agent turns", async () => {
  const config = makeConfig({ requestsPerKey: 2 });
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream(Array.from({ length: 5 }, () => ({ status: 200 })), observed),
    createEventStream: () => new TestEventStream(),
  });

  for (let index = 0; index < 5; index += 1) {
    const events = await collect(rotating(model, { messages: [] }));
    assert.equal(events.at(-1)?.type, "done");
  }

  assert.deepEqual(
    observed.map((entry) => entry.apiKey),
    ["secret-one", "secret-one", "secret-two", "secret-two", "secret-three"],
  );
});

test("401 permanently disables the failed key and retries with the next key", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream([{ status: 401 }, { status: 200 }], observed),
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(events.at(-1)?.type, "done");
  const snapshot = await pool.snapshot();
  const first = snapshot.keys.find((key) => key.id === "key-1");
  assert.equal(first?.disabled, true);
  assert.equal(first?.failures, 1);
  assert.equal(snapshot.currentKeyId, "key-2");
});

test("a non-retriable 400 response is forwarded without trying another key", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream([{ status: 400 }], observed),
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(observed.length, 1);
  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys[0]?.failures, 1);
  assert.equal(snapshot.keys[1]?.attempts, 0);
});

test("a failure before an HTTP response fails over when retryNetworkErrors is enabled", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream([{ networkError: "fetch failed" }, { status: 200 }], observed),
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(
    observed.map((entry) => entry.apiKey),
    ["secret-one", "secret-two"],
  );
  assert.equal((await pool.snapshot()).keys[0]?.failures, 1);
});

test("exhausted failover emits one sanitized terminal error", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream(
      [
        { status: 429, headers: { "retry-after": "60" } },
        { status: 429, headers: { "retry-after": "60" } },
      ],
      observed,
    ),
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const terminal = events[0];
  assert.equal(terminal?.type, "error");
  const message =
    terminal?.type === "error" && "error" in terminal
      ? (terminal.error as { errorMessage?: string }).errorMessage ?? ""
      : "";
  assert.match(message, /exhausted 2 attempt/i);
  assert.doesNotMatch(message, /secret-one|secret-two/);
});

test("an already aborted signal performs no provider call", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  let calls = 0;
  const baseStream: StreamSimpleLike = () => {
    calls += 1;
    return new TestEventStream();
  };
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: baseStream,
    createEventStream: () => new TestEventStream(),
  });
  const controller = new AbortController();
  controller.abort();

  const events = await collect(rotating(model, { messages: [] }, { signal: controller.signal }));
  assert.equal(calls, 0);
  assert.equal(events[0]?.type, "error");
  assert.equal(events[0]?.type === "error" ? events[0].reason : "", "aborted");
  assert.equal((await pool.snapshot()).totalAttempts, 0);
});

test("the caller's options object is not mutated", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  let receivedHeaders: StreamOptionsLike["headers"];
  const baseStream = scriptedHttpStream([{ status: 200 }], observed);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, context, receivedOptions) => {
      receivedHeaders = receivedOptions?.headers;
      return baseStream(receivedModel, context, receivedOptions);
    },
    createEventStream: () => new TestEventStream(),
  });
  const options: StreamOptionsLike = {
    apiKey: "placeholder",
    maxRetries: 12,
    headers: {
      Authorization: "Bearer placeholder",
      "x-gateway-token": "fixed-token",
    },
  };

  await collect(rotating(model, { messages: [] }, options));
  assert.deepEqual(options, {
    apiKey: "placeholder",
    maxRetries: 12,
    headers: {
      Authorization: "Bearer placeholder",
      "x-gateway-token": "fixed-token",
    },
  });
  assert.deepEqual(receivedHeaders, {
    Authorization: "Bearer secret-one",
    "x-gateway-token": "fixed-token",
  });
});

test("onResponse is invoked for every physical attempt", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  const responses: ProviderResponseLike[] = [];
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream([{ status: 503 }, { status: 200 }], observed),
    createEventStream: () => new TestEventStream(),
  });

  await collect(
    rotating(model, { messages: [] }, {
      onResponse: (response) => {
        responses.push(response as ProviderResponseLike);
      },
    }),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [503, 200],
  );
});

// A compile-time guard that the catch-all event shape can carry provider-specific fields.
const _eventShape: AssistantEventLike = { type: "provider_specific", payload: { ok: true } };
void _eventShape;

test("network error details are redacted when every failover attempt is exhausted", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  let call = 0;
  const baseStream: StreamSimpleLike = () => {
    const stream = new TestEventStream();
    const leaked = call === 0 ? "secret-one" : "secret-two";
    call += 1;
    queueMicrotask(() => {
      stream.push({
        type: "error",
        reason: "error",
        error: assistantMessage("error", { content: [], errorMessage: `fetch failed for ${leaked}` }),
      });
    });
    return stream;
  };
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: baseStream,
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  const terminal = events[0];
  const message =
    terminal?.type === "error" && "error" in terminal
      ? (terminal.error as { errorMessage?: string }).errorMessage ?? ""
      : "";
  assert.match(message, /\[REDACTED\]/);
  assert.doesNotMatch(message, /secret-one|secret-two/);
});

test("an error terminal after HTTP 200 is counted as failure, not success", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  const baseStream: StreamSimpleLike = (receivedModel, _context, options) => {
    const stream = new TestEventStream();
    queueMicrotask(() => {
      void (async () => {
        stream.push({ type: "start", partial: assistantMessage("pending") });
        await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
        stream.push({
          type: "error",
          reason: "error",
          error: assistantMessage("error", { content: [], errorMessage: "invalid response stream" }),
        });
      })();
    });
    return stream;
  };
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: baseStream,
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  const first = (await pool.snapshot()).keys[0];
  assert.equal(first?.successes, 0);
  assert.equal(first?.failures, 1);
});

test("aborting an in-flight attempt does not quarantine a healthy key", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  const controller = new AbortController();
  const baseStream: StreamSimpleLike = () => {
    const stream = new TestEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage("pending") });
      controller.abort();
      stream.push({
        type: "error",
        reason: "aborted",
        error: assistantMessage("aborted", { content: [], errorMessage: "aborted" }),
      });
    });
    return stream;
  };
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: baseStream,
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }, { signal: controller.signal }));
  assert.equal(events[0]?.type, "error");
  assert.equal(events[0]?.type === "error" ? events[0].reason : "", "aborted");
  const first = (await pool.snapshot()).keys[0];
  assert.equal(first?.attempts, 1);
  assert.equal(first?.failures, 0);
  assert.equal(first?.disabled, false);
  assert.equal(first?.cooldownUntil, 0);
});

test("network errors are forwarded without failover when retryNetworkErrors is false", async () => {
  const config = makeConfig({ retryNetworkErrors: false });
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream([{ networkError: "offline" }], observed),
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(observed.length, 1);
  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
});
