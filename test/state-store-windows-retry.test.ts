import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  JsonFileStateStore,
  StateLockTimeoutError,
  StateSecurityError,
} from "../src/state-store.ts";
import type { JsonFileStateStoreOptions } from "../src/state-store.ts";

interface CounterState { count: number }
interface TestLockOwner {
  version: 1;
  nonce: string;
  pid: number;
  acquiredAt: number;
}
interface LockProtocolTestStore {
  observeLock(): Promise<unknown>;
  unlinkObservedLock(expected: unknown): Promise<{ status: string }>;
  releaseOwnedLock(owner: TestLockOwner): Promise<void>;
}
type FaultHook = NonNullable<
  NonNullable<JsonFileStateStoreOptions<CounterState>["faultHooks"]>["beforeFilesystemOperation"]
>;

const originalPlatform = process.platform;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withPlatform<R>(platform: NodeJS.Platform, operation: () => Promise<R>): Promise<R> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor?.configurable);
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

function filesystemError(code: string, syscall = "fault-hook"): NodeJS.ErrnoException {
  const error = new Error(`${code} from ${syscall}`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = syscall;
  return error;
}

function storeFor(
  stateFile: string,
  beforeFilesystemOperation?: FaultHook,
  overrides: Partial<JsonFileStateStoreOptions<CounterState>> = {},
): JsonFileStateStore<CounterState> {
  return new JsonFileStateStore({
    stateFile,
    initialState: () => ({ count: 0 }),
    lockTimeoutMs: 1_000,
    staleLockMs: 200,
    ...overrides,
    ...(beforeFilesystemOperation === undefined
      ? {}
      : { faultHooks: { beforeFilesystemOperation } }),
  });
}

async function expectMissing(path: string): Promise<void> {
  await assert.rejects(() => stat(path), { code: "ENOENT" });
}

test("Windows state replacement retries transient sharing errors without rerunning the mutator", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-state-retry-"));
    const stateFile = join(directory, "state.json");
    await writeFile(stateFile, '{"count":0}\n', { mode: 0o600 });
    let renameAttempts = 0;
    let mutatorCalls = 0;
    const store = storeFor(stateFile, async (operation) => {
      if (operation !== "state-rename") return;
      renameAttempts += 1;
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 0);
      if (renameAttempts < 3) throw filesystemError("EPERM", "rename");
    });

    try {
      await store.transact((state) => {
        mutatorCalls += 1;
        state.count += 1;
      });
      assert.equal(renameAttempts, 3);
      assert.equal(mutatorCalls, 1);
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test(
  "non-Windows state replacement does not retry Windows sharing errors",
  { skip: originalPlatform === "win32" },
  async () => {
    await withPlatform("linux", async () => {
      const directory = await mkdtemp(join(tmpdir(), "pi-rotator-nonwin-state-retry-"));
      const stateFile = join(directory, "state.json");
      await writeFile(stateFile, '{"count":0}\n', { mode: 0o600 });
      let renameAttempts = 0;
      let mutatorCalls = 0;
      const store = storeFor(stateFile, (operation) => {
        if (operation !== "state-rename") return;
        renameAttempts += 1;
        throw filesystemError("EPERM", "rename");
      });

      try {
        await assert.rejects(
          () =>
            store.transact((state) => {
              mutatorCalls += 1;
              state.count += 1;
            }),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "EPERM",
        );
        assert.equal(renameAttempts, 1);
        assert.equal(mutatorCalls, 1);
        assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test("Windows lock publication retries EPERM instead of reporting unsupported hard links", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-publish-retry-"));
    const stateFile = join(directory, "state.json");
    let publishAttempts = 0;
    let mutatorCalls = 0;
    const store = storeFor(stateFile, (operation) => {
      if (operation !== "lock-publish-link") return;
      publishAttempts += 1;
      if (publishAttempts < 3) throw filesystemError("EPERM", "link");
    });

    try {
      await store.transact((state) => {
        mutatorCalls += 1;
        state.count += 1;
      });
      assert.equal(publishAttempts, 3);
      assert.equal(mutatorCalls, 1);
      assert.equal((await store.read()).count, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("lock publication transient retries honor both abort and acquisition deadline", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-publish-bounds-"));
    try {
      const abortedFile = join(directory, "aborted.json");
      const controller = new AbortController();
      let abortAttempts = 0;
      const abortedStore = storeFor(abortedFile, (operation) => {
        if (operation !== "lock-publish-link") return;
        abortAttempts += 1;
        controller.abort();
        throw filesystemError("EBUSY", "link");
      });
      await assert.rejects(
        () => abortedStore.transact(() => undefined, { signal: controller.signal }),
        { name: "AbortError" },
      );
      assert.equal(abortAttempts, 1);
      await expectMissing(`${abortedFile}.lock`);

      const deadlineFile = join(directory, "deadline.json");
      let deadlineAttempts = 0;
      let clockCalls = 0;
      const deadlineStore = storeFor(
        deadlineFile,
        (operation) => {
          if (operation !== "lock-publish-link") return;
          deadlineAttempts += 1;
          throw filesystemError("EPERM", "link");
        },
        {
          lockTimeoutMs: 50,
          monotonicClock: { now: () => (clockCalls++ === 0 ? 0 : 100) },
        },
      );
      await assert.rejects(
        () => deadlineStore.transact(() => undefined),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EPERM" &&
          !/does not support/.test(error.message),
      );
      assert.equal(deadlineAttempts, 1);
      await expectMissing(`${deadlineFile}.lock`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("successful lock publication after the deadline is released before timing out", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-publish-late-success-"));
    const stateFile = join(directory, "state.json");
    let now = 0;
    let publishAttempts = 0;
    let mutatorCalls = 0;
    const store = storeFor(
      stateFile,
      (operation) => {
        if (operation !== "lock-publish-link") return;
        publishAttempts += 1;
        now = 51;
      },
      {
        lockTimeoutMs: 50,
        monotonicClock: { now: () => now },
      },
    );

    try {
      await assert.rejects(
        () =>
          store.transact((state) => {
            mutatorCalls += 1;
            state.count += 1;
          }),
        StateLockTimeoutError,
      );
      assert.equal(publishAttempts, 1);
      assert.equal(mutatorCalls, 0);
      await expectMissing(`${stateFile}.lock`);
      await expectMissing(`${stateFile}.lock.reclaim`);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("post-publication cancellation takes priority over a crossed deadline", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-publish-late-abort-"));
    const stateFile = join(directory, "state.json");
    const controller = new AbortController();
    let now = 0;
    let mutatorCalls = 0;
    const store = storeFor(
      stateFile,
      (operation) => {
        if (operation !== "lock-publish-link") return;
        now = 51;
        controller.abort();
      },
      {
        lockTimeoutMs: 50,
        monotonicClock: { now: () => now },
      },
    );

    try {
      await assert.rejects(
        () =>
          store.transact(
            () => {
              mutatorCalls += 1;
            },
            { signal: controller.signal },
          ),
        { name: "AbortError" },
      );
      assert.equal(mutatorCalls, 0);
      await expectMissing(`${stateFile}.lock`);
      await expectMissing(`${stateFile}.lock.reclaim`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("cancellation during a post-publication probe wins deadline and filesystem errors", async () => {
  await withPlatform("win32", async () => {
    for (const throwTransientError of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-probe-abort-"));
      const stateFile = join(directory, "state.json");
      const controller = new AbortController();
      let now = 0;
      let published = false;
      let probeInjected = false;
      let mutatorCalls = 0;
      const store = storeFor(
        stateFile,
        (operation) => {
          if (operation === "lock-publish-link") published = true;
          if (operation !== "lock-observe-open" || !published || probeInjected) return;
          probeInjected = true;
          now = 51;
          controller.abort();
          if (throwTransientError) throw filesystemError("EACCES", "open");
        },
        {
          lockTimeoutMs: 50,
          monotonicClock: { now: () => now },
        },
      );

      try {
        await assert.rejects(
          () =>
            store.transact(
              () => {
                mutatorCalls += 1;
              },
              { signal: controller.signal },
            ),
          { name: "AbortError" },
        );
        assert.equal(probeInjected, true);
        assert.equal(mutatorCalls, 0);
        await expectMissing(`${stateFile}.lock`);
        await expectMissing(`${stateFile}.lock.reclaim`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

test("a release failure does not mask a post-publication timeout", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-publish-late-cleanup-"));
    const stateFile = join(directory, "state.json");
    let now = 0;
    let mutatorCalls = 0;
    const store = storeFor(
      stateFile,
      (operation) => {
        if (operation === "lock-publish-link") now = 51;
        if (operation === "lock-unlink") throw filesystemError("EIO", "unlink-lock");
      },
      {
        lockTimeoutMs: 50,
        monotonicClock: { now: () => now },
      },
    );

    try {
      await assert.rejects(
        () =>
          store.transact(() => {
            mutatorCalls += 1;
          }),
        StateLockTimeoutError,
      );
      assert.equal(mutatorCalls, 0);
      assert.equal(typeof JSON.parse(await readFile(`${stateFile}.lock`, "utf8")).nonce, "string");
      await expectMissing(`${stateFile}.lock.reclaim`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("cancellation during published-candidate cleanup releases the lock without running the mutator", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-post-publish-abort-"));
    const stateFile = join(directory, "state.json");
    const controller = new AbortController();
    let candidateCleanupAttempts = 0;
    let mutatorCalls = 0;
    const store = storeFor(stateFile, (operation) => {
      if (operation !== "lock-candidate-unlink") return;
      candidateCleanupAttempts += 1;
      controller.abort();
      throw filesystemError("EBUSY", "unlink");
    });

    try {
      await assert.rejects(
        () =>
          store.transact(
            () => {
              mutatorCalls += 1;
            },
            { signal: controller.signal },
          ),
        { name: "AbortError" },
      );
      assert.equal(candidateCleanupAttempts, 1);
      assert.equal(mutatorCalls, 0);
      await expectMissing(`${stateFile}.lock`);
      await expectMissing(`${stateFile}.lock.reclaim`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("Windows lock observation retries transient open errors", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-observe-retry-"));
    const stateFile = join(directory, "state.json");
    let observeAttempts = 0;
    let mutatorCalls = 0;
    const store = storeFor(stateFile, (operation) => {
      if (operation !== "lock-observe-open") return;
      observeAttempts += 1;
      if (observeAttempts < 3) throw filesystemError("EACCES", "open");
    });

    try {
      await store.transact((state) => {
        mutatorCalls += 1;
        state.count += 1;
      });
      assert.ok(observeAttempts >= 3);
      assert.equal(mutatorCalls, 1);
      await expectMissing(`${stateFile}.lock`);
      await expectMissing(`${stateFile}.lock.reclaim`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("lock observation preserves ENOENT and ELOOP semantics", async () => {
  await withPlatform("win32", async () => {
    const missingDirectory = await mkdtemp(join(tmpdir(), "pi-rotator-win-observe-enoent-"));
    const missingStateFile = join(missingDirectory, "state.json");
    let missingAttempts = 0;
    const missingStore = storeFor(missingStateFile, (operation) => {
      if (operation !== "lock-observe-open") return;
      missingAttempts += 1;
      if (missingAttempts === 1) throw filesystemError("ENOENT", "open");
    });

    try {
      await missingStore.transact((state) => {
        state.count += 1;
      });
      assert.ok(missingAttempts >= 3);
      await expectMissing(`${missingStateFile}.lock`);
    } finally {
      await rm(missingDirectory, { recursive: true, force: true });
    }

    const loopDirectory = await mkdtemp(join(tmpdir(), "pi-rotator-win-observe-eloop-"));
    const loopStateFile = join(loopDirectory, "state.json");
    let loopAttempts = 0;
    const loopStore = storeFor(loopStateFile, (operation) => {
      if (operation !== "lock-observe-open") return;
      loopAttempts += 1;
      throw filesystemError("ELOOP", "open");
    });

    try {
      await assert.rejects(
        () =>
          loopStore.transact((state) => {
            state.count += 1;
          }),
        StateSecurityError,
      );
      assert.equal(loopAttempts, 1);
    } finally {
      await rm(loopDirectory, { recursive: true, force: true });
    }
  });
});

test("only definitive link errors are reported as unsupported", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-unsupported-"));
    const stateFile = join(directory, "state.json");
    let attempts = 0;
    const store = storeFor(stateFile, (operation) => {
      if (operation !== "lock-publish-link") return;
      attempts += 1;
      throw filesystemError("ENOTSUP", "link");
    });

    try {
      await assert.rejects(
        () => store.transact(() => undefined),
        (error: unknown) =>
          error instanceof Error &&
          /does not support atomic hard-link locks/.test(error.message) &&
          error.cause instanceof Error &&
          "code" in error.cause &&
          error.cause.code === "ENOTSUP",
      );
      assert.equal(attempts, 1);
      await expectMissing(`${stateFile}.lock`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("persistent backup replacement refusal keeps the prior backup and retries temp cleanup", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-backup-retry-"));
    const stateFile = join(directory, "state.json");
    await writeFile(stateFile, '{"count":0}\n', { mode: 0o600 });
    let inject = false;
    let backupRenameAttempts = 0;
    let cleanupAttempts = 0;
    let mutatorCalls = 0;
    const store = storeFor(stateFile, (operation) => {
      if (!inject) return;
      if (operation === "backup-rename") {
        backupRenameAttempts += 1;
        throw filesystemError("EBUSY", "rename");
      }
      if (operation === "backup-temp-unlink") {
        cleanupAttempts += 1;
        if (cleanupAttempts < 3) throw filesystemError("EACCES", "unlink");
      }
    });

    try {
      await store.transact((state) => {
        state.count = 1;
      });
      inject = true;
      await store.transact((state) => {
        mutatorCalls += 1;
        state.count = 2;
      });

      assert.equal(backupRenameAttempts, 6);
      assert.equal(cleanupAttempts, 3);
      assert.equal(mutatorCalls, 1);
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 2);
      assert.equal(JSON.parse(await readFile(`${stateFile}.bak`, "utf8")).count, 0);
      assert.ok((await readdir(directory)).every((name) => !name.includes(".bak.") || !name.endsWith(".tmp")));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("fixed lock unlink retries only while its hard-link claim remains valid", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-release-retry-"));
    const stateFile = join(directory, "state.json");
    let claimAttempts = 0;
    let unlinkAttempts = 0;
    const store = storeFor(stateFile, async (operation) => {
      if (operation === "lock-claim-link") {
        claimAttempts += 1;
        if (claimAttempts < 3) throw filesystemError("EPERM", "link");
      }
      if (operation === "lock-unlink") {
        unlinkAttempts += 1;
        const lock = await stat(`${stateFile}.lock`, { bigint: true });
        const claim = await stat(`${stateFile}.lock.reclaim`, { bigint: true });
        assert.equal(lock.dev, claim.dev);
        assert.equal(lock.ino, claim.ino);
        if (unlinkAttempts < 3) throw filesystemError("EBUSY", "unlink");
      }
    });

    try {
      await store.transact((state) => {
        state.count += 1;
      });
      assert.equal(claimAttempts, 3);
      assert.equal(unlinkAttempts, 3);
      await expectMissing(`${stateFile}.lock`);
      await expectMissing(`${stateFile}.lock.reclaim`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("reclaim cleanup exhaustion is surfaced after the fixed lock was removed", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-reclaim-cleanup-"));
    const stateFile = join(directory, "state.json");
    let cleanupAttempts = 0;
    const store = storeFor(stateFile, (operation) => {
      if (operation !== "reclaim-unlink") return;
      cleanupAttempts += 1;
      throw filesystemError("EBUSY", "unlink");
    });

    try {
      await assert.rejects(
        () =>
          store.transact((state) => {
            state.count += 1;
          }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "EBUSY",
      );
      assert.equal(cleanupAttempts, 6);
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 1);
      await expectMissing(`${stateFile}.lock`);
      assert.equal(typeof JSON.parse(await readFile(`${stateFile}.lock.reclaim`, "utf8")).nonce, "string");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("reclaim cleanup failure does not mask an existing fixed-lock error", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-reclaim-primary-"));
    const stateFile = join(directory, "state.json");
    let cleanupAttempts = 0;
    const store = storeFor(stateFile, (operation) => {
      if (operation === "lock-unlink") throw filesystemError("EIO", "unlink-lock");
      if (operation === "reclaim-unlink") {
        cleanupAttempts += 1;
        throw filesystemError("EACCES", "unlink-reclaim");
      }
    });

    try {
      await assert.rejects(
        () =>
          store.transact((state) => {
            state.count += 1;
          }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "EIO" &&
          "syscall" in error &&
          error.syscall === "unlink-lock",
      );
      assert.equal(cleanupAttempts, 6);
      assert.equal(typeof JSON.parse(await readFile(`${stateFile}.lock`, "utf8")).nonce, "string");
      assert.equal(typeof JSON.parse(await readFile(`${stateFile}.lock.reclaim`, "utf8")).nonce, "string");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("reclaim cleanup failure does not mask the transaction's primary error", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-reclaim-transaction-"));
    const stateFile = join(directory, "state.json");
    const primaryError = new Error("primary transaction failure");
    let cleanupAttempts = 0;
    const store = storeFor(stateFile, (operation) => {
      if (operation !== "reclaim-unlink") return;
      cleanupAttempts += 1;
      throw filesystemError("EACCES", "unlink-reclaim");
    });

    try {
      await assert.rejects(
        () =>
          store.transact(() => {
            throw primaryError;
          }),
        (error: unknown) => error === primaryError,
      );
      assert.equal(cleanupAttempts, 6);
      await expectMissing(`${stateFile}.lock`);
      assert.equal(typeof JSON.parse(await readFile(`${stateFile}.lock.reclaim`, "utf8")).nonce, "string");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("a claim appearing during publication clears before ownership reaches the mutator", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-publish-claim-fence-"));
    const stateFile = join(directory, "state.json");
    const reclaimFile = `${stateFile}.lock.reclaim`;
    const claimContents = `${JSON.stringify({
      version: 1,
      nonce: "overlapping-reaper-claim",
      pid: process.pid,
      acquiredAt: Date.now(),
    })}\n`;
    const claimObserved = deferred();
    let published = false;
    let observedAfterPublish = false;
    let mutatorCalls = 0;
    const store = storeFor(stateFile, async (operation) => {
      if (operation === "lock-publish-link" && !published) {
        published = true;
        await writeFile(reclaimFile, claimContents, { mode: 0o600, flag: "wx" });
      }
      if (operation === "lock-observe-open" && published && !observedAfterPublish) {
        observedAfterPublish = true;
        claimObserved.resolve();
      }
    });

    try {
      const transaction = store.transact((state) => {
        mutatorCalls += 1;
        state.count += 1;
      });
      await claimObserved.promise;
      assert.equal(mutatorCalls, 0);
      assert.equal(await readFile(reclaimFile, "utf8"), claimContents);
      await unlink(reclaimFile);
      await transaction;
      assert.equal(mutatorCalls, 1);
      assert.equal((await store.read()).count, 1);
      await expectMissing(`${stateFile}.lock`);
      await expectMissing(reclaimFile);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("a pre-existing fixed claim blocks acquisition before the mutator", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-preexisting-claim-"));
    const stateFile = join(directory, "state.json");
    const reclaimFile = `${stateFile}.lock.reclaim`;
    const claimContents = `${JSON.stringify({
      version: 1,
      nonce: "crashed-reaper-claim",
      pid: 2_147_483_647,
      acquiredAt: 0,
    })}\n`;
    await writeFile(stateFile, '{"count":0}\n', { mode: 0o600 });
    await writeFile(reclaimFile, claimContents, { mode: 0o600 });
    let mutatorCalls = 0;
    const store = storeFor(stateFile, undefined, { lockTimeoutMs: 80 });

    try {
      await assert.rejects(
        () => store.transact((state) => {
          mutatorCalls += 1;
          state.count += 1;
        }),
        StateLockTimeoutError,
      );
      assert.equal(mutatorCalls, 0);
      assert.equal(await readFile(reclaimFile, "utf8"), claimContents);
      await expectMissing(`${stateFile}.lock`);
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("a claim published from a replacement lock is cleaned without deleting that lock", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-claim-replacement-"));
    const stateFile = join(directory, "state.json");
    const lockFile = `${stateFile}.lock`;
    const reclaimFile = `${stateFile}.lock.reclaim`;
    const ownerRecord = (nonce: string, pid: number) => `${JSON.stringify({
      version: 1,
      nonce,
      pid,
      acquiredAt: Date.now() - 60_000,
    })}\n`;
    await writeFile(stateFile, '{"count":0}\n', { mode: 0o600 });
    await writeFile(lockFile, ownerRecord("old-dead-owner", 2_147_483_647), { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    const replacement = ownerRecord("new-live-owner", process.pid);
    let replaced = false;
    let mutatorCalls = 0;
    const store = storeFor(
      stateFile,
      async (operation) => {
        if (operation !== "lock-claim-link" || replaced) return;
        replaced = true;
        await unlink(lockFile);
        await writeFile(lockFile, replacement, { mode: 0o600, flag: "wx" });
      },
      { lockTimeoutMs: 100, staleLockMs: 5 },
    );

    try {
      await assert.rejects(
        () => store.transact((state) => {
          mutatorCalls += 1;
          state.count += 1;
        }),
        StateLockTimeoutError,
      );
      assert.equal(replaced, true);
      assert.equal(mutatorCalls, 0);
      assert.equal(await readFile(lockFile, "utf8"), replacement);
      await expectMissing(reclaimFile);
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("an owner waits for an overlapping replacement claim before releasing its lock", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-release-overlap-"));
    const stateFile = join(directory, "state.json");
    const lockFile = `${stateFile}.lock`;
    const reclaimFile = `${stateFile}.lock.reclaim`;
    const oldOwner: TestLockOwner = {
      version: 1,
      nonce: "old-dead-owner",
      pid: 2_147_483_647,
      acquiredAt: 0,
    };
    const replacementOwner: TestLockOwner = {
      version: 1,
      nonce: "replacement-live-owner",
      pid: process.pid,
      acquiredAt: Date.now(),
    };
    const record = (owner: TestLockOwner) => `${JSON.stringify(owner)}\n`;
    await writeFile(lockFile, record(oldOwner), { mode: 0o600 });
    const expectedStore = storeFor(stateFile) as unknown as LockProtocolTestStore;
    const expected = await expectedStore.observeLock();
    const cleanupPaused = deferred();
    const allowCleanup = deferred();
    const releaseAttempted = deferred();
    let replaced = false;
    let cleanupHeld = false;
    const staleStore = storeFor(stateFile, async (operation) => {
      if (operation === "lock-claim-link" && !replaced) {
        replaced = true;
        await unlink(lockFile);
        await writeFile(lockFile, record(replacementOwner), { mode: 0o600, flag: "wx" });
      }
      if (operation === "reclaim-unlink" && !cleanupHeld) {
        cleanupHeld = true;
        cleanupPaused.resolve();
        await allowCleanup.promise;
      }
    }) as unknown as LockProtocolTestStore;
    const replacementStore = storeFor(stateFile, (operation) => {
      if (operation === "lock-claim-link") releaseAttempted.resolve();
    }) as unknown as LockProtocolTestStore;

    try {
      const staleRun = staleStore.unlinkObservedLock(expected);
      await cleanupPaused.promise;
      const releaseRun = replacementStore.releaseOwnedLock(replacementOwner);
      await releaseAttempted.promise;
      assert.equal(await readFile(lockFile, "utf8"), record(replacementOwner));
      assert.equal(await readFile(reclaimFile, "utf8"), record(replacementOwner));

      allowCleanup.resolve();
      assert.deepEqual(await staleRun, { status: "changed" });
      await releaseRun;
      await expectMissing(lockFile);
      await expectMissing(reclaimFile);
    } finally {
      allowCleanup.resolve();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("a changed fixed lock is never blindly unlinked by a delayed retry", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-release-change-"));
    const stateFile = join(directory, "state.json");
    const lockFile = `${stateFile}.lock`;
    const reclaimFile = `${stateFile}.lock.reclaim`;
    const replacement = `${JSON.stringify({
      version: 1,
      nonce: "replacement-owner-nonce",
      pid: process.pid,
      acquiredAt: Date.now(),
    })}\n`;
    let unlinkAttempts = 0;
    const store = storeFor(stateFile, async (operation) => {
      if (operation !== "lock-unlink") return;
      unlinkAttempts += 1;
      if (unlinkAttempts !== 1) return;
      await stat(reclaimFile);
      await unlink(lockFile);
      await writeFile(lockFile, replacement, { mode: 0o600, flag: "wx" });
      throw filesystemError("EBUSY", "unlink");
    });

    try {
      await store.transact((state) => {
        state.count += 1;
      });
      assert.equal(unlinkAttempts, 1);
      assert.equal(await readFile(lockFile, "utf8"), replacement);
      await expectMissing(reclaimFile);
      assert.equal((await store.read()).count, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("definitive claim failure never falls back to an unclaimed lock unlink", async () => {
  await withPlatform("win32", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rotator-win-release-unsupported-"));
    const stateFile = join(directory, "state.json");
    let claimAttempts = 0;
    const store = storeFor(stateFile, (operation) => {
      if (operation !== "lock-claim-link") return;
      claimAttempts += 1;
      throw filesystemError("ENOSYS", "link");
    });

    try {
      await assert.rejects(
        () =>
          store.transact((state) => {
            state.count += 1;
          }),
        (error: unknown) =>
          error instanceof Error &&
          /hard-link claim required to safely release/.test(error.message) &&
          error.cause instanceof Error &&
          "code" in error.cause &&
          error.cause.code === "ENOSYS",
      );
      assert.equal(claimAttempts, 1);
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).count, 1);
      assert.equal(typeof JSON.parse(await readFile(`${stateFile}.lock`, "utf8")).nonce, "string");
      await expectMissing(`${stateFile}.lock.reclaim`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
