import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInitialPoolState, KeyPool, parseRetryAfterMs } from "../src/key-pool.ts";
import {
  InMemoryStateStore,
  JsonFileStateStore,
  StateCorruptionError,
  StateFileTooLargeError,
  StateLockTimeoutError,
  StateSecurityError,
} from "../src/state-store.ts";
import type { StateStore } from "../src/state-store.ts";
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
  assert.ok(first);
  await pool.recordFailure("key-1", { status: 429, headers: { "Retry-After": "10" } }, first.epoch);

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

test("401 disables a key for future selections", async () => {
  const time = mutableClock(20_000);
  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);

  const selected = await pool.select();
  assert.ok(selected);
  await pool.recordFailure("key-1", { status: 401, headers: {} }, selected.epoch);

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
  assert.equal(
    parseRetryAfterMs({ "retry-after": "99999999999999" }, now, 60_000, 0),
    8_640_000_000_000_000 - now,
  );
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

test("an aborted transaction leaves the in-process state queue without running its mutator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-abort-"));
  const store = new JsonFileStateStore<{ count: number }>({
    stateFile: join(directory, "state.json"),
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 5_000,
    staleLockMs: 30_000,
  });
  let releaseHolder: (() => void) | undefined;
  let holderEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolvePromise) => {
    holderEntered = resolvePromise;
  });
  const release = new Promise<void>((resolvePromise) => {
    releaseHolder = resolvePromise;
  });
  let abortedMutatorRan = false;

  const holder = store.transact(async (state) => {
    holderEntered?.();
    await release;
    state.count += 1;
  });
  try {
    await entered;
    const controller = new AbortController();
    const waiting = store.transact(
      () => {
        abortedMutatorRan = true;
      },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.equal(abortedMutatorRan, false);
  } finally {
    releaseHolder?.();
    await holder;
    assert.equal((await store.read()).count, 1);
    await rm(directory, { recursive: true, force: true });
  }
});

test("pool rejects malformed known fields instead of silently re-enabling keys", async () => {
  const config = makeConfig();
  const corrupt = {
    version: 1,
    currentKeyId: "removed-key",
    requestsOnCurrent: -5,
    totalAttempts: 0,
    updatedAt: 0,
    keys: {
      "key-1": { attempts: -1, disabled: "yes" },
    },
  } as unknown as PoolState;
  const store = new InMemoryStateStore(corrupt);
  const pool = new KeyPool(config, store, { now: () => 100 });

  await assert.rejects(() => pool.snapshot(), StateCorruptionError);
  await assert.rejects(() => pool.select(), StateCorruptionError);
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


class CountingStateStore<T> implements StateStore<T> {
  readonly inner: InMemoryStateStore<T>;
  reads = 0;
  transactions = 0;

  constructor(state: T) {
    this.inner = new InMemoryStateStore(state);
  }

  async read(): Promise<T> {
    this.reads += 1;
    return this.inner.read();
  }

  async transact<R>(mutator: (state: T) => R | Promise<R>): Promise<R> {
    this.transactions += 1;
    return this.inner.transact(mutator);
  }
}

test("one normal attempt performs exactly select and outcome mutations", async () => {
  const time = mutableClock(40_000);
  const config = makeConfig();
  const store = new CountingStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);

  const selected = await pool.select();
  assert.ok(selected);
  assert.equal(selected.snapshot.totalAttempts, 1);
  assert.equal(store.transactions, 1);
  assert.equal(store.reads, 0);

  const outcome = await pool.recordSuccess(selected.id, 200, selected.epoch);
  assert.equal(outcome.keys[0]?.successes, 1);
  assert.equal(store.transactions, 2);

  await pool.snapshot();
  await pool.snapshot();
  assert.equal(store.transactions, 2, "status reads must never use a write transaction");
  assert.equal(store.reads, 2);
});

test("snapshot leaves the durable state mtime unchanged and creates no lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-readonly-"));
  const stateFile = join(directory, "state.json");
  const config = makeConfig({ stateFile });
  const store = new JsonFileStateStore<PoolState>({
    stateFile,
    initialState: () => createInitialPoolState(config, 1_000),
    lockTimeoutMs: 1_000,
    staleLockMs: 30_000,
  });
  const pool = new KeyPool(config, store, { now: () => 1_000 });

  try {
    const selected = await pool.select();
    assert.ok(selected);
    await pool.recordSuccess(selected.id, 200, selected.epoch);
    const before = await stat(stateFile, { bigint: true });

    await pool.snapshot();
    await pool.snapshot();

    const after = await stat(stateFile, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs);
    await assert.rejects(() => stat(`${stateFile}.lock`), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy record outcome signatures without an epoch still mutate state", async () => {
  const config = makeConfig();
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, 1_000)), {
    now: () => 1_000,
  });
  const keyId = config.keys[0]!.id;

  let snapshot = await pool.recordFailure(keyId, { status: 401, headers: {} });
  let key = snapshot.keys.find((entry) => entry.id === keyId);
  assert.equal(key?.failures, 1);
  assert.equal(key?.disabled, true);
  assert.equal(key?.lastStatus, 401);

  snapshot = await pool.recordSuccess(keyId, 200);
  key = snapshot.keys.find((entry) => entry.id === keyId);
  assert.equal(key?.successes, 1);
  assert.equal(key?.disabled, false);
  assert.equal(key?.lastStatus, 200);

  snapshot = await pool.recordNetworkFailure(keyId);
  key = snapshot.keys.find((entry) => entry.id === keyId);
  assert.equal(key?.failures, 2);
  assert.equal(key?.lastStatus, null);
});

test("cooldowns only extend across rate-limit, transient, and network outcomes", async () => {
  const time = mutableClock(10_000);
  const config = makeConfig({ requestsPerKey: 100, transientCooldownMs: 5_000 });
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );

  const selected = await pool.select();
  assert.ok(selected);
  await pool.recordFailure(selected.id, { status: 429, headers: { "retry-after": "60" } }, selected.epoch);
  const longest = 70_000;

  time.advance(1_000);
  await pool.recordFailure(selected.id, { status: 429, headers: { "retry-after": "1" } }, selected.epoch);
  assert.equal((await pool.snapshot()).keys[0]?.cooldownUntil, longest);

  await pool.recordFailure(selected.id, { status: 503, headers: {} }, selected.epoch);
  assert.equal((await pool.snapshot()).keys[0]?.cooldownUntil, longest);

  await pool.recordNetworkFailure(selected.id, selected.epoch);
  assert.equal((await pool.snapshot()).keys[0]?.cooldownUntil, longest);
});

test("reset generation ignores old 401 and old success completions", async () => {
  const time = mutableClock(50_000);
  const config = makeConfig({ requestsPerKey: 1 });
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );

  const oldFailure = await pool.select();
  const oldSuccess = await pool.select();
  assert.ok(oldFailure && oldSuccess);
  const reset = await pool.reset();
  assert.equal(reset.generation, oldFailure.epoch + 1);

  await pool.recordFailure(oldFailure.id, { status: 401, headers: {} }, oldFailure.epoch);
  await pool.recordSuccess(oldSuccess.id, 200, oldSuccess.epoch);

  const snapshot = await pool.snapshot();
  assert.equal(snapshot.totalAttempts, 0);
  assert.ok(snapshot.keys.every((key) => !key.disabled));
  assert.ok(snapshot.keys.every((key) => key.failures === 0 && key.successes === 0));
});

test("valid v1 state migrates on the next mutation", async () => {
  const config = makeConfig();
  const current = createInitialPoolState(config, 100);
  const legacy = structuredClone(current) as unknown as Record<string, unknown>;
  legacy.version = 1;
  delete legacy.magic;
  delete legacy.poolId;
  delete legacy.generation;
  legacy.unrecognized = "drop-me";
  const store = new InMemoryStateStore(legacy as unknown as PoolState);
  const pool = new KeyPool(config, store, { now: () => 200 });

  const snapshot = await pool.snapshot();
  assert.equal(snapshot.generation, 1);
  await pool.advance();
  const persisted = await store.read();
  assert.equal(persisted.version, 2);
  assert.equal(persisted.magic, "pi-api-key-rotator-state");
  assert.equal(persisted.poolId, config.provider);
  assert.ok(!Object.hasOwn(persisted as unknown as object, "unrecognized"));
});

test("null, future-version, wrong-magic, and wrong-pool state are rejected without overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-shape-"));
  try {
    const cases: Array<[string, string]> = [
      ["null", "null\n"],
      ["future", `${JSON.stringify({ version: 999, keys: {} })}\n`],
      [
        "magic",
        `${JSON.stringify({ ...createInitialPoolState(makeConfig(), 100), magic: "other-format" })}\n`,
      ],
      [
        "pool",
        `${JSON.stringify({ ...createInitialPoolState(makeConfig(), 100), poolId: "other-pool" })}\n`,
      ],
    ];

    for (const [name, contents] of cases) {
      const stateFile = join(directory, `${name}.json`);
      const config = makeConfig({ stateFile });
      await writeFile(stateFile, contents, { encoding: "utf8", mode: 0o600 });
      const store = new JsonFileStateStore<PoolState>({
        stateFile,
        initialState: () => createInitialPoolState(config, 100),
        lockTimeoutMs: 500,
        staleLockMs: 30_000,
      });
      const pool = new KeyPool(config, store, { now: () => 100 });

      await assert.rejects(() => pool.snapshot(), StateCorruptionError, name);
      await assert.rejects(() => pool.select(), StateCorruptionError, name);
      assert.equal(await readFile(stateFile, "utf8"), contents, name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed JSON is a named corruption error and is never reset or overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-json-state-"));
  const stateFile = join(directory, "state.json");
  const contents = '{"version":2,"keys":';
  const config = makeConfig({ stateFile });
  const store = new JsonFileStateStore<PoolState>({
    stateFile,
    initialState: () => createInitialPoolState(config, 100),
    lockTimeoutMs: 500,
    staleLockMs: 30_000,
  });
  const pool = new KeyPool(config, store, { now: () => 100 });

  try {
    await writeFile(stateFile, contents, { encoding: "utf8", mode: 0o600 });
    await assert.rejects(() => pool.snapshot(), StateCorruptionError);
    await assert.rejects(() => pool.reset(), StateCorruptionError);
    assert.equal(await readFile(stateFile, "utf8"), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a read-only state snapshot retries one concurrent atomic replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-read-race-"));
  const stateFile = join(directory, "state.json");
  const replacement = join(directory, "replacement.json");
  let inspections = 0;
  const store = new JsonFileStateStore<{ generation: number }>({
    stateFile,
    initialState: () => ({ generation: 0 }),
    lockTimeoutMs: 500,
    staleLockMs: 30_000,
    faultHooks: {
      afterStateInspected: async () => {
        inspections += 1;
        if (inspections !== 1) return;
        await writeFile(replacement, JSON.stringify({ generation: 2 }), { mode: 0o600 });
        await rename(replacement, stateFile);
      },
    },
  });

  try {
    await writeFile(stateFile, JSON.stringify({ generation: 1 }), { mode: 0o600 });
    assert.deepEqual(await store.read(), { generation: 2 });
    assert.equal(inspections, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid UTF-8 state is rejected and never overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-utf8-state-"));
  const stateFile = join(directory, "state.json");
  const contents = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  const store = new JsonFileStateStore<unknown>({
    stateFile,
    initialState: () => ({}),
    lockTimeoutMs: 500,
    staleLockMs: 30_000,
  });

  try {
    await writeFile(stateFile, contents, { mode: 0o600 });
    await assert.rejects(() => store.read(), StateCorruptionError);
    await assert.rejects(() => store.transact(() => undefined), StateCorruptionError);
    assert.deepEqual(await readFile(stateFile), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized state is rejected before parsing and never overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-large-state-"));
  const stateFile = join(directory, "state.json");
  const contents = "x".repeat(1_025);
  const store = new JsonFileStateStore<unknown>({
    stateFile,
    initialState: () => ({}),
    lockTimeoutMs: 500,
    staleLockMs: 30_000,
    maxStateFileBytes: 1_024,
  });

  try {
    await writeFile(stateFile, contents, { encoding: "utf8", mode: 0o600 });
    await assert.rejects(() => store.read(), StateFileTooLargeError);
    await assert.rejects(() => store.transact(() => undefined), StateFileTooLargeError);
    assert.equal(await readFile(stateFile, "utf8"), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function ownerRecord(nonce: string, pid = process.pid): string {
  return `${JSON.stringify({ version: 1, nonce, pid, acquiredAt: Date.now() - 60_000 })}\n`;
}

test("an old lock owned by this live PID is never stolen merely because of age", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-live-lock-"));
  const stateFile = join(directory, "state.json");
  const lockFile = `${stateFile}.lock`;
  const store = new JsonFileStateStore<{ count: number }>({
    stateFile,
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 60,
    staleLockMs: 5,
  });

  try {
    const contents = ownerRecord("live-owner-nonce");
    await writeFile(lockFile, contents, { encoding: "utf8", mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    await assert.rejects(() => store.transact((state) => { state.count += 1; }), StateLockTimeoutError);
    assert.equal(await readFile(lockFile, "utf8"), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed stale lock metadata fails closed instead of being reaped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-malformed-lock-"));
  const stateFile = join(directory, "state.json");
  const lockFile = `${stateFile}.lock`;
  const contents = "{malformed-lock\n";
  const store = new JsonFileStateStore<{ count: number }>({
    stateFile,
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 60,
    staleLockMs: 5,
  });

  try {
    await writeFile(lockFile, contents, { encoding: "utf8", mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    await assert.rejects(() => store.transact((state) => { state.count += 1; }), StateLockTimeoutError);
    assert.equal(await readFile(lockFile, "utf8"), contents);
    await assert.rejects(() => stat(`${lockFile}.reclaim`), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale dead-PID lock is recovered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-dead-lock-"));
  const stateFile = join(directory, "state.json");
  const lockFile = `${stateFile}.lock`;
  const store = new JsonFileStateStore<{ count: number }>({
    stateFile,
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 500,
    staleLockMs: 5,
  });

  try {
    await writeFile(lockFile, ownerRecord("dead-owner-nonce", 2_147_483_647), { encoding: "utf8", mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    await store.transact((state) => { state.count += 1; });
    assert.equal((await store.read()).count, 1);
    await assert.rejects(() => stat(lockFile), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an old owner never deletes a replacement lock during release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-owner-race-"));
  const stateFile = join(directory, "state.json");
  const lockFile = `${stateFile}.lock`;
  const store = new JsonFileStateStore<{ count: number }>({
    stateFile,
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 500,
    staleLockMs: 30_000,
  });
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const enteredPromise = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });

  try {
    const transaction = store.transact(async (state) => {
      entered?.();
      await gate;
      state.count += 1;
    });
    await enteredPromise;
    await unlink(lockFile);
    const replacement = ownerRecord("replacement-owner-nonce");
    await writeFile(lockFile, replacement, { encoding: "utf8", mode: 0o600, flag: "wx" });
    release?.();
    await transaction;

    assert.equal(await readFile(lockFile, "utf8"), replacement);
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate stores for one canonical path enter the cross-process lock in local FIFO order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-fifo-"));
  const stateFile = join(directory, "state.json");
  const stores = Array.from({ length: 8 }, () =>
    new JsonFileStateStore<{ count: number }>({
      stateFile,
      initialState: () => ({ count: 0 }),
      lockTimeoutMs: 2_000,
      staleLockMs: 30_000,
    }),
  );
  const order: string[] = [];

  try {
    await Promise.all(
      stores.map((store, index) =>
        store.transact(async (state) => {
          order.push(`start-${index}`);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
          state.count += 1;
          order.push(`end-${index}`);
        }),
      ),
    );
    assert.deepEqual(
      order,
      stores.flatMap((_store, index) => [`start-${index}`, `end-${index}`]),
    );
    assert.equal((await stores[0]!.read()).count, stores.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("rolling secret replacement fences old in-flight outcomes and old workers", async () => {
  const time = mutableClock(80_000);
  const oldConfig = makeConfig({ configRevision: "100", requestsPerKey: 100 });
  const store = new InMemoryStateStore(createInitialPoolState(oldConfig, time.clock.now()));
  const oldPool = new KeyPool(oldConfig, store, time.clock);
  const oldSelection = await oldPool.select();
  assert.ok(oldSelection);
  assert.equal(oldSelection.id, "key-1");

  const newConfig = makeConfig({
    configRevision: "200",
    requestsPerKey: 100,
    keys: oldConfig.keys.map((key) =>
      key.id === "key-1" ? { ...key, value: "replacement-secret" } : { ...key },
    ),
  });
  const newPool = new KeyPool(newConfig, store, time.clock);
  const newSelection = await newPool.select();
  assert.ok(newSelection);
  assert.equal(newSelection.id, "key-1");

  await oldPool.recordFailure(
    oldSelection.id,
    { status: 401, headers: {} },
    oldSelection.epoch,
    oldSelection.targetId,
    oldSelection.attemptNumber,
    oldSelection.credentialFingerprint,
  );
  let snapshot = await newPool.snapshot();
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.disabled, false);
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.failures, 0);

  const oldWorkerNext = await oldPool.select();
  assert.ok(oldWorkerNext);
  assert.equal(oldWorkerNext.id, "key-2", "the old worker must not use the replacement key ID");

  await newPool.recordSuccess(
    newSelection.id,
    200,
    newSelection.epoch,
    newSelection.targetId,
    newSelection.attemptNumber,
    newSelection.credentialFingerprint,
  );
  snapshot = await newPool.snapshot();
  assert.equal(snapshot.keys.find((key) => key.id === "key-1")?.successes, 1);
});

test("rolling overlap retention is bounded to one maximum prior key and target set", async () => {
  const oldBase = makeConfig({ poolId: "rolling-pool", configRevision: "100" });
  const oldConfig = makeConfig({
    ...oldBase,
    poolId: "rolling-pool",
    configRevision: "100",
    keys: Array.from({ length: 258 }, (_, index) => ({
      ...oldBase.keys[index % oldBase.keys.length]!,
      id: `old-${index}`,
      value: `old-secret-${index}`,
    })),
    targets: Array.from({ length: 130 }, (_, index) => ({
      provider: `old-target-${index}`,
      api: "openai-completions",
    })),
  });
  const currentBase = makeConfig({ poolId: "rolling-pool", configRevision: "200" });
  const currentConfig = makeConfig({
    ...currentBase,
    poolId: "rolling-pool",
    configRevision: "200",
    targets: [{ provider: "current-target", api: "openai-completions" }],
  });
  const store = new InMemoryStateStore(createInitialPoolState(oldConfig, 1_000));
  const pool = new KeyPool(currentConfig, store, { now: () => 2_000 });

  assert.ok(await pool.select(new Set(), undefined, "current-target"));
  const persisted = await store.read();
  assert.equal(Object.keys(persisted.keys).length, currentConfig.keys.length + 256);
  assert.equal(Object.keys(persisted.targets).length, currentConfig.targets!.length + 128);
});

test("target circuits quarantine transport failures without punishing credentials", async () => {
  const time = mutableClock(90_000);
  const config = makeConfig({ requestsPerKey: 100, targetFailureThreshold: 2, transientCooldownMs: 5_000 });
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );

  const first = await pool.select();
  const second = await pool.select();
  assert.ok(first && second);
  await pool.recordFailure(first.id, { status: 503, headers: {} }, first.epoch, first.targetId, first.attemptNumber);
  let snapshot = await pool.snapshot();
  assert.equal(snapshot.targets[0]?.consecutiveFailures, 1);
  assert.equal(snapshot.targets[0]?.available, true);
  assert.ok(snapshot.keys.every((key) => key.cooldownUntil === 0));

  await pool.recordNetworkFailure(second.id, second.epoch, second.targetId, second.attemptNumber);
  snapshot = await pool.snapshot();
  assert.equal(snapshot.targets[0]?.consecutiveFailures, 2);
  assert.equal(snapshot.targets[0]?.cooldownUntil, 95_000);
  assert.equal(await pool.select(new Set(), undefined, config.provider), null);
  assert.ok(snapshot.keys.every((key) => key.cooldownUntil === 0));

  time.advance(5_001);
  assert.ok(await pool.select(new Set(), undefined, config.provider));
});

test("rateLimitScope target and pool stop only their configured blast radius", async () => {
  const time = mutableClock(100_000);
  const targets = [
    { provider: "target-a", api: "openai-completions" },
    { provider: "target-b", api: "anthropic-messages" },
  ];
  const targetConfig = makeConfig({
    provider: targets[0]!.provider,
    api: targets[0]!.api,
    targets,
    rateLimitScope: "target",
    requestsPerKey: 100,
  });
  const targetPool = new KeyPool(
    targetConfig,
    new InMemoryStateStore(createInitialPoolState(targetConfig, time.clock.now())),
    time.clock,
  );
  const selected = await targetPool.select(new Set(), undefined, "target-a");
  assert.ok(selected);
  await targetPool.recordFailure(
    selected.id,
    { status: 429, headers: { "retry-after": "10" } },
    selected.epoch,
    selected.targetId,
    selected.attemptNumber,
  );
  assert.equal(await targetPool.select(new Set(), undefined, "target-a"), null);
  assert.ok(await targetPool.select(new Set(), undefined, "target-b"));
  assert.ok((await targetPool.snapshot()).keys.every((key) => key.cooldownUntil === 0));

  const poolConfig = makeConfig({
    provider: targets[0]!.provider,
    api: targets[0]!.api,
    targets,
    rateLimitScope: "pool",
  });
  const pool = new KeyPool(
    poolConfig,
    new InMemoryStateStore(createInitialPoolState(poolConfig, time.clock.now())),
    time.clock,
  );
  const poolSelected = await pool.select(new Set(), undefined, "target-a");
  assert.ok(poolSelected);
  await pool.recordFailure(
    poolSelected.id,
    { status: 429, headers: {} },
    poolSelected.epoch,
    poolSelected.targetId,
    poolSelected.attemptNumber,
  );
  assert.equal(await pool.select(new Set(), undefined, "target-a"), null);
  assert.equal(await pool.select(new Set(), undefined, "target-b"), null);
});

test("a newer target success fences an older late circuit failure", async () => {
  const time = mutableClock(120_000);
  const config = makeConfig({ requestsPerKey: 100, targetFailureThreshold: 1 });
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );
  const oldAttempt = await pool.select();
  const newAttempt = await pool.select();
  assert.ok(oldAttempt && newAttempt);
  await pool.recordSuccess(
    newAttempt.id,
    200,
    newAttempt.epoch,
    newAttempt.targetId,
    newAttempt.attemptNumber,
  );
  await pool.recordFailure(
    oldAttempt.id,
    { status: 503, headers: {} },
    oldAttempt.epoch,
    oldAttempt.targetId,
    oldAttempt.attemptNumber,
  );
  const snapshot = await pool.snapshot();
  assert.equal(snapshot.targets[0]?.cooldownUntil, 0);
  assert.equal(snapshot.targets[0]?.consecutiveFailures, 0);
});


test("a newer key success fences an older late disable outcome", async () => {
  const time = mutableClock(130_000);
  const config = makeConfig({ requestsPerKey: 100 });
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );
  const oldAttempt = await pool.select();
  const newAttempt = await pool.select();
  assert.ok(oldAttempt && newAttempt);
  assert.equal(oldAttempt.id, newAttempt.id);
  await pool.recordSuccess(
    newAttempt.id,
    200,
    newAttempt.epoch,
    newAttempt.targetId,
    newAttempt.attemptNumber,
  );
  await pool.recordFailure(
    oldAttempt.id,
    { status: 401, headers: {} },
    oldAttempt.epoch,
    oldAttempt.targetId,
    oldAttempt.attemptNumber,
  );
  const key = (await pool.snapshot()).keys.find((entry) => entry.id === oldAttempt.id);
  assert.equal(key?.successes, 1);
  assert.equal(key?.failures, 1);
  assert.equal(key?.disabled, false);
  assert.equal(key?.lastStatus, 200);
});

test("a newer success fences an older late pool-scoped cooldown", async () => {
  const time = mutableClock(140_000);
  const config = makeConfig({ requestsPerKey: 100, rateLimitScope: "pool" });
  const pool = new KeyPool(
    config,
    new InMemoryStateStore(createInitialPoolState(config, time.clock.now())),
    time.clock,
  );
  const oldAttempt = await pool.select();
  const newAttempt = await pool.select();
  assert.ok(oldAttempt && newAttempt);
  await pool.recordSuccess(
    newAttempt.id,
    200,
    newAttempt.epoch,
    newAttempt.targetId,
    newAttempt.attemptNumber,
  );
  await pool.recordFailure(
    oldAttempt.id,
    { status: 429, headers: { "retry-after": "30" } },
    oldAttempt.epoch,
    oldAttempt.targetId,
    oldAttempt.attemptNumber,
  );
  assert.equal((await pool.snapshot()).poolCooldownUntil, 0);
});

test(
  "state reads reject symlinks, unsafe modes, and FIFOs without blocking",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-state-security-"));
    const target = join(directory, "target.json");
    const stateFile = join(directory, "state.json");
    const config = makeConfig({ stateFile });
    const makeStore = () =>
      new JsonFileStateStore<PoolState>({
        stateFile,
        initialState: () => createInitialPoolState(config, 1_000),
        lockTimeoutMs: 500,
        staleLockMs: 1_000,
      });
    try {
      await writeFile(target, `${JSON.stringify(createInitialPoolState(config, 1_000))}\n`, { mode: 0o600 });
      await symlink(target, stateFile);
      await assert.rejects(() => makeStore().read(), StateSecurityError);
      await unlink(stateFile);

      await writeFile(stateFile, `${JSON.stringify(createInitialPoolState(config, 1_000))}\n`, { mode: 0o600 });
      await chmod(stateFile, 0o666);
      await assert.rejects(() => makeStore().read(), StateSecurityError);
      await unlink(stateFile);

      assert.equal(spawnSync("mkfifo", [stateFile]).status, 0);
      const started = performance.now();
      await assert.rejects(() => makeStore().read(), StateSecurityError);
      assert.ok(performance.now() - started < 1_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
