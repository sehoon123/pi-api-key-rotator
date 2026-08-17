import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInitialPoolState, KeyPool, parseRetryAfterMs } from "../src/key-pool.ts";
import { InMemoryStateStore, JsonFileStateStore } from "../src/state-store.ts";
import type { PoolState } from "../src/types.ts";
import { makeConfig, mutableClock } from "./helpers.ts";

test("rotates after the configured number of actual HTTP attempts", async () => {
  const time = mutableClock(1_000);
  const config = makeConfig({ requestsPerKey: 2 });
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);

  const ids: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const selected = await pool.select();
    assert.ok(selected);
    ids.push(selected.id);
  }

  assert.deepEqual(ids, ["key-1", "key-1", "key-2", "key-2", "key-3", "key-3", "key-1"]);
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.totalAttempts, 7);
  assert.equal(snapshot.currentKeyId, "key-1");
  assert.equal(snapshot.requestsOnCurrent, 1);
});

test("a 429 response honors Retry-After and immediately skips the cooling key", async () => {
  const time = mutableClock(10_000);
  const base = makeConfig();
  const config = makeConfig({
    keys: base.keys.slice(0, 2),
    maxAttemptsPerRequest: 2,
    requestsPerKey: 100,
  });
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);

  const first = await pool.select();
  assert.equal(first?.id, "key-1");
  await pool.recordFailure("key-1", { status: 429, headers: { "Retry-After": "10" } });

  const second = await pool.select();
  assert.equal(second?.id, "key-2");
  let snapshot = await pool.snapshot();
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.cooldownUntil, 20_000);
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.available, false);

  time.advance(10_001);
  snapshot = await pool.advance();
  assert.equal(snapshot.currentKeyId, "key-1");
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.available, true);
});

test("401 disables a key until reset", async () => {
  const time = mutableClock(20_000);
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);

  await pool.select();
  await pool.recordFailure("key-1", { status: 401, headers: {} });

  let snapshot = await pool.snapshot();
  const disabled = snapshot.keys.find((key) => key.id === "key-1");
  assert.equal(disabled?.disabled, true);
  assert.equal(disabled?.available, false);
  assert.equal((await pool.select())?.id, "key-2");

  snapshot = await pool.reset();
  assert.equal(snapshot.currentKeyId, "key-1");
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.disabled, false);
  assert.equal(snapshot.totalAttempts, 0);
});

test("concurrent selections are serialized without losing counters", async () => {
  const time = mutableClock(30_000);
  const config = makeConfig({ requestsPerKey: 3 });
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);

  const selected = await Promise.all(Array.from({ length: 18 }, () => pool.select()));
  assert.deepEqual(
    selected.map((entry) => entry?.id),
    [
      "key-1",
      "key-1",
      "key-1",
      "key-2",
      "key-2",
      "key-2",
      "key-3",
      "key-3",
      "key-3",
      "key-1",
      "key-1",
      "key-1",
      "key-2",
      "key-2",
      "key-2",
      "key-3",
      "key-3",
      "key-3",
    ],
  );

  const snapshot = await pool.snapshot();
  assert.equal(snapshot.totalAttempts, 18);
  for (const key of snapshot.keys) assert.equal(key.attempts, 6);
});

test("parseRetryAfterMs supports delta-seconds, HTTP dates, fallback, and a cap", () => {
  const now = Date.parse("2026-08-18T00:00:00Z");
  assert.equal(parseRetryAfterMs({ "retry-after": "2.5" }, now, 60_000, 900_000), 2_500);
  assert.equal(
    parseRetryAfterMs({ "Retry-After": "Tue, 18 Aug 2026 00:00:10 GMT" }, now, 60_000, 900_000),
    10_000,
  );
  assert.equal(parseRetryAfterMs({}, now, 60_000, 900_000), 60_000);
  assert.equal(parseRetryAfterMs({ "retry-after": "9999" }, now, 60_000, 5_000), 5_000);
});

test("JsonFileStateStore coordinates concurrent writers with an atomic state file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-state-"));
  const stateFile = join(directory, "state.json");
  const store = new JsonFileStateStore<{ count: number }>({
    stateFile,
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 5_000,
    staleLockMs: 30_000,
  });

  try {
    await Promise.all(
      Array.from({ length: 40 }, () =>
        store.transact(async (state) => {
          const before = state.count;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.floor(Math.random() * 3)));
          state.count = before + 1;
        }),
      ),
    );

    assert.equal((await store.read()).count, 40);
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { count: number };
    assert.equal(persisted.count, 40);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pool normalizes a partially corrupted state instead of exposing secrets or crashing", async () => {
  const config = makeConfig();
  const corrupt = {
    version: 1,
    currentKeyId: "removed-key",
    requestsOnCurrent: -5,
    totalAttempts: Number.NaN,
    updatedAt: 0,
    keys: {
      "removed-key": { attempts: 999 },
      "key-1": { attempts: -1, disabled: "yes" },
    },
  } as unknown as PoolState;
  const store = new InMemoryStateStore(corrupt);
  const pool = new KeyPool(config, store, { now: () => 100 });

  const snapshot = await pool.snapshot();
  assert.equal(snapshot.currentKeyId, "key-1");
  assert.equal(snapshot.totalAttempts, 0);
  assert.equal(snapshot.keys.length, 3);
  assert.equal(snapshot.keys[0]?.attempts, 0);
});

test("JsonFileStateStore propagates an operation EEXIST error instead of mistaking it for lock contention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-operation-error-"));
  const store = new JsonFileStateStore<{ count: number }>({
    stateFile: join(directory, "state.json"),
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 500,
    staleLockMs: 30_000,
  });
  let calls = 0;

  try {
    await assert.rejects(
      () =>
        store.transact(() => {
          calls += 1;
          const error = new Error("application-level collision") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }),
      /application-level collision/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
