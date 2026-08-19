import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolveConfigSet } from "../src/config-set.ts";

test("packaged multi-pool example defines two independent endpoint pools", async () => {
  const raw = JSON.parse(await readFile("config.multi-pool.example.json", "utf8")) as unknown;
  const set = resolveConfigSet(raw, {
    configFile: "/tmp/config.multi-pool.example.json",
    homeDir: "/tmp",
    env: {},
  });
  assert.deepEqual(set.pools.map((pool) => pool.poolId), ["ibm-ica-primary", "ibm-ica-secondary"]);
  assert.deepEqual(set.pools.map((pool) => pool.requestsPerKey), [20, 10]);
  assert.notEqual(set.pools[0]?.stateFile, set.pools[1]?.stateFile);
});
