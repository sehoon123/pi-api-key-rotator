import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { createRotatingStream } from "../src/rotating-stream.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type { StateStore } from "../src/state-store.ts";
import type {
  AssistantEventLike,
  ModelLike,
  PoolState,
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

class OutcomeGateStore implements StateStore<PoolState> {
  private state: PoolState;
  private calls = 0;
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  private readonly rejectOutcome: boolean;

  constructor(initial: PoolState, rejectOutcome = false) {
    this.state = structuredClone(initial);
    this.rejectOutcome = rejectOutcome;
  }

  release(): void {
    this.releaseGate();
  }

  async read(): Promise<PoolState> {
    return structuredClone(this.state);
  }

  async transact<R>(mutator: (state: PoolState) => R | Promise<R>): Promise<R> {
    this.calls += 1;
    const draft = structuredClone(this.state);
    const result = await mutator(draft);
    if (this.calls === 2) {
      if (this.rejectOutcome) throw new Error("persistence rejected");
      await this.gate;
    }
    this.state = draft;
    return result;
  }
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

        stream.push({ type: "start", partial: assistantMessage("pending") });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: assistantMessage("pending") });
        stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
      })();
    });
    return stream;
  };
}

function providerFailureEvent(
  kind: string,
  status?: number,
  type = "provider_stream_failure",
): AssistantEventLike {
  return {
    type: "error",
    reason: "error",
    error: assistantMessage("error", {
      content: [],
      errorMessage: `provider failure: ${kind}`,
      diagnostics: [
        {
          type,
          details: { kind, ...(status === undefined ? {} : { status }) },
          error: { message: `provider failure: ${kind}`, stack: `stack: ${kind}` },
        },
      ],
    }),
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

test("401 disables the failed key for future selections and retries with the next key", async () => {
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
  assert.deepEqual(events.map((event) => event.type), ["error"]);
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
  assert.ok(terminal?.type === "error");
  const error = (terminal as unknown as { error: { errorMessage?: string; diagnostics?: unknown } }).error;
  assert.equal(isRetryableAssistantError(error as never), false);
  assert.match(JSON.stringify(error.diagnostics), /exhausted 2 attempt/i);
  assert.doesNotMatch(JSON.stringify(error), /secret-one|secret-two/);
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
      "x-encoded-key": Buffer.from("secret-two").toString("base64"),
    },
  };

  await collect(rotating(model, { messages: [] }, options));
  assert.deepEqual(options, {
    apiKey: "placeholder",
    maxRetries: 12,
    headers: {
      Authorization: "Bearer placeholder",
      "x-gateway-token": "fixed-token",
      "x-encoded-key": Buffer.from("secret-two").toString("base64"),
    },
  });
  assert.deepEqual(receivedHeaders, {
    Authorization: "Bearer secret-one",
    "x-gateway-token": "fixed-token",
    "x-encoded-key": Buffer.from("secret-one").toString("base64"),
  });
});

test("nullable headers pass through unchanged while string auth values rotate", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  let receivedHeaders: StreamOptionsLike["headers"];
  const baseStream = scriptedHttpStream([{ status: 200 }], []);
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
    headers: {
      Authorization: null,
      "x-embedded-auth": `Bearer ${config.keys[1]?.value ?? ""}`,
    },
  };

  const events = await collect(rotating(model, { messages: [] }, options));
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(receivedHeaders, {
    Authorization: null,
    "x-embedded-auth": `Bearer ${config.keys[0]?.value ?? ""}`,
  });
  assert.equal(options.headers?.Authorization, null);
  assert.equal(options.headers?.["x-embedded-auth"], `Bearer ${config.keys[1]?.value ?? ""}`);
});

test("caller API keys and auth-like header values are redacted from errors", async () => {
  const config = makeConfig({ retryNetworkErrors: false });
  const { pool } = setup(config);
  const callerKey = "caller-super-secret";
  const gatewayToken = "gateway-super-secret";
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      const stream = new TestEventStream();
      queueMicrotask(() => stream.push({
        type: "error",
        reason: "error",
        error: assistantMessage("error", {
          content: [],
          errorMessage: `${callerKey} ${gatewayToken}`,
        }),
      }));
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }, {
    apiKey: callerKey,
    headers: { "x-gateway-token": gatewayToken },
  }));
  const serialized = JSON.stringify(events);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(serialized.includes(callerKey), false);
  assert.equal(serialized.includes(callerKey.slice(8)), false);
  assert.equal(serialized.includes(gatewayToken), false);
  assert.equal(serialized.includes(gatewayToken.slice(8)), false);
});

test("secret prefixes matching protocol field names cannot corrupt the error envelope", async () => {
  const base = makeConfig();
  const config = makeConfig({
    keys: [
      { ...base.keys[0]!, value: "error-secret-value" },
      { ...base.keys[1]!, value: "diagnostics-secret-value" },
    ],
  });
  const { pool } = setup(config);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      const stream = new TestEventStream();
      queueMicrotask(() => stream.push({
        type: "error",
        reason: "error",
        error: assistantMessage("error", {
          content: [],
          errorMessage: "ordinary provider failure",
          diagnostics: [{ type: "provider_stream_failure", details: { kind: "invalid_request", status: 400 } }],
        }),
      }));
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  const terminal = events[0];
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    const error = terminal.error as { errorMessage?: string; diagnostics?: Array<{ type?: string }> };
    assert.equal(isRetryableAssistantError(error as never), false);
    assert.ok(error.diagnostics?.some((entry) => entry.type === "pi_key_rotator_final"));
    assert.ok(error.diagnostics?.some((entry) => entry.type === "provider_stream_failure"));
  }
});

test("embedded auth replacement is simultaneous and never rewrites the selected secret", async () => {
  const base = makeConfig();
  const config = makeConfig({
    keys: [
      { ...base.keys[0]!, value: "abc" },
      { ...base.keys[1]!, value: "b" },
    ],
    maxAttemptsPerRequest: 1,
  });
  const { pool } = setup(config);
  let receivedHeaders: StreamOptionsLike["headers"];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, context, receivedOptions) => {
      receivedHeaders = receivedOptions?.headers;
      return scriptedHttpStream([{ status: 200 }], [])(receivedModel, context, receivedOptions);
    },
    createEventStream: () => new TestEventStream(),
  });

  await collect(rotating(model, { messages: [] }, {
    apiKey: "a",
    headers: { Authorization: "Bearer a-b" },
  }));
  assert.deepEqual(receivedHeaders, { Authorization: "Bearer abc-abc" });
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
  const serialized = JSON.stringify(terminal);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /secret-one|secret-two/);
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

test("a structured auth failure after semantic output is accounted and is Pi-retry-neutral", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  const visible = "already visible";
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, _context, options) => {
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          const partial = assistantMessage("pending", { content: [{ type: "text", text: visible }] });
          stream.push({ type: "start", partial });
          stream.push({ type: "text_delta", contentIndex: 0, delta: visible, partial });
          stream.push({
            type: "error",
            reason: "error",
            error: assistantMessage("error", {
              content: [{ type: "text", text: visible }],
              errorMessage: "Provider authentication failed (status 401)",
              diagnostics: [{ type: "provider_stream_failure", details: { kind: "auth", status: 401 } }],
            }),
          });
        })();
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  const serialized = JSON.stringify(terminal);
  assert.doesNotMatch(serialized, /provider_stream_failure/);
  assert.match(serialized, /pi_key_rotator_final/);
  if (terminal?.type === "error") {
    assert.equal(isRetryableAssistantError(terminal.error as never), false);
    assert.deepEqual((terminal.error as { content?: unknown }).content, [{ type: "text", text: visible }]);
  }
  const first = (await pool.snapshot()).keys[0];
  assert.equal(first?.failures, 1);
  assert.equal(first?.disabled, true);
  assert.equal(first?.lastStatus, 401);
});

test("late error sanitization preserves already-generated assistant content", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  const visible = "v".repeat(3_000);
  const finalMessage = assistantMessage("error", {
    content: [{ type: "text", text: visible }],
    errorMessage: "invalid request exposed secret-one",
    diagnostics: [{ type: "provider_stream_failure", details: { kind: "invalid_request", status: 400 } }],
  });
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, _context, options) => {
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          const partial = assistantMessage("pending", { content: [{ type: "text", text: visible }] });
          stream.push({ type: "start", partial });
          stream.push({ type: "text_delta", contentIndex: 0, delta: visible, partial });
          stream.push({ type: "error", reason: "error", error: finalMessage });
        })();
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    const error = terminal.error as { content?: Array<{ text?: string }>; errorMessage?: string };
    assert.equal(error.content?.[0]?.text, visible);
    assert.equal(error.errorMessage?.includes("secret-one"), false);
    assert.equal(error.errorMessage?.includes("-one"), false);
  }
});

test("a synthetic terminal after a post-semantic iterator failure preserves the latest partial", async () => {
  const config = makeConfig({ retryNetworkErrors: false });
  const { pool } = setup(config);
  const visible = "partial output";
  const partial = assistantMessage("pending", { content: [{ type: "text", text: visible }] });
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => ({
      push(_event: AssistantEventLike): void {},
      result: async () => partial,
      async *[Symbol.asyncIterator](): AsyncIterator<AssistantEventLike> {
        yield { type: "start", partial };
        yield { type: "text_delta", contentIndex: 0, delta: visible, partial };
        throw new Error("iterator failed");
      },
    }),
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  if (terminal?.type === "error") {
    assert.deepEqual((terminal.error as { content?: unknown }).content, [{ type: "text", text: visible }]);
  }
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
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys[0]?.failures, 1);
  assert.equal(snapshot.keys[1]?.attempts, 0);
});


test("a no-onResponse stream forwards its first incremental event before the terminal event", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  let source: TestEventStream | undefined;
  let makeSourceReady!: () => void;
  const sourceReady = new Promise<void>((resolve) => {
    makeSourceReady = resolve;
  });
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      source = new TestEventStream();
      makeSourceReady();
      return source;
    },
    createEventStream: () => new TestEventStream(),
  });

  const iterator = rotating(model, { messages: [] })[Symbol.asyncIterator]();
  await sourceReady;
  assert.ok(source);
  source.push({ type: "start", partial: assistantMessage("pending") });

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, "start");

  source.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
  const terminal = await iterator.next();
  assert.equal(terminal.value?.type, "done");
  assert.equal((await iterator.next()).done, true);
});

test("a no-onResponse error after the stream starts never retries another key", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  let calls = 0;
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      calls += 1;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        if (calls === 1) {
          stream.push({ type: "start", partial: assistantMessage("pending") });
          stream.push({
            type: "error",
            reason: "error",
            error: assistantMessage("error", { content: [], errorMessage: "socket closed" }),
          });
        } else {
          stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
        }
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys[0]?.failures, 1);
  assert.equal(snapshot.keys[1]?.attempts, 0);
});

test("an invalid_request provider diagnostic with status 400 is forwarded", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  let calls = 0;
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      calls += 1;
      const stream = new TestEventStream();
      queueMicrotask(() => stream.push(providerFailureEvent("invalid_request", 400)));
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys[0]?.lastStatus, 400);
  assert.equal(snapshot.keys[0]?.failures, 1);
  assert.equal(snapshot.keys[1]?.attempts, 0);
});

test("an auth provider diagnostic with status 401 disables the key and retries", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  let calls = 0;
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      calls += 1;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        if (calls === 1) stream.push(providerFailureEvent("auth", 401));
        else stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
  const first = (await pool.snapshot()).keys[0];
  assert.equal(first?.lastStatus, 401);
  assert.equal(first?.disabled, true);
});

test("a rate_limit provider diagnostic maps to HTTP 429 and retries", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool, time } = setup(config);
  let calls = 0;
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      calls += 1;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        if (calls === 1) stream.push(providerFailureEvent("rate_limit", 429));
        else stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
  const first = (await pool.snapshot()).keys[0];
  assert.equal(first?.lastStatus, 429);
  assert.ok((first?.cooldownUntil ?? 0) > time.clock.now());
});

test("Pi response diagnostic types drive HTTP credential accounting and failover", async () => {
  for (const [diagnosticType, status] of [
    ["pi_messages_response_failure", 401],
    ["bedrock_response_failure", 429],
  ] as const) {
    const base = makeConfig();
    const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
    const { pool } = setup(config);
    let calls = 0;
    const rotating = createRotatingStream({
      config,
      pool,
      baseStreamSimple: () => {
        calls += 1;
        const stream = new TestEventStream();
        queueMicrotask(() => {
          if (calls === 1) stream.push(providerFailureEvent("provider_error", status, diagnosticType));
          else stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
        });
        return stream;
      },
      createEventStream: () => new TestEventStream(),
    });

    const events = await collect(rotating(model, { messages: [] }));
    assert.equal(calls, 2, diagnosticType);
    assert.deepEqual(events.map((event) => event.type), ["done"], diagnosticType);
    const first = (await pool.snapshot()).keys[0];
    assert.equal(first?.lastStatus, status, diagnosticType);
    assert.equal(first?.disabled, status === 401, diagnosticType);
  }
});

test("provider_transport_failure follows network policy without fabricating an HTTP status", async () => {
  for (const retryNetworkErrors of [true, false]) {
    const base = makeConfig();
    const config = makeConfig({
      keys: base.keys.slice(0, 2),
      maxAttemptsPerRequest: 2,
      retryNetworkErrors,
    });
    const { pool } = setup(config);
    let calls = 0;
    const rotating = createRotatingStream({
      config,
      pool,
      baseStreamSimple: () => {
        calls += 1;
        const stream = new TestEventStream();
        queueMicrotask(() => {
          if (calls === 1) {
            stream.push(providerFailureEvent("transport", undefined, "provider_transport_failure"));
          } else {
            stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
          }
        });
        return stream;
      },
      createEventStream: () => new TestEventStream(),
    });

    const events = await collect(rotating(model, { messages: [] }));
    assert.equal(calls, retryNetworkErrors ? 2 : 1);
    assert.equal(events.at(-1)?.type, retryNetworkErrors ? "done" : "error");
    const first = (await pool.snapshot()).keys[0];
    assert.equal(first?.lastStatus, null);
    assert.equal(first?.disabled, false);
    assert.equal(first?.failures, 1);
    if (!retryNetworkErrors && events[0]?.type === "error") {
      assert.equal(isRetryableAssistantError(events[0].error as never), false);
    }
  }
});

test("retryNetworkErrors=false forwards a synchronous stream throw and records failure", async () => {
  const config = makeConfig({ retryNetworkErrors: false });
  const { pool } = setup(config);
  let calls = 0;
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      calls += 1;
      throw new Error("sync transport failure");
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys[0]?.failures, 1);
  assert.equal(snapshot.keys[1]?.attempts, 0);
});

test("retryNetworkErrors=false forwards an iterator throw and records failure", async () => {
  const config = makeConfig({ retryNetworkErrors: false });
  const { pool } = setup(config);
  let calls = 0;
  const fallback = assistantMessage("error", { content: [], errorMessage: "iterator failure" });
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      calls += 1;
      return {
        push(_event: AssistantEventLike): void {},
        result: async () => fallback,
        async *[Symbol.asyncIterator](): AsyncIterator<AssistantEventLike> {
          throw new Error("iterator transport failure");
        },
      };
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys[0]?.failures, 1);
  assert.equal(snapshot.keys[1]?.attempts, 0);
});

test("an iterator throw after HTTP 429 keeps HTTP accounting and retries", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool, time } = setup(config);
  let calls = 0;
  const fallback = assistantMessage("error", { content: [], errorMessage: "iterator failure" });
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, _context, options) => {
      calls += 1;
      if (calls === 1) {
        return {
          push(_event: AssistantEventLike): void {},
          result: async () => fallback,
          async *[Symbol.asyncIterator](): AsyncIterator<AssistantEventLike> {
            await options?.onResponse?.({ status: 429, headers: { "retry-after": "4" } }, receivedModel);
            throw new Error("body iterator failed");
          },
        };
      }

      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
        })();
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
  const first = (await pool.snapshot()).keys[0];
  assert.equal(first?.lastStatus, 429);
  assert.ok((first?.cooldownUntil ?? 0) > time.clock.now());
});

test("forwarded error diagnostics are cloned, capped, and redact raw and prefix secrets", async () => {
  const base = makeConfig();
  const config = makeConfig({
    keys: [
      { ...base.keys[0]!, value: "prefix" },
      { ...base.keys[1]!, value: "prefix-secret" },
    ],
    maxAttemptsPerRequest: 2,
  });
  const { pool } = setup(config);
  const leaked = `raw prefix-secret and prefix ${"x".repeat(3_000)}`;
  const sourceEvent: AssistantEventLike = {
    type: "error",
    reason: "error",
    error: assistantMessage("error", {
      content: [],
      errorMessage: leaked,
      diagnostics: [
        {
          type: "provider_stream_failure",
          details: { kind: "invalid_request", status: 400 },
          error: { message: leaked, stack: `stack ${leaked}` },
        },
      ],
    }),
  };
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      const stream = new TestEventStream();
      queueMicrotask(() => stream.push(sourceEvent));
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  const forwarded = events[0];
  assert.equal(forwarded?.type, "error");
  assert.notStrictEqual(forwarded, sourceEvent);
  assert.ok(forwarded?.type === "error" && sourceEvent.type === "error");
  assert.notStrictEqual(forwarded.error, sourceEvent.error);
  const forwardedError = forwarded.error as { errorMessage?: string; diagnostics?: unknown };
  const originalError = sourceEvent.error as { errorMessage?: string; diagnostics?: unknown };

  const forwardedMessage = forwardedError.errorMessage ?? "";
  const forwardedDiagnostics = forwardedError.diagnostics as Array<{
    type?: string;
    error: { message: string; stack?: string };
  }>;
  assert.equal(isRetryableAssistantError(forwardedError as never), false);
  assert.doesNotMatch(forwardedMessage, /prefix(?:-secret)?/);
  for (const text of [
    forwardedDiagnostics[0]?.error.message ?? "",
    forwardedDiagnostics[0]?.error.stack ?? "",
    forwardedDiagnostics.at(-1)?.error.message ?? "",
  ]) {
    assert.ok(text.length <= 2_000);
    assert.match(text, /\[REDACTED\]/);
    assert.doesNotMatch(text, /prefix(?:-secret)?/);
    assert.equal(text.includes("-secret"), false);
  }
  assert.equal(forwardedDiagnostics.at(-1)?.type, "pi_key_rotator_final");
  assert.equal(originalError.errorMessage, leaked);
  const sourceDiagnostics = originalError.diagnostics as Array<{ error: { message: string; stack: string } }>;
  assert.equal(sourceDiagnostics[0]?.error.message, leaked);
  assert.match(sourceDiagnostics[0]?.error.stack ?? "", /prefix-secret/);
});

test("large and malformed-Unicode secrets use bounded encoding redaction tokens", async () => {
  const base = makeConfig();
  const largeSecret = `🔐/secret value-${"x".repeat(60_000)}`;
  const malformedSecret = `\uD800-secret`;
  const config = makeConfig({
    keys: [
      { ...base.keys[0]!, value: largeSecret },
      { ...base.keys[1]!, value: malformedSecret },
    ],
    maxAttemptsPerRequest: 1,
  });
  const { pool } = setup(config);
  const leaks = {
    raw: largeSecret,
    url: encodeURIComponent(largeSecret),
    base64: Buffer.from(largeSecret, "utf8").toString("base64"),
    base64url: Buffer.from(largeSecret, "utf8").toString("base64url"),
    malformedJson: JSON.stringify(malformedSecret).slice(1, -1),
  };
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      const stream = new TestEventStream();
      queueMicrotask(() => stream.push({
        type: "error",
        reason: "error",
        error: assistantMessage("error", {
          content: [],
          errorMessage: largeSecret,
          diagnostics: [{ type: "provider_error", details: leaks }],
        }),
      }));
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  const serialized = JSON.stringify(events);
  assert.match(serialized, /\[REDACTED\]/);
  for (const leak of Object.values(leaks)) {
    assert.equal(serialized.includes(leak.slice(0, 20)), false);
  }
  assert.ok(serialized.length < 15_000, "forwarded diagnostics remain bounded");
});

test("onPayload and onResponse callback exceptions forward once without penalizing a key", async () => {
  for (const callbackName of ["onPayload", "onResponse"] as const) {
    const base = makeConfig();
    const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
    const { pool } = setup(config);
    let calls = 0;
    const rotating = createRotatingStream({
      config,
      pool,
      baseStreamSimple: (receivedModel, _context, options) => {
        calls += 1;
        const stream = new TestEventStream();
        queueMicrotask(() => {
          void (async () => {
            try {
              if (callbackName === "onPayload") await options?.onPayload?.({ body: true }, receivedModel);
              else await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
            } catch (error) {
              stream.push({
                type: "error",
                reason: "error",
                error: assistantMessage("error", { content: [], errorMessage: String(error) }),
              });
            }
          })();
        });
        return stream;
      },
      createEventStream: () => new TestEventStream(),
    });

    const callback = () => {
      throw new Error(`${callbackName} exploded`);
    };
    const options: StreamOptionsLike =
      callbackName === "onPayload" ? { onPayload: callback } : { onResponse: callback };
    const events = await collect(rotating(model, { messages: [] }, options));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls, 1, callbackName);
    assert.deepEqual(events.map((event) => event.type), ["error"], callbackName);
    const snapshot = await pool.snapshot();
    assert.equal(snapshot.keys[0]?.attempts, 1, callbackName);
    assert.equal(snapshot.keys[0]?.failures, 0, callbackName);
    assert.equal(snapshot.keys[0]?.disabled, false, callbackName);
    assert.equal(snapshot.keys[0]?.cooldownUntil, 0, callbackName);
    assert.equal(snapshot.keys[1]?.attempts, 0, callbackName);
  }
});


test("target circuit stops retry amplification before all credentials are consumed", async () => {
  const config = makeConfig({ maxAttemptsPerRequest: 3, targetFailureThreshold: 2 });
  const { pool } = setup(config);
  const observed: Array<{ apiKey: string | undefined; maxRetries: number | undefined }> = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: scriptedHttpStream([{ status: 503 }, { status: 503 }, { status: 503 }], observed),
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(observed.length, 2);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.targets[0]?.available, false);
  assert.ok(snapshot.keys.every((key) => key.cooldownUntil === 0));
});


test("cyclic and prototype-shaped diagnostics are bounded and recursively sanitized", async () => {
  const config = makeConfig({ retryNetworkErrors: false });
  const { pool } = setup(config);
  const details: Record<string, unknown> = { nested: { message: "secret-one" } };
  details.self = details;
  Object.defineProperty(details, "__proto__", {
    value: { polluted: "secret-two" },
    enumerable: true,
  });
  const sourceEvent: AssistantEventLike = {
    type: "error",
    reason: "error",
    error: assistantMessage("error", {
      content: [],
      errorMessage: "failed",
      diagnostics: [{ type: "provider_error", message: "secret-three", details }],
    }),
  };
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: () => {
      const stream = new TestEventStream();
      queueMicrotask(() => stream.push(sourceEvent));
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const [event] = await collect(rotating(model, { messages: [] }));
  const serialized = JSON.stringify(event);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /\[Circular\]/);
  assert.doesNotMatch(serialized, /secret-one|secret-two|secret-three/);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});


test("HTTP 200 plus an empty start and in-band 429 retries without leaking structure", async () => {
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const { pool } = setup(config);
  let calls = 0;
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, _context, options) => {
      calls += 1;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          if (calls === 1) {
            stream.push({ type: "start", partial: assistantMessage("pending", { content: [] }) });
            stream.push(providerFailureEvent("rate_limit", 429));
          } else {
            stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
          }
        })();
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
  const first = (await pool.snapshot()).keys[0];
  assert.equal(first?.lastStatus, 429);
  assert.equal(first?.failures, 1);
});

test("Anthropic HTTP-200 SSE rate_limit_error overrides the successful handshake and fails over", async () => {
  const base = makeConfig();
  const config = makeConfig({
    provider: "anthropic-target",
    api: "anthropic-messages",
    keys: base.keys.slice(0, 2),
    maxAttemptsPerRequest: 2,
  });
  const { pool } = setup(config);
  let calls = 0;
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, _context, options) => {
      calls += 1;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          if (calls === 1) {
            stream.push({ type: "start", partial: assistantMessage("pending", { content: [] }) });
            stream.push({
              type: "error",
              reason: "error",
              error: assistantMessage("error", {
                content: [],
                errorMessage: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
              }),
            });
          } else {
            stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
          }
        })();
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });
  const anthropicModel = { ...model, provider: "anthropic-target", api: "anthropic-messages" };

  const events = await collect(rotating(anthropicModel, { messages: [] }));
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
  const first = (await pool.snapshot()).keys[0];
  assert.equal(first?.lastStatus, 429);
  assert.equal(first?.failures, 1);
});

test("a later successful onResponse supersedes an adapter-internal 429 before output", async () => {
  const config = makeConfig();
  const { pool } = setup(config);
  const statuses: number[] = [];
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, _context, options) => {
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 429, headers: {} }, receivedModel);
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
        })();
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(
    rotating(model, { messages: [] }, { onResponse: (response) => {
      statuses.push(response.status);
    } }),
  );
  assert.deepEqual(statuses, [429, 200]);
  assert.deepEqual(events.map((event) => event.type), ["done"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.keys[0]?.successes, 1);
  assert.equal(snapshot.keys[0]?.failures, 0);
  assert.equal(snapshot.keys[1]?.attempts, 0);
});


test("a provider terminal is not visible until its outcome is durably committed", async () => {
  const config = makeConfig();
  const time = mutableClock(1_000);
  const store = new OutcomeGateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, _context, options) => {
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
        })();
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const iterator = rotating(model, { messages: [] })[Symbol.asyncIterator]();
  let settled = false;
  const first = iterator.next().then((value) => {
    settled = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  store.release();
  assert.equal((await first).value?.type, "done");
});

test("a rejected outcome commit suppresses the provider terminal", async () => {
  const config = makeConfig();
  const time = mutableClock(1_000);
  const store = new OutcomeGateStore(createInitialPoolState(config, time.clock.now()), true);
  const pool = new KeyPool(config, store, time.clock);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: (receivedModel, _context, options) => {
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 200, headers: {} }, receivedModel);
          stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
        })();
      });
      return stream;
    },
    createEventStream: () => new TestEventStream(),
  });

  const events = await collect(rotating(model, { messages: [] }));
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const terminal = events[0];
  assert.ok(terminal?.type === "error");
  const error = (terminal as unknown as { error: { diagnostics?: unknown } }).error;
  assert.equal(isRetryableAssistantError(error as never), false);
  assert.match(JSON.stringify(error.diagnostics), /failed internally/);
});


test("every finalized error terminal is neutral under Pi's real retry predicate", async () => {
  for (const scenario of ["forwarded", "synthetic"] as const) {
    const base = makeConfig();
    const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
    const { pool } = setup(config);
    const rotating = createRotatingStream({
      config,
      pool,
      baseStreamSimple:
        scenario === "forwarded"
          ? scriptedHttpStream([{ status: 400 }], [])
          : scriptedHttpStream([{ networkError: "offline" }, { networkError: "offline" }], []),
      createEventStream: () => new TestEventStream(),
    });
    const [terminal] = await collect(rotating(model, { messages: [] }));
    assert.equal(terminal?.type, "error");
    const error = (terminal as unknown as { error: { diagnostics?: Array<{ type?: string }> } }).error;
    assert.equal(isRetryableAssistantError(error as never), false, scenario);
    assert.ok(error.diagnostics?.some((entry) => entry.type === "pi_key_rotator_final"), scenario);
  }
});


test("status text fallback is anchored and limited to Pi adapters with known formats", async () => {
  for (const [api, message, expectedStatus] of [
    ["openai-completions", "400 bad request", 400],
    ["openai-completions", "400: bad request", 400],
    ["openai-completions", "request id 429 failed", null],
    ["openai-completions", "quota has 401 units", null],
    ["anthropic-messages", "429 rate limited", 429],
    ["anthropic-messages", '{"type":"error","error":{"type":"rate_limit_error"}}', 429],
    ["openai-responses", "OpenAI API error (401): bad key", 401],
    ["azure-openai-responses", "Azure OpenAI API error (429): busy", 429],
    ["google-generative-ai", "503: busy", 503],
    ["bedrock-converse-stream", "429 rate limited", null],
  ] as const) {
    const config = makeConfig({ retryNetworkErrors: false });
    const { pool } = setup(config);
    const rotating = createRotatingStream({
      config,
      pool,
      baseStreamSimple: () => {
        const stream = new TestEventStream();
        queueMicrotask(() =>
          stream.push({
            type: "error",
            reason: "error",
            error: assistantMessage("error", { content: [], errorMessage: message }),
          }),
        );
        return stream;
      },
      createEventStream: () => new TestEventStream(),
    });
    const events = await collect(rotating({ ...model, api }, { messages: [] }));
    assert.equal((await pool.snapshot()).keys[0]?.lastStatus, expectedStatus, `${api}: ${message}`);
    const error = (events[0] as unknown as { error: { diagnostics?: unknown } }).error;
    assert.equal(isRetryableAssistantError(error as never), false, `${api}: ${message}`);
    if (message === "quota has 401 units") {
      assert.match(JSON.stringify(error.diagnostics), /quota has 401 units/);
    }
  }
});
