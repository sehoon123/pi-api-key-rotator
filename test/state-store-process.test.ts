import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JsonFileStateStore } from "../src/state-store.ts";

interface CounterState { count: number }
interface LockProtocolTestStore {
  observeLock(): Promise<unknown>;
  unlinkObservedLock(expected: unknown): Promise<{ status: string }>;
}
const worker = new URL("./fixtures/state-worker.ts", import.meta.url);
const MAX_WORKER_DIAGNOSTIC_CHARS = 16_384;
const DEFAULT_WORKER_DEADLINE_MS = 30_000;
const PROCESS_TEST_TIMEOUT_MS = 45_000;
const WORKER_CLOSE_DEADLINE_MS = 5_000;

interface WorkerResult {
  pid: number | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

interface WorkerCapture {
  mode: string;
  stdout: string;
  stderr: string;
  spawnError?: string;
  terminationError?: string;
  result?: WorkerResult;
  closed: Promise<WorkerResult>;
}

const workerCaptures = new WeakMap<ChildProcess, WorkerCapture>();

function appendDiagnosticTail(current: string, chunk: Buffer | string): string {
  const combined = current + chunk.toString();
  return combined.length <= MAX_WORKER_DIAGNOSTIC_CHARS
    ? combined
    : combined.slice(-MAX_WORKER_DIAGNOSTIC_CHARS);
}

function diagnosticText(error: unknown): string {
  const text = error instanceof Error ? error.stack ?? error.message : String(error);
  return appendDiagnosticTail("", text);
}

function startWorker(mode: string, stateFile: string, iterations = 1): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(worker), mode, stateFile, String(iterations)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let resolveClosed!: (result: WorkerResult) => void;
  const capture: WorkerCapture = {
    mode,
    stdout: "",
    stderr: "",
    closed: new Promise<WorkerResult>((resolvePromise) => {
      resolveClosed = resolvePromise;
    }),
  };
  child.stdout?.on("data", (chunk: Buffer | string) => {
    capture.stdout = appendDiagnosticTail(capture.stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    capture.stderr = appendDiagnosticTail(capture.stderr, chunk);
  });
  child.once("error", (error) => {
    capture.spawnError = diagnosticText(error);
  });
  child.once("close", (code, signal) => {
    const result: WorkerResult = {
      pid: child.pid,
      code,
      signal,
      stdout: capture.stdout,
      stderr: capture.stderr,
      ...(capture.spawnError === undefined ? {} : { spawnError: capture.spawnError }),
    };
    capture.result = result;
    resolveClosed(result);
  });
  workerCaptures.set(child, capture);
  return child;
}

function captureFor(child: ChildProcess): WorkerCapture {
  const capture = workerCaptures.get(child);
  assert.ok(capture, "worker diagnostics were not initialized");
  return capture;
}

function terminateWorker(child: ChildProcess): void {
  const capture = captureFor(child);
  if (capture.result !== undefined) return;
  try {
    if (!child.kill("SIGKILL")) capture.terminationError = "worker rejected SIGKILL";
  } catch (error) {
    capture.terminationError = diagnosticText(error);
  }
}

function detachUnclosedWorker(child: ChildProcess): void {
  const capture = captureFor(child);
  terminateWorker(child);
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  const detail = "worker handle detached after close deadline";
  capture.terminationError = capture.terminationError === undefined
    ? detail
    : `${capture.terminationError}; ${detail}`;
}

class WorkerGroup {
  readonly children: ChildProcess[] = [];
  private deadlineMs: number;
  private deadlineAt: number;
  private readonly deadlineReached: Promise<void>;
  private deadlineTimer: NodeJS.Timeout;
  private readonly reachDeadline: () => void;
  private cleanup: Promise<void> | undefined;
  private closing = false;
  private deadlineFailureReported = false;

  constructor(deadlineMs = DEFAULT_WORKER_DEADLINE_MS) {
    this.deadlineMs = deadlineMs;
    this.deadlineAt = Date.now() + deadlineMs;
    let reachDeadline!: () => void;
    this.deadlineReached = new Promise<void>((resolvePromise) => {
      reachDeadline = resolvePromise;
    });
    this.reachDeadline = reachDeadline;
    this.deadlineTimer = this.startDeadlineTimer(deadlineMs);
  }

  restartDeadline(deadlineMs: number): void {
    assert.equal(this.closing, false, "cannot restart a worker deadline after cleanup began");
    clearTimeout(this.deadlineTimer);
    this.deadlineMs = deadlineMs;
    this.deadlineAt = Date.now() + deadlineMs;
    this.deadlineTimer = this.startDeadlineTimer(deadlineMs);
  }

  start(mode: string, stateFile: string, iterations = 1): ChildProcess {
    assert.equal(this.closing, false, "cannot start a worker after cleanup began");
    const child = startWorker(mode, stateFile, iterations);
    this.children.push(child);
    return child;
  }

  async waitForLine(child: ChildProcess, expected: string): Promise<void> {
    const capture = captureFor(child);
    if (capture.stdout.split(/\r?\n/u).includes(expected)) return;

    let observed = capture.stdout;
    let onData: ((chunk: Buffer | string) => void) | undefined;
    const expectedLine = new Promise<void>((resolvePromise) => {
      onData = (chunk: Buffer | string) => {
        observed = appendDiagnosticTail(observed, chunk);
        if (observed.split(/\r?\n/u).includes(expected)) resolvePromise();
      };
      child.stdout?.on("data", onData);
    });
    try {
      await this.beforeDeadline(
        Promise.race([
          expectedLine,
          capture.closed.then((result) => {
            throw new Error(
              `worker closed before ${expected}: ${JSON.stringify(result, null, 2)}`,
            );
          }),
        ]),
        `waiting for ${capture.mode} worker to print ${JSON.stringify(expected)}`,
      );
    } finally {
      if (onData) child.stdout?.off("data", onData);
    }
  }

  async waitForExit(child: ChildProcess): Promise<WorkerResult> {
    const capture = captureFor(child);
    return this.beforeDeadline(capture.closed, `waiting for ${capture.mode} worker to close`);
  }

  async kill(child: ChildProcess): Promise<void> {
    const capture = captureFor(child);
    terminateWorker(child);
    await this.beforeDeadline(capture.closed, `waiting for killed ${capture.mode} worker to close`);
  }

  async close(): Promise<void> {
    clearTimeout(this.deadlineTimer);
    try {
      await this.terminateAll();
    } catch (error) {
      // beforeDeadline already attached this cleanup failure to its richer
      // per-worker diagnostic. Do not replace that reported root cause later.
      if (!this.deadlineFailureReported) throw error;
    }
  }

  private async beforeDeadline<T>(operation: Promise<T>, description: string): Promise<T> {
    const outcome = await Promise.race([
      operation.then((value) => ({ kind: "completed" as const, value })),
      this.deadlineReached.then(() => ({ kind: "deadline" as const })),
    ]);
    if (outcome.kind === "completed") return outcome.value;

    let cleanupError: string | undefined;
    try {
      await this.terminateAll();
    } catch (error) {
      cleanupError = diagnosticText(error);
    }
    this.deadlineFailureReported = true;
    throw new Error(
      `worker deadline of ${this.deadlineMs}ms exceeded while ${description}:
${this.diagnostics(cleanupError)}`,
    );
  }

  private startDeadlineTimer(deadlineMs: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.reachDeadline();
      const cleanup = this.terminateAll();
      void cleanup.catch(() => undefined);
    }, deadlineMs);
    timer.unref();
    return timer;
  }

  private terminateAll(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup;
    this.closing = true;
    this.cleanup = this.terminateAllOnce();
    return this.cleanup;
  }

  private async terminateAllOnce(): Promise<void> {
    const surviving = this.children.filter((child) => captureFor(child).result === undefined);
    for (const child of surviving) terminateWorker(child);

    let timeout: NodeJS.Timeout | undefined;
    const closeOutcome = await Promise.race([
      Promise.all(surviving.map((child) => captureFor(child).closed)).then(() => "closed" as const),
      new Promise<"timeout">((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise("timeout"), WORKER_CLOSE_DEADLINE_MS);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (closeOutcome === "timeout") {
      for (const child of surviving) {
        if (captureFor(child).result === undefined) detachUnclosedWorker(child);
      }
      throw new Error(`workers did not close within ${WORKER_CLOSE_DEADLINE_MS}ms after termination`);
    }
  }

  private diagnostics(cleanupError: string | undefined): string {
    return JSON.stringify({
      runtime: { node: process.version, uv: process.versions.uv, platform: process.platform },
      deadlineAt: new Date(this.deadlineAt).toISOString(),
      ...(cleanupError === undefined ? {} : { cleanupError }),
      workers: this.children.map((child, index) => {
        const capture = captureFor(child);
        return {
          index,
          mode: capture.mode,
          pid: child.pid,
          closed: capture.result !== undefined,
          code: capture.result?.code ?? child.exitCode,
          signal: capture.result?.signal ?? child.signalCode,
          stdout: capture.stdout,
          stderr: capture.stderr,
          ...(capture.spawnError === undefined ? {} : { spawnError: capture.spawnError }),
          ...(capture.terminationError === undefined ? {} : { terminationError: capture.terminationError }),
        };
      }),
    }, null, 2);
  }
}

function storeFor(stateFile: string): JsonFileStateStore<CounterState> {
  return new JsonFileStateStore({
    stateFile,
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 3_000,
    staleLockMs: 200,
  });
}

async function ageArtifacts(directory: string, stateName: string): Promise<void> {
  const old = new Date(Date.now() - 10_000);
  for (const name of await readdir(directory)) {
    if (name.startsWith(stateName)) await utimes(join(directory, name), old, old);
  }
}

async function cleanupWorkersAndDirectory(workers: WorkerGroup, directory: string): Promise<void> {
  try {
    await workers.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("spawned writers do not lose updates across real process locks", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-process-lock-"));
  const stateFile = join(directory, "state.json");
  await writeFile(stateFile, '{"count":0}\n', { mode: 0o600 });
  const workers = new WorkerGroup();
  try {
    const children = Array.from({ length: 4 }, () => workers.start("increment", stateFile, 20));
    const results = await Promise.all(children.map((child) => workers.waitForExit(child)));
    const stateCount = await readFile(stateFile, "utf8")
      .then((contents) => (JSON.parse(contents) as CounterState).count)
      .catch((error: unknown) => `unreadable: ${error instanceof Error ? error.message : String(error)}`);
    const diagnostics = JSON.stringify({
      runtime: { node: process.version, uv: process.versions.uv, platform: process.platform },
      workers: results.map((result, index) => ({ index, ...result })),
      stateCount,
      artifacts: await readdir(directory).catch(() => ["<unreadable>"]),
    }, null, 2);
    assert.deepEqual(
      results.map(({ code }) => code),
      [0, 0, 0, 0],
      `worker failure diagnostics:
${diagnostics}`,
    );
    assert.equal(stateCount, 80, `counter mismatch diagnostics:
${diagnostics}`);
  } finally {
    await cleanupWorkersAndDirectory(workers, directory);
  }
});

test("a crash after state candidate fsync leaves the previous state recoverable", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-state-crash-"));
  const stateFile = join(directory, "state.json");
  await writeFile(stateFile, '{"count":7}\n', { mode: 0o600 });
  const workers = new WorkerGroup();
  try {
    const child = workers.start("crash-state", stateFile);
    await workers.waitForLine(child, "READY");
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 7);
    await workers.kill(child);
    await ageArtifacts(directory, "state.json");

    await storeFor(stateFile).transact((state) => {
      state.count += 1;
    });
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 8);
    assert.ok((await readdir(directory)).every((name) => !name.endsWith(".tmp")));
  } finally {
    await cleanupWorkersAndDirectory(workers, directory);
  }
});

test("lock candidates are complete, live creators survive cleanup, and dead owners are reclaimed", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-lock-crash-"));
  const stateFile = join(directory, "state.json");
  await writeFile(stateFile, '{"count":3}\n', { mode: 0o600 });
  const workers = new WorkerGroup();
  try {
    const candidateChild = workers.start("crash-lock-candidate", stateFile);
    await workers.waitForLine(candidateChild, "READY");
    await assert.rejects(() => stat(`${stateFile}.lock`), { code: "ENOENT" });
    const candidate = (await readdir(directory)).find((name) => name.endsWith(".candidate"));
    assert.ok(candidate);
    assert.doesNotThrow(() => JSON.parse(requireText(join(directory, candidate))));
    await ageArtifacts(directory, "state.json");

    // Another owner may clean old artifacts while this pre-publication creator
    // is delayed. It must use owner liveness, not age alone, or it can delete a
    // candidate that is still about to be linked as the fixed lock.
    await storeFor(stateFile).transact(() => undefined);
    assert.ok((await readdir(directory)).includes(candidate), "a live lock candidate was deleted");

    await workers.kill(candidateChild);
    await ageArtifacts(directory, "state.json");

    const ownerChild = workers.start("hold-lock", stateFile);
    await workers.waitForLine(ownerChild, "READY");
    const lock = JSON.parse(await readFile(`${stateFile}.lock`, "utf8"));
    assert.equal(typeof lock.nonce, "string");
    assert.equal(typeof lock.pid, "number");
    await workers.kill(ownerChild);
    await ageArtifacts(directory, "state.json");

    await storeFor(stateFile).transact((state) => {
      state.count += 1;
    });
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 4);
    assert.ok((await readdir(directory)).every((name) => !name.endsWith(".candidate")));
  } finally {
    await cleanupWorkersAndDirectory(workers, directory);
  }
});

test("stale candidate cleanup retains malformed and nonce-mismatched owner evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-candidate-evidence-"));
  const stateFile = join(directory, "state.json");
  const mismatchedName = "state.json.lock.11111111-1111-4111-8111-111111111111.candidate";
  const malformedName = "state.json.lock.33333333-3333-4333-8333-333333333333.candidate";
  try {
    await writeFile(stateFile, '{"count":3}\n', { mode: 0o600 });
    await writeFile(join(directory, mismatchedName), `${JSON.stringify({
      version: 1,
      nonce: "22222222-2222-4222-8222-222222222222",
      pid: 2_147_483_647,
      acquiredAt: 0,
    })}\n`, { mode: 0o600 });
    await writeFile(join(directory, malformedName), "{\n", { mode: 0o600 });
    await ageArtifacts(directory, "state.json");

    await storeFor(stateFile).transact(() => undefined);
    const remaining = await readdir(directory);
    assert.ok(remaining.includes(mismatchedName));
    assert.ok(remaining.includes(malformedName));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker deadlines terminate survivors and retain bounded diagnostics", { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-worker-deadline-"));
  const stateFile = join(directory, "state.json");
  const workers = new WorkerGroup(10_000);
  try {
    const child = workers.start("diagnostic-hang", stateFile);
    await workers.waitForLine(child, "READY");
    workers.restartDeadline(2_000);
    const capture = captureFor(child);

    await assert.rejects(
      () => workers.waitForExit(child),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /worker deadline of 2000ms exceeded/u);
        assert.match(error.message, /STDOUT_TAIL/u);
        assert.match(error.message, /STDERR_TAIL/u);
        return true;
      },
    );
    // Repeated cleanup must not replace the richer deadline diagnostic above.
    await workers.close();
    assert.ok(capture.result, "deadline cleanup must await the worker close event");
    assert.ok(capture.stdout.length <= MAX_WORKER_DIAGNOSTIC_CHARS);
    assert.ok(capture.stderr.length <= MAX_WORKER_DIAGNOSTIC_CHARS);
  } finally {
    await cleanupWorkersAndDirectory(workers, directory);
  }
});

function requireText(path: string): string {
  // Candidate inspection is intentionally synchronous only in this tiny fault test.
  return readFileSync(path, "utf8");
}

test("pre-existing fixed reclaim claims are never deleted automatically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-reclaim-fail-closed-"));
  const stateFile = join(directory, "state.json");
  const lockFile = `${stateFile}.lock`;
  const reclaimFile = `${stateFile}.lock.reclaim`;
  const ownerRecord = (nonce: string) => `${JSON.stringify({
    version: 1,
    nonce,
    pid: 2_147_483_647,
    acquiredAt: 0,
  })}\n`;
  const lockContents = ownerRecord("target-lock-owner");
  const reclaimContents = ownerRecord("obsolete-claim-owner");
  await writeFile(lockFile, lockContents, { mode: 0o600 });
  await writeFile(reclaimFile, reclaimContents, { mode: 0o600 });
  let destructiveHooks = 0;
  const createStore = () => new JsonFileStateStore({
    stateFile,
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 100,
    staleLockMs: 5,
    faultHooks: {
      beforeFilesystemOperation(operation) {
        if (operation === "reclaim-unlink" || operation === "lock-unlink") destructiveHooks += 1;
      },
    },
  }) as unknown as LockProtocolTestStore;

  try {
    const storeA = createStore();
    const storeB = createStore();
    const expectedA = await storeA.observeLock();
    const expectedB = await storeB.observeLock();
    const results = await Promise.all([
      storeA.unlinkObservedLock(expectedA),
      storeB.unlinkObservedLock(expectedB),
    ]);

    assert.deepEqual(results, [{ status: "changed" }, { status: "changed" }]);
    assert.equal(destructiveHooks, 0);
    assert.equal(await readFile(lockFile, "utf8"), lockContents);
    assert.equal(await readFile(reclaimFile, "utf8"), reclaimContents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple processes fail closed behind a pre-existing reclaim claim", { timeout: PROCESS_TEST_TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-reclaim-process-"));
  const stateFile = join(directory, "state.json");
  const lockFile = `${stateFile}.lock`;
  const reclaimFile = `${stateFile}.lock.reclaim`;
  const ownerRecord = (nonce: string) => `${JSON.stringify({
    version: 1,
    nonce,
    pid: 2_147_483_647,
    acquiredAt: 0,
  })}\n`;
  const lockContents = ownerRecord("dead-lock-owner");
  await writeFile(stateFile, '{"count":0}\n', { mode: 0o600 });
  await writeFile(lockFile, lockContents, { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  await utimes(lockFile, old, old);
  const workers = new WorkerGroup();

  try {
    const claimant = workers.start("crash-reaper", stateFile);
    await workers.waitForLine(claimant, "READY");
    const [lockStats, reclaimStats] = await Promise.all([
      stat(lockFile, { bigint: true }),
      stat(reclaimFile, { bigint: true }),
    ]);
    assert.equal(lockStats.dev, reclaimStats.dev);
    assert.equal(lockStats.ino, reclaimStats.ino);
    const reclaimContents = await readFile(reclaimFile, "utf8");
    assert.equal(reclaimContents, lockContents);
    await workers.kill(claimant);

    const children = [
      workers.start("blocked-reclaim", stateFile),
      workers.start("blocked-reclaim", stateFile),
    ];
    const results = await Promise.all(children.map((child) => workers.waitForExit(child)));
    assert.deepEqual(results.map(({ code }) => code), [1, 1]);
    for (const result of results) {
      assert.match(result.stderr, /StateLockTimeoutError/u);
      assert.match(result.stderr, /Timed out after 250 ms while waiting for state lock/u);
    }
    assert.equal(await readFile(lockFile, "utf8"), lockContents);
    assert.equal(await readFile(reclaimFile, "utf8"), reclaimContents);
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 0);
  } finally {
    await cleanupWorkersAndDirectory(workers, directory);
  }
});


test("the backup remains a complete prior generation and supports manual recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rotator-backup-"));
  const stateFile = join(directory, "state.json");
  const store = storeFor(stateFile);
  try {
    await store.transact((state) => {
      state.count = 1;
    });
    await store.transact((state) => {
      state.count = 2;
    });
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 2);
    assert.equal(JSON.parse(await readFile(`${stateFile}.bak`, "utf8")).count, 1);

    await writeFile(stateFile, "{broken", { mode: 0o600 });
    await assert.rejects(() => store.read(), /malformed JSON/);
    const recovery = `${stateFile}.recovery`;
    await copyFile(`${stateFile}.bak`, recovery);
    await chmod(recovery, 0o600);
    await rename(recovery, stateFile);
    assert.equal((await store.read()).count, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
