import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDoctorReport } from "../src/doctor.ts";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { JsonFileStateStore } from "../src/state-store.ts";
import type { PoolState } from "../src/types.ts";
import { makeConfig } from "./helpers.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-doctor-"));
  const configFile = join(directory, "key-rotator.json");
  const stateFile = join(directory, "state.json");
  await writeFile(configFile, "{}\n", { mode: 0o600 });
  const config = makeConfig({ configFile, stateFile, poolId: "doctor-pool", maxStateFileBytes: 65_536 });
  const store = new JsonFileStateStore<PoolState>({
    stateFile,
    initialState: () => createInitialPoolState(config, Date.now()),
    lockTimeoutMs: 500,
    staleLockMs: 1_000,
    maxStateFileBytes: 65_536,
  });
  const pool = new KeyPool(config, store);
  const registeredTargets = new Map([[config.provider, config.api]]);
  return { directory, config, configFile, stateFile, pool, registeredTargets };
}

test("doctor reports runtime corruption and a mismatched local registration as FAIL", async () => {
  const item = await fixture();
  try {
    const wrong = createInitialPoolState(item.config, Date.now());
    wrong.poolId = "another-pool";
    await writeFile(item.stateFile, `${JSON.stringify(wrong)}\n`, { mode: 0o600 });

    const report = await buildDoctorReport({
      configFile: item.configFile,
      pools: [item.config],
      registeredTargets: new Map([[item.config.provider, "anthropic-messages"]]),
      stateReaders: new Map([["doctor-pool", () => item.pool.snapshot()]]),
    });

    assert.equal(report.severity, "FAIL");
    assert.match(report.text, /read-only state validation failed \(StateCorruptionError\)/);
    assert.match(report.text, /registered for anthropic-messages, expected openai-completions/);
    assert.doesNotMatch(report.text, /another-pool/);
    assert.match(report.text, /local checks only; no provider requests sent/);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test(
  "doctor rejects an unsafe state mode and warns for an unsafe config mode",
  { skip: process.platform === "win32" },
  async () => {
    const item = await fixture();
    try {
      await writeFile(item.stateFile, `${JSON.stringify(createInitialPoolState(item.config, Date.now()))}\n`, {
        mode: 0o600,
      });
      await chmod(item.stateFile, 0o666);
      await chmod(item.configFile, 0o644);
      const report = await buildDoctorReport({
        configFile: item.configFile,
        pools: [item.config],
        registeredTargets: item.registeredTargets,
      });
      assert.equal(report.severity, "FAIL");
      assert.match(report.text, /\[WARN\] Config/);
      assert.match(report.text, /\[FAIL\] State/);
      assert.match(report.text, /writable by group or other users/);
      assert.match(report.text, /\[OK\] Target/);
    } finally {
      await rm(item.directory, { recursive: true, force: true });
    }
  },
);

test("doctor returns OK for a secure config and creatable state without creating it", async () => {
  const item = await fixture();
  try {
    const report = await buildDoctorReport({
      configFile: item.configFile,
      pools: [item.config],
      registeredTargets: item.registeredTargets,
      stateReaders: new Map([["doctor-pool", () => item.pool.snapshot()]]),
    });
    assert.equal(report.severity, process.platform === "win32" ? "WARN" : "OK");
    assert.match(report.text, /openai-completions registered locally/);
    await assert.rejects(lstat(item.stateFile), (error: unknown) => {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    });
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("doctor fails when a configured provider was not captured after registration", async () => {
  const item = await fixture();
  try {
    const report = await buildDoctorReport({
      configFile: item.configFile,
      pools: [item.config],
      registeredTargets: new Map(),
    });
    assert.equal(report.severity, "FAIL");
    assert.match(report.text, /provider was not registered for openai-completions/);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});
