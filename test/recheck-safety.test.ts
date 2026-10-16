import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import { makeConfig, mutableClock } from "./helpers.ts";

test("a late disable verdict restarts the interval, even when the attempt started long ago", async () => {
  const time = mutableClock(1000);
  const config = makeConfig();
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, 1000)), time.clock);
  const selected = await pool.select();
  assert.ok(selected);
  time.advance(120_000);
  await pool.recordFailure(selected.id, { status: 403, headers: {} }, selected.epoch, selected.targetId, selected.attemptNumber, selected.credentialFingerprint);
  const excluded = new Set(["key-2", "key-3"]);
  assert.equal(await pool.select(excluded), null);
  time.advance(59_999);
  assert.equal(await pool.select(excluded), null);
  time.advance(1);
  assert.equal((await pool.select(excluded))?.id, selected.id);
});

test("concurrent last-resort selections do not re-check the same disabled key inside the interval", async () => {
  const time = mutableClock(1000);
  const config = makeConfig();
  const store = new InMemoryStateStore(createInitialPoolState(config, 1000));
  const pool = new KeyPool(config, store, time.clock);
  const otherWorker = new KeyPool(config, store, time.clock);
  for (const key of config.keys) {
    const selected = await pool.select();
    assert.equal(selected?.id, key.id);
    await pool.recordFailure(key.id, { status: 403, headers: {} }, selected?.epoch);
  }
  time.advance(60_000);
  const selected = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? pool : otherWorker).select()));
  assert.deepEqual(selected.filter(k => k !== null).map(k => k.id).sort(), config.keys.map(k => k.id));
});

test("a disabled key's extended budget cooldown is respected during rechecks", async () => {
  const time = mutableClock(1000);
  const config = makeConfig();
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, 1000)), time.clock);
  const selected = await pool.select();
  assert.ok(selected);
  await pool.recordFailure(selected.id, { status: 403, headers: {} }, selected.epoch);
  time.advance(60_000);
  const excluded = new Set(["key-2", "key-3"]);
  const probe = await pool.select(excluded);
  assert.ok(probe);
  await pool.recordFailure(probe.id, { status: 429, headers: {}, budgetExhausted: true }, probe.epoch);
  time.advance(60_000);
  assert.equal(await pool.select(excluded), null);
  time.advance(3_600_000);
  assert.equal((await pool.select(excluded))?.id, selected.id);
});
