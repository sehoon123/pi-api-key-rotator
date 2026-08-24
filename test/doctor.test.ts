import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

async function mutationSnapshot(directory: string, paths: readonly string[]) {
  const directoryInfo = await lstat(directory);
  const files = await Promise.all(
    paths.map(async (path) => {
      const info = await lstat(path);
      return {
        path,
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: info.ino,
        nlink: info.nlink,
      };
    }),
  );
  return {
    entries: (await readdir(directory)).sort(),
    directoryMode: directoryInfo.mode,
    directoryMtimeMs: directoryInfo.mtimeMs,
    directoryCtimeMs: directoryInfo.ctimeMs,
    files,
  };
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


test("missing state under a missing parent is OK and doctor creates nothing", async () => {
  const item = await fixture();
  const missingState = join(item.directory, "missing", "nested", "state.json");
  const config = makeConfig({
    configFile: item.configFile,
    stateFile: missingState,
    poolId: "missing-state",
    maxStateFileBytes: 65_536,
  });
  let readerCalls = 0;
  try {
    const before = await mutationSnapshot(item.directory, [item.configFile]);
    const report = await buildDoctorReport({
      configFile: item.configFile,
      pools: [config],
      registeredTargets: new Map([[config.provider, config.api]]),
      stateReaders: new Map([
        [
          "missing-state",
          async () => {
            readerCalls += 1;
            await mkdir(join(item.directory, "must-not-be-created"));
          },
        ],
      ]),
    });
    const after = await mutationSnapshot(item.directory, [item.configFile]);

    assert.notEqual(report.severity, "FAIL");
    assert.match(report.text, /state file is absent; this is allowed/u);
    assert.equal(readerCalls, 0);
    assert.deepEqual(after, before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test(
  "doctor reads a mode-400 state through a symlinked directory without requiring writes",
  { skip: process.platform === "win32" },
  async () => {
    const item = await fixture();
    const realDirectory = join(item.directory, "real-state-directory");
    const aliasDirectory = join(item.directory, "alias-state-directory");
    const realState = join(realDirectory, "state.json");
    const aliasState = join(aliasDirectory, "state.json");
    const config = makeConfig({
      configFile: item.configFile,
      stateFile: aliasState,
      poolId: "read-only-state",
      maxStateFileBytes: 65_536,
    });
    await mkdir(realDirectory, { mode: 0o700 });
    await symlink(realDirectory, aliasDirectory, "dir");
    await writeFile(realState, `${JSON.stringify(createInitialPoolState(config, Date.now()))}\n`, {
      mode: 0o400,
    });
    await chmod(realDirectory, 0o500);
    try {
      const before = await mutationSnapshot(realDirectory, [realState]);
      const report = await buildDoctorReport({
        configFile: item.configFile,
        pools: [config],
        registeredTargets: new Map([[config.provider, config.api]]),
      });
      const after = await mutationSnapshot(realDirectory, [realState]);

      assert.equal(report.severity, "OK");
      assert.match(report.text, /state metadata is safe and the file is readable/u);
      assert.doesNotMatch(report.text, /parent is writable|can be created/u);
      assert.deepEqual(after, before);
    } finally {
      await chmod(realDirectory, 0o700);
      await rm(item.directory, { recursive: true, force: true });
    }
  },
);

test("doctor reports a valid live lock without mutating its file or directory", async () => {
  const item = await fixture();
  const lockFile = `${item.stateFile}.lock`;
  await writeFile(
    lockFile,
    `${JSON.stringify({
      version: 1,
      nonce: crypto.randomUUID(),
      pid: process.pid,
      acquiredAt: Date.now(),
    })}\n`,
    { mode: 0o600 },
  );
  try {
    const before = await mutationSnapshot(item.directory, [item.configFile, lockFile]);
    const report = await buildDoctorReport({
      configFile: item.configFile,
      pools: [item.config],
      registeredTargets: item.registeredTargets,
    });
    const after = await mutationSnapshot(item.directory, [item.configFile, lockFile]);

    assert.equal(report.severity, "WARN");
    assert.match(report.text, /valid live lock is owned by PID/u);
    assert.deepEqual(after, before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("doctor reports a stale dead-owner lock as reclaimable without reclaiming it", async () => {
  const item = await fixture();
  const lockFile = `${item.stateFile}.lock`;
  const exited = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(exited.status, 0);
  assert.ok(exited.pid);
  await writeFile(
    lockFile,
    `${JSON.stringify({
      version: 1,
      nonce: crypto.randomUUID(),
      pid: exited.pid,
      acquiredAt: Date.now() - 10_000,
    })}\n`,
    { mode: 0o600 },
  );
  const old = new Date(Date.now() - item.config.staleLockMs - 2_000);
  await utimes(lockFile, old, old);
  try {
    const before = await mutationSnapshot(item.directory, [item.configFile, lockFile]);
    const report = await buildDoctorReport({
      configFile: item.configFile,
      pools: [item.config],
      registeredTargets: item.registeredTargets,
    });
    const after = await mutationSnapshot(item.directory, [item.configFile, lockFile]);

    assert.equal(report.severity, "WARN");
    assert.match(report.text, /stale dead-owner lock is reclaimable by the next writer/u);
    assert.deepEqual(after, before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("doctor fails on fixed reclaim evidence and leaves both hard links unchanged", async () => {
  const item = await fixture();
  const lockFile = `${item.stateFile}.lock`;
  const reclaimFile = `${item.stateFile}.lock.reclaim`;
  await writeFile(
    lockFile,
    `${JSON.stringify({
      version: 1,
      nonce: crypto.randomUUID(),
      pid: process.pid,
      acquiredAt: Date.now(),
    })}\n`,
    { mode: 0o600 },
  );
  await link(lockFile, reclaimFile);
  try {
    const before = await mutationSnapshot(item.directory, [item.configFile, lockFile, reclaimFile]);
    const report = await buildDoctorReport({
      configFile: item.configFile,
      pools: [item.config],
      registeredTargets: item.registeredTargets,
    });
    const after = await mutationSnapshot(item.directory, [item.configFile, lockFile, reclaimFile]);

    assert.equal(report.severity, "FAIL");
    assert.match(report.text, /fixed \.lock\.reclaim evidence is present/u);
    assert.deepEqual(after, before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("doctor fails closed on malformed lock metadata without rewriting it", async () => {
  const item = await fixture();
  const lockFile = `${item.stateFile}.lock`;
  await writeFile(lockFile, "{}\n", { mode: 0o600 });
  try {
    const before = await mutationSnapshot(item.directory, [item.configFile, lockFile]);
    const report = await buildDoctorReport({
      configFile: item.configFile,
      pools: [item.config],
      registeredTargets: item.registeredTargets,
    });
    const after = await mutationSnapshot(item.directory, [item.configFile, lockFile]);

    assert.equal(report.severity, "FAIL");
    assert.match(report.text, /lock metadata is malformed; automatic recovery is refused/u);
    assert.deepEqual(after, before);
  } finally {
    await rm(item.directory, { recursive: true, force: true });
  }
});
