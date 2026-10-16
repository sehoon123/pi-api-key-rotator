import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { createRotatingStream } from "../src/rotating-stream.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type { RawRotatorConfig, RotatorConfig } from "../src/types.ts";
import { assistantMessage, collect, makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

const HOUR = 3_600_000;
const bodies = [
  '{"type":"budget_exceeded","code":"429","message":"credits exhausted"}',
  '{"error":{"type":"budget_exceeded","code":"429"}}',
  '429 {"error":{"type":"budget_exceeded"}}',
  '429: {"error":{"code":"insufficient_quota"}}',
  'OpenAI API error (429): {"error":{"type":"insufficient_quota"}}',
  'gateway-provider API error (429): {"type":"budget_exceeded"}',
];

async function scenario(message: string, overrides: Partial<RotatorConfig> = {}, status = 429, headers = {}) {
  const time = mutableClock(1000);
  const config = makeConfig({ requestsPerKey: 20, ...overrides });
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);
  const observed: string[] = [];
  const rotating = createRotatingStream({
    config, pool, createEventStream: () => new TestEventStream(),
    baseStreamSimple: (model, _context, options) => {
      observed.push(options?.apiKey ?? "missing");
      const first = observed.length === 1;
      const stream = new TestEventStream();
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: first ? status : 200, headers }, model);
          if (first) {
            stream.push({ type: "error", reason: "error", error: assistantMessage("error", { content: [], errorMessage: message }) });
          } else {
            stream.push({ type: "done", reason: "stop", message: assistantMessage() });
          }
        })();
      });
      return stream;
    },
  });
  const events = await collect(rotating({ id: "m", api: config.api, provider: config.provider }, { messages: [] }));
  return { events, observed, snapshot: await pool.snapshot(), pool, store, config, time };
}

for (const message of bodies) {
  test(`explicit quota error cools the key for an hour and fails over: ${message}`, async () => {
    const { events, observed, snapshot } = await scenario(message, {}, 429, { "Retry-After": "2" });
    assert.equal(events.at(-1)?.type, "done");
    assert.deepEqual(observed, ["secret-one", "secret-two"]);
    assert.equal(snapshot.keys[0]?.cooldownUntil, 1000 + HOUR);
    assert.equal(snapshot.keys[0]?.disabled, false);
    assert.equal(snapshot.keys[1]?.successes, 1);
    assert.equal(snapshot.targets[0]?.failures, 0);
  });
}

for (const message of [
  '429 {"error":{"type":"rate_limit_error","message":"try later"}}',
  '429 {"error":{"message":"budget_exceeded"}}',
  '429 {"error":{"type":"budget_exceeded_hint"}}',
  'some log says {"type":"budget_exceeded"}',
  '{"type":"budget_exceeded"} garbage',
  '{"type":"budget_exceeded"' /* truncated */,
  '{"type":"budget_exceeded"}' + ' '.repeat(16384),
]) {
  test(`non-quota or ambiguous error keeps ordinary Retry-After: ${message.slice(0, 75)}`, async () => {
    const { snapshot } = await scenario(message, {}, 429, { "Retry-After": "2" });
    assert.equal(snapshot.keys[0]?.cooldownUntil, 3000);
  });
}

test("budgetCooldownMs is configurable; zero retains ordinary cooldown and does not bypass limits", async () => {
  assert.equal((await scenario(bodies[0]!, { budgetCooldownMs: 120_000 })).snapshot.keys[0]?.cooldownUntil, 121_000);
  assert.equal((await scenario(bodies[0]!, { budgetCooldownMs: 0 })).snapshot.keys[0]?.cooldownUntil, 61_000);
  const longRetry = await scenario(bodies[0]!, { budgetCooldownMs: 120_000, maxRetryAfterMs: 900_000 }, 429, { "retry-after": "600" });
  assert.equal(longRetry.snapshot.keys[0]?.cooldownUntil, 601_000);
  const inputError = await scenario(bodies[0]!, {}, 400);
  assert.equal(inputError.snapshot.keys[0]?.cooldownUntil, 0, "budget words cannot override HTTP 400");
  assert.equal(inputError.observed.length, 1);
});

test("budget cooldown respects scope, persists across pool reconstruction, and reset clears it", async () => {
  for (const rateLimitScope of ["key", "target", "pool"] as const) {
    const result = await scenario(bodies[0]!, { rateLimitScope });
    const { config, store, time } = result;
    const rebuilt = new KeyPool(config, store, time.clock);
    const snapshot = await rebuilt.snapshot();
    assert.equal(result.observed.length, rateLimitScope === "key" ? 2 : 1);
    const expiry = rateLimitScope === "key" ? snapshot.keys[0]?.cooldownUntil :
      rateLimitScope === "target" ? snapshot.targets[0]?.cooldownUntil : snapshot.poolCooldownUntil;
    assert.equal(expiry, 1000 + HOUR);
    if (rateLimitScope !== "key") {
      assert.match(JSON.stringify(result.events.at(-1)), /exhausted budget/);
      assert.equal(await rebuilt.select(), null);
    }
    const reset = await rebuilt.reset();
    assert.ok(reset.keys.every(k => k.available));
    assert.equal(reset.poolCooldownUntil, 0);
    assert.ok(reset.targets.every(t => t.cooldownUntil === 0));
  }
});

test("a quota cooldown is not bypassed by disabled-key rechecks or one-minute requests", async () => {
  const { pool, time, config } = await scenario(bodies[0]!);
  time.advance(61_000);
  assert.equal(await pool.select(new Set(config.keys.slice(1).map(k => k.id))), null);
  time.advance(HOUR);
  assert.equal((await pool.select(new Set(config.keys.slice(1).map(k => k.id))))?.id, "key-1");
});

test("budget duration stays persistable near the timestamp limit", async () => {
  const now = 8_640_000_000_000_000 - 100;
  const time = mutableClock(now);
  const config = makeConfig();
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, now)), time.clock);
  const selected = await pool.select();
  assert.ok(selected);
  await pool.recordFailure(selected.id, { status: 429, headers: {}, budgetExhausted: true }, selected.epoch);
  assert.equal((await pool.snapshot()).keys[0]?.cooldownUntil, 8_640_000_000_000_000);
});

test("config accepts a bounded budgetCooldownMs and rejects invalid values", () => {
  const raw = { provider: "test", api: "openai-completions", keys: [
    { id: "a", value: "test-secret-a" }, { id: "b", value: "test-secret-b" },
  ] };
  const options = { configFile: "/tmp/config.json", homeDir: "/tmp", env: {} };
  assert.equal(resolveConfig(raw, options).budgetCooldownMs, HOUR);
  for (const n of [0, 60_000, 86_400_000]) {
    assert.equal(resolveConfig({ ...raw, budgetCooldownMs: n }, options).budgetCooldownMs, n);
  }
  for (const value of [-1, 86_400_001, 1.5, "3600000", null]) {
    assert.throws(() => resolveConfig({ ...raw, budgetCooldownMs: value } as unknown as RawRotatorConfig, options), /budgetCooldownMs/);
  }
});

test("four-key request reaches the fourth key and only errors after all four reject", async () => {
  for (const lastStatus of [200, 429]) {
    const config = makeConfig({ keys: [
      ...makeConfig().keys, { id: "key-4", value: "secret-four" },
    ], maxAttemptsPerRequest: 4 });
    const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, Date.now())));
    const observed: string[] = [];
    const rotating = createRotatingStream({
      config, pool, createEventStream: () => new TestEventStream(),
      baseStreamSimple: (model, _ctx, options) => {
        observed.push(options?.apiKey ?? "missing");
        const status = observed.length === 4 ? lastStatus : 429;
        const stream = new TestEventStream();
        queueMicrotask(() => {
          void (async () => {
            await options?.onResponse?.({ status, headers: {} }, model);
            stream.push(status === 200 ? { type: "done", reason: "stop", message: assistantMessage() } :
              { type: "error", reason: "error", error: assistantMessage("error", { content: [], errorMessage: bodies[0]! }) });
          })();
        });
        return stream;
      },
    });
    const events = await collect(rotating({ id: "m", api: config.api, provider: config.provider }, { messages: [] }));
    assert.deepEqual(observed, config.keys.map(k => k.value));
    assert.equal(events.at(-1)?.type, lastStatus === 200 ? "done" : "error");
    if (lastStatus === 429) assert.match(JSON.stringify(events.at(-1)), /exhausted 4 attempt/);
  }
});
