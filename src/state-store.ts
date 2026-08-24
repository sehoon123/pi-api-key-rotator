import { isUtf8 } from "node:buffer";
import { constants as fsConstants, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, normalize, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Clock } from "./types.ts";

export interface StateStore<T> {
  /** A read-only view. Implementations must not persist or create a cross-process lock. */
  read(): Promise<T>;
  transact<R>(
    mutator: (state: T) => R | Promise<R>,
    options?: { signal?: AbortSignal },
  ): Promise<R>;
}

type RetriedFilesystemOperation =
  | "state-rename"
  | "backup-link"
  | "backup-rename"
  | "state-temp-unlink"
  | "backup-temp-unlink"
  | "lock-publish-link"
  | "lock-candidate-unlink"
  | "lock-observe-open"
  | "lock-claim-link"
  | "lock-unlink"
  | "reclaim-unlink"
  | "abandoned-artifact-unlink";

export interface JsonFileStateStoreOptions<T> {
  stateFile: string;
  initialState: () => T;
  lockTimeoutMs: number;
  staleLockMs: number;
  /** Defaults to 1 MiB. */
  maxStateFileBytes?: number;
  /** Wall clock used only for persisted timestamps and stale-age checks. */
  clock?: Clock;
  /** Monotonic clock used for lock wait deadlines. Mainly useful in tests. */
  monotonicClock?: Clock;
  /** Deterministic crash barriers and internal filesystem fault injection for tests. */
  faultHooks?: {
    afterStateInspected?: () => Promise<void> | void;
    afterStateCandidateSynced?: () => Promise<void> | void;
    afterLockCandidateSynced?: () => Promise<void> | void;
    afterStaleClaimValidated?: () => Promise<void> | void;
    /** @internal Not a stable extension surface. */
    beforeFilesystemOperation?: (operation: RetriedFilesystemOperation) => Promise<void> | void;
  };
}

export class StateLockTimeoutError extends Error {
  constructor(lockFile: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms while waiting for state lock: ${lockFile}`);
    this.name = "StateLockTimeoutError";
  }
}

export class StateLockReleaseError extends Error {
  constructor(lockFile: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms while safely releasing state lock: ${lockFile}`);
    this.name = "StateLockReleaseError";
  }
}

/** The file exists, but is not safe to interpret or replace. */
export class StateCorruptionError extends Error {
  readonly stateFile: string;

  constructor(stateFile: string, detail: string) {
    super(`Corrupt key-rotator state (${stateFile}): ${detail}`);
    this.name = "StateCorruptionError";
    this.stateFile = stateFile;
  }
}

export class StateFileTooLargeError extends StateCorruptionError {
  readonly maximumBytes: number;

  constructor(stateFile: string, maximumBytes: number) {
    super(stateFile, `file exceeds the ${maximumBytes}-byte size limit; it was not read or overwritten.`);
    this.name = "StateFileTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

export class StateSecurityError extends StateCorruptionError {
  constructor(stateFile: string, detail: string) {
    super(stateFile, detail);
    this.name = "StateSecurityError";
  }
}

class StateIdentityChangedError extends Error {}

export const DEFAULT_MAX_STATE_FILE_BYTES = 1_048_576;

const systemClock: Clock = { now: () => Date.now() };
const monotonicSystemClock: Clock = { now: () => performance.now() };
const PROCESS_QUEUE_SYMBOL = Symbol.for("pi-api-key-rotator.state-store-fifo.v1");

interface ProcessQueueEntry {
  tail: Promise<void>;
  pending: number;
}

interface ProcessQueueRegistry {
  queues: Map<string, ProcessQueueEntry>;
}

interface LockOwner {
  version: 1;
  nonce: string;
  pid: number;
  acquiredAt: number;
  /** Linux /proc start ticks. Detects PID reuse without trusting wall time. */
  processStartMarker?: string;
}

interface LockObservation {
  metadata: LockOwner | null;
  text: string;
  stats: Stats;
}

interface AcquiredLock {
  handle: FileHandle;
  owner: LockOwner;
  deadline: number;
}

interface WindowsRetryContext {
  signal: AbortSignal | undefined;
  deadline: number | undefined;
  now: () => number;
}

type UnlinkObservedLockResult =
  | { status: "removed" | "changed" }
  | { status: "unsupported"; error: NodeJS.ErrnoException };

const WINDOWS_TRANSIENT_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const;
const DEFAULT_WINDOWS_RETRY_CONTEXT: WindowsRetryContext = {
  signal: undefined,
  deadline: undefined,
  now: () => monotonicSystemClock.now(),
};

function isWindowsTransientFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    process.platform === "win32" &&
    isNodeError(error) &&
    (error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES")
  );
}

function isDefinitiveHardLinkUnsupportedError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeError(error) && (error.code === "ENOSYS" || error.code === "ENOTSUP");
}

async function retryWindowsTransientFilesystemError<R>(
  operation: () => Promise<R>,
  context: WindowsRetryContext,
): Promise<R> {
  let retryIndex = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (context.signal?.aborted) throw stateAbortError();
      if (
        !isWindowsTransientFilesystemError(error) ||
        retryIndex >= WINDOWS_TRANSIENT_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }

      let delay = WINDOWS_TRANSIENT_RETRY_DELAYS_MS[retryIndex] ?? 0;
      retryIndex += 1;
      if (context.deadline !== undefined) {
        const remaining = context.deadline - context.now();
        if (remaining <= 0) throw error;
        delay = Math.min(delay, remaining);
      }
      await sleep(delay, context.signal);
      if (context.deadline !== undefined && context.now() >= context.deadline) throw error;
    }
  }
}

function processQueueRegistry(): ProcessQueueRegistry {
  const root = globalThis as typeof globalThis & { [PROCESS_QUEUE_SYMBOL]?: ProcessQueueRegistry };
  const existing = root[PROCESS_QUEUE_SYMBOL];
  if (existing) return existing;
  const created: ProcessQueueRegistry = { queues: new Map() };
  root[PROCESS_QUEUE_SYMBOL] = created;
  return created;
}

function canonicalStateFile(stateFile: string): string {
  const canonical = normalize(resolve(stateFile));
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

function inProcessFifo<R>(
  key: string,
  operation: () => Promise<R>,
  signal?: AbortSignal,
): Promise<R> {
  const queues = processQueueRegistry().queues;
  let entry = queues.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve(), pending: 0 };
    queues.set(key, entry);
  }

  const previous = entry.tail;
  let releaseTurn: (() => void) | undefined;
  const turn = new Promise<void>((resolvePromise) => {
    releaseTurn = resolvePromise;
  });
  entry.tail = turn;
  entry.pending += 1;

  return new Promise<R>((resolvePromise, rejectPromise) => {
    let callerSettled = false;
    let started = false;
    const onAbort = () => {
      if (started || callerSettled) return;
      callerSettled = true;
      rejectPromise(stateAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    void (async () => {
      try {
        await previous;
        started = true;
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) throw stateAbortError();
        const result = await operation();
        if (!callerSettled) {
          callerSettled = true;
          resolvePromise(result);
        }
      } catch (error) {
        if (!callerSettled) {
          callerSettled = true;
          rejectPromise(error);
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        releaseTurn?.();
        entry.pending -= 1;
        if (entry.pending === 0 && queues.get(key) === entry) queues.delete(key);
      }
    })();
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(stateAbortError());
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectPromise(stateAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stateAbortError(): Error {
  const error = new Error("State lock wait was aborted.");
  error.name = "AbortError";
  return error;
}

function linuxProcessStartMarker(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const statText = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = statText.lastIndexOf(")");
    if (close < 0) return undefined;
    // The tokens after ')' begin at proc field 3; starttime is field 22.
    const marker = statText.slice(close + 1).trim().split(/\s+/u)[19];
    return marker && /^\d+$/u.test(marker) ? marker : undefined;
  } catch {
    return undefined;
  }
}

const PROCESS_START_MARKER = linuxProcessStartMarker(process.pid);

function parseLockOwner(text: string): LockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Partial<LockOwner>;
  if (
    source.version !== 1 ||
    typeof source.nonce !== "string" ||
    source.nonce.length < 8 ||
    source.nonce.length > 128 ||
    /[\u0000-\u001F\u007F]/u.test(source.nonce) ||
    !Number.isSafeInteger(source.pid) ||
    (source.pid ?? 0) <= 0 ||
    (source.pid ?? 0) > 2_147_483_647 ||
    typeof source.acquiredAt !== "number" ||
    !Number.isSafeInteger(source.acquiredAt) ||
    source.acquiredAt < 0 ||
    (source.processStartMarker !== undefined &&
      (typeof source.processStartMarker !== "string" ||
        source.processStartMarker.length > 64 ||
        !/^\d+$/u.test(source.processStartMarker)))
  ) {
    return null;
  }
  return {
    version: 1,
    nonce: source.nonce,
    pid: source.pid as number,
    acquiredAt: source.acquiredAt,
    ...(source.processStartMarker === undefined ? {} : { processStartMarker: source.processStartMarker }),
  };
}

function sameObservedFile(left: LockObservation, right: LockObservation): boolean {
  // dev+ino is the strongest identity available through portable Node APIs.
  // Some Windows filesystems report zero, so retain an exact-content fallback.
  if (left.stats.ino !== 0 && right.stats.ino !== 0) {
    return left.stats.dev === right.stats.dev && left.stats.ino === right.stats.ino;
  }
  return (
    left.text === right.text &&
    left.stats.size === right.stats.size &&
    left.stats.mtimeMs === right.stats.mtimeMs
  );
}

function sameLockIdentity(left: LockObservation, right: LockObservation): boolean {
  return (
    sameObservedFile(left, right) &&
    left.text === right.text &&
    left.metadata?.nonce === right.metadata?.nonce
  );
}

function processIsAlive(owner: LockOwner): boolean {
  try {
    if (owner.pid !== process.pid) process.kill(owner.pid, 0);
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    // EPERM means the process exists but cannot be signalled. Unknown errors
    // are treated conservatively too: an old timestamp alone is never proof.
    return true;
  }

  if (owner.processStartMarker !== undefined) {
    const currentMarker = linuxProcessStartMarker(owner.pid);
    return currentMarker === undefined || currentMarker === owner.processStartMarker;
  }
  return true;
}

export class JsonFileStateStore<T> implements StateStore<T> {
  readonly stateFile: string;
  readonly lockFile: string;
  readonly reclaimFile: string;
  readonly backupFile: string;
  private readonly initialState: () => T;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly maxStateFileBytes: number;
  private readonly clock: Clock;
  private readonly monotonicClock: Clock;
  private readonly queueKey: string;
  private readonly faultHooks: NonNullable<JsonFileStateStoreOptions<T>["faultHooks"]>;
  private cleanupPending = true;

  constructor(options: JsonFileStateStoreOptions<T>) {
    this.stateFile = options.stateFile;
    this.lockFile = `${options.stateFile}.lock`;
    this.reclaimFile = `${options.stateFile}.lock.reclaim`;
    this.backupFile = `${options.stateFile}.bak`;
    this.initialState = options.initialState;
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.staleLockMs = options.staleLockMs;
    this.maxStateFileBytes = options.maxStateFileBytes ?? DEFAULT_MAX_STATE_FILE_BYTES;
    this.clock = options.clock ?? systemClock;
    this.monotonicClock = options.monotonicClock ?? monotonicSystemClock;
    this.queueKey = canonicalStateFile(options.stateFile);
    this.faultHooks = options.faultHooks ?? {};
  }

  async read(): Promise<T> {
    // Atomic replacement means a reader sees either the previous complete file
    // or the next complete file. The local queue only waits for this process's
    // preceding mutation; it does not create or modify the cross-process lock.
    return inProcessFifo(this.queueKey, async () => this.readUnlocked(1));
  }

  async transact<R>(
    mutator: (state: T) => R | Promise<R>,
    options: { signal?: AbortSignal } = {},
  ): Promise<R> {
    // Only the head of the process-local FIFO polls the cross-process lock. This
    // prevents dozens of local requests from forming a polling convoy.
    return inProcessFifo(this.queueKey, async () =>
      this.withCrossProcessLock(async () => {
        const state = await this.readUnlocked();
        const before = JSON.stringify(state);
        const result = await mutator(state);
        const after = JSON.stringify(state);
        if (after !== before) await this.writeUnlocked(state);
        return result;
      }, options.signal),
      options.signal,
    );
  }

  private async readUnlocked(identityRetries = 0): Promise<T> {
    try {
      return await this.readOnce();
    } catch (error) {
      if (error instanceof StateIdentityChangedError) {
        if (identityRetries > 0) return this.readUnlocked(identityRetries - 1);
        throw new StateSecurityError(this.stateFile, "file identity changed while it was being validated.");
      }
      throw error;
    }
  }

  private async readOnce(): Promise<T> {
    let inspected;
    try {
      inspected = await lstat(this.stateFile, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return this.initialState();
      throw error;
    }
    if (this.faultHooks.afterStateInspected) await this.faultHooks.afterStateInspected();
    if (!inspected.isFile()) {
      throw new StateSecurityError(this.stateFile, "path is not a regular file and was not read.");
    }

    const flags =
      process.platform === "win32"
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    let handle: FileHandle;
    try {
      handle = await open(this.stateFile, flags);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENOENT")) {
        throw new StateSecurityError(this.stateFile, "path changed while it was being validated.");
      }
      throw error;
    }

    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.dev !== inspected.dev || metadata.ino !== inspected.ino) {
        throw new StateIdentityChangedError();
      }
      if (process.platform !== "win32") {
        const effectiveUid = process.geteuid?.() ?? process.getuid?.();
        if (effectiveUid === undefined || Number(metadata.uid) !== effectiveUid) {
          throw new StateSecurityError(this.stateFile, "file is not owned by the effective user.");
        }
        if ((Number(metadata.mode) & 0o022) !== 0) {
          throw new StateSecurityError(this.stateFile, "file is writable by group or other users.");
        }
      }
      if (metadata.size > BigInt(this.maxStateFileBytes)) {
        throw new StateFileTooLargeError(this.stateFile, this.maxStateFileBytes);
      }
      const contents = await handle.readFile();
      if (contents.byteLength > this.maxStateFileBytes) {
        throw new StateFileTooLargeError(this.stateFile, this.maxStateFileBytes);
      }
      if (!isUtf8(contents)) {
        throw new StateCorruptionError(this.stateFile, "file is not valid UTF-8 and was not overwritten.");
      }
      try {
        return JSON.parse(contents.toString("utf8")) as T;
      } catch {
        // Do not return initialState: that could re-enable disabled credentials,
        // and the next transaction could then overwrite the forensic evidence.
        throw new StateCorruptionError(this.stateFile, "file contains malformed JSON and was not overwritten.");
      }
    } finally {
      await handle.close();
    }
  }

  private async performRetriedFilesystemOperation<R>(
    operationName: RetriedFilesystemOperation,
    operation: () => Promise<R>,
    context: WindowsRetryContext = DEFAULT_WINDOWS_RETRY_CONTEXT,
  ): Promise<R> {
    return retryWindowsTransientFilesystemError(async () => {
      await this.faultHooks.beforeFilesystemOperation?.(operationName);
      return operation();
    }, context);
  }

  /** Unique artifacts never participate in lock ownership or committed-state selection. */
  private async cleanupUniqueArtifact(
    path: string,
    operationName:
      | "state-temp-unlink"
      | "backup-temp-unlink"
      | "lock-candidate-unlink"
      | "abandoned-artifact-unlink",
    context: WindowsRetryContext = DEFAULT_WINDOWS_RETRY_CONTEXT,
  ): Promise<void> {
    try {
      await this.performRetriedFilesystemOperation(operationName, async () => unlink(path), context);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      if (
        isWindowsTransientFilesystemError(error) ||
        operationName === "lock-candidate-unlink" ||
        operationName === "abandoned-artifact-unlink"
      ) {
        // A later store instance removes stale best-effort artifacts.
        return;
      }
      throw error;
    }
  }

  private async writeUnlocked(state: T): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const nonce = `${process.pid}.${crypto.randomUUID()}`;
    const temporaryFile = `${this.stateFile}.${nonce}.tmp`;
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(contents, "utf8") > this.maxStateFileBytes) {
      throw new StateFileTooLargeError(this.stateFile, this.maxStateFileBytes);
    }

    let temporaryCreated = false;
    try {
      const temporaryHandle = await open(temporaryFile, "wx", 0o600);
      temporaryCreated = true;
      try {
        await temporaryHandle.writeFile(contents, "utf8");
        await temporaryHandle.sync();
        await this.faultHooks.afterStateCandidateSynced?.();
      } finally {
        await temporaryHandle.close();
      }

      await this.preserveBackup(nonce);
      // Node's rename uses replacement semantics for files on supported
      // platforms. Never unlink the destination first: doing so creates a gap
      // where a crash loses the state file and readers reset to initial state.
      await this.performRetriedFilesystemOperation("state-rename", async () =>
        rename(temporaryFile, this.stateFile),
      );
      await this.syncParentDirectory();
    } finally {
      if (temporaryCreated) {
        await this.cleanupUniqueArtifact(temporaryFile, "state-temp-unlink");
      }
    }
  }

  private async preserveBackup(nonce: string): Promise<void> {
    const backupTemporary = `${this.backupFile}.${nonce}.tmp`;
    let linked = false;
    try {
      try {
        // State versions are immutable after rename. A hard link therefore
        // checkpoints the previous complete inode without copying or fsyncing
        // the full JSON again on every selection and outcome.
        await this.performRetriedFilesystemOperation("backup-link", async () =>
          link(this.stateFile, backupTemporary),
        );
        linked = true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return;
        throw error;
      }
      try {
        await this.performRetriedFilesystemOperation("backup-rename", async () =>
          rename(backupTemporary, this.backupFile),
        );
        linked = false;
      } catch (error) {
        // Keep the prior known-good backup if safe replacement remains refused.
        // Windows sharing errors have already received a short bounded retry.
        if (
          !isNodeError(error) ||
          (error.code !== "EEXIST" &&
            error.code !== "EPERM" &&
            !(process.platform === "win32" &&
              (error.code === "EBUSY" || error.code === "EACCES")))
        ) {
          throw error;
        }
      }
    } finally {
      if (linked) {
        await this.cleanupUniqueArtifact(backupTemporary, "backup-temp-unlink");
      }
    }
  }

  private async syncParentDirectory(): Promise<void> {
    let directoryHandle: FileHandle;
    try {
      directoryHandle = await open(dirname(this.stateFile), "r");
    } catch (error) {
      if (isNodeError(error) && (error.code === "EISDIR" || error.code === "EPERM" || error.code === "EACCES")) {
        return;
      }
      throw error;
    }
    try {
      await directoryHandle.sync();
    } catch (error) {
      // Directory fsync is not implemented on every Windows filesystem.
      if (!isNodeError(error) || (error.code !== "EINVAL" && error.code !== "EPERM" && error.code !== "EISDIR")) {
        throw error;
      }
    } finally {
      await directoryHandle.close();
    }
  }

  private async waitForSafeAcquisition(
    owner: LockOwner,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const context: WindowsRetryContext = {
      signal,
      deadline,
      now: () => this.monotonicClock.now(),
    };
    while (true) {
      if (signal?.aborted) throw stateAbortError();
      let remaining = deadline - this.monotonicClock.now();
      if (remaining <= 0) throw new StateLockTimeoutError(this.lockFile, this.lockTimeoutMs);

      // A fixed claim can outlive the old lock it protected. It is never
      // deleted by a different invocation because pathname unlink has no CAS.
      const claim = await this.observePath(this.reclaimFile, context);
      if (signal?.aborted) throw stateAbortError();
      remaining = deadline - this.monotonicClock.now();
      if (!claim) {
        if (remaining <= 0) throw new StateLockTimeoutError(this.lockFile, this.lockTimeoutMs);
        const current = await this.observeLock(context);
        if (signal?.aborted) throw stateAbortError();
        if (current?.metadata?.nonce !== owner.nonce) {
          throw new StateSecurityError(this.stateFile, "lock ownership changed before mutation.");
        }
        if (this.monotonicClock.now() >= deadline) {
          throw new StateLockTimeoutError(this.lockFile, this.lockTimeoutMs);
        }
        return;
      }
      if (remaining <= 0) throw new StateLockTimeoutError(this.lockFile, this.lockTimeoutMs);
      await sleep(Math.min(remaining, 15 + Math.floor(Math.random() * 20)), signal);
    }
  }

  private async withCrossProcessLock<R>(
    operation: () => Promise<R>,
    signal?: AbortSignal,
  ): Promise<R> {
    if (signal?.aborted) throw stateAbortError();
    await mkdir(dirname(this.lockFile), { recursive: true });
    const acquired = await this.acquireLock(signal);
    const heartbeatEveryMs = Math.max(100, Math.floor(this.staleLockMs / 3));
    const heartbeat = setInterval(() => {
      void this.refreshOwnedLock(acquired.handle).catch(() => {
        // Ownership is rechecked before touching the path. A failed heartbeat is
        // not proof that the transaction has lost its lock.
      });
    }, heartbeatEveryMs);
    heartbeat.unref();

    let operationFailed = false;
    try {
      // Publication or its cleanup can finish after the acquisition deadline.
      // A concurrent stale reaper can also still own the fixed claim briefly
      // after this lock is published. Resolve both conditions before mutation.
      if (signal?.aborted) throw stateAbortError();
      await this.waitForSafeAcquisition(acquired.owner, acquired.deadline, signal);
      if (this.cleanupPending) {
        this.cleanupPending = false;
        await this.cleanupAbandonedArtifacts();
      }
      if (signal?.aborted) throw stateAbortError();
      return await operation();
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      clearInterval(heartbeat);
      let closeFailed = false;
      let closeError: unknown;
      try {
        await acquired.handle.close();
      } catch (error) {
        closeFailed = true;
        closeError = error;
      }
      try {
        await this.releaseOwnedLock(acquired.owner);
      } catch (releaseError) {
        // A release failure is actionable after success, but must not hide the
        // transaction's primary failure or a post-acquisition cancellation.
        if (!operationFailed) throw releaseError;
      }
      if (!operationFailed && closeFailed) throw closeError;
    }
  }

  private async lockCandidateIsAbandoned(path: string, expectedNonce: string): Promise<boolean> {
    const flags =
      process.platform === "win32"
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    let handle: FileHandle;
    try {
      handle = await open(path, flags);
    } catch {
      return false;
    }

    try {
      const stats = await handle.stat();
      const effectiveUid = process.geteuid?.() ?? process.getuid?.();
      if (
        !stats.isFile() ||
        stats.size > 4_096 ||
        this.clock.now() - stats.mtimeMs <= this.staleLockMs ||
        (process.platform !== "win32" &&
          (effectiveUid === undefined || stats.uid !== effectiveUid || (stats.mode & 0o022) !== 0))
      ) {
        return false;
      }

      const contents = await handle.readFile();
      if (contents.byteLength > 4_096 || !isUtf8(contents)) return false;
      const owner = parseLockOwner(contents.toString("utf8"));
      // A candidate is created before lock ownership, so other waiters can see
      // it. Age alone is not abandonment: coverage, scheduling, or a slow sync
      // can keep a live creator here longer than staleLockMs.
      return owner?.nonce === expectedNonce && !processIsAlive(owner);
    } finally {
      await handle.close();
    }
  }

  private async cleanupAbandonedArtifacts(): Promise<void> {
    const directory = dirname(this.stateFile);
    const stateName = basename(this.stateFile).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const temporaryArtifactPattern = new RegExp(
      `^${stateName}(?:\\.bak)?\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`,
      "u",
    );
    const lockCandidatePattern = new RegExp(
      `^${stateName}\\.lock\\.([0-9a-f-]{36})\\.candidate$`,
      "u",
    );
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    let inspected = 0;
    for (const entry of entries) {
      const candidateMatch = lockCandidatePattern.exec(entry.name);
      if (
        inspected >= 64 ||
        (!candidateMatch && !temporaryArtifactPattern.test(entry.name))
      ) {
        continue;
      }
      inspected += 1;
      const path = resolve(directory, entry.name);
      try {
        if (candidateMatch) {
          const candidateNonce = candidateMatch[1];
          if (
            !candidateNonce ||
            !(await this.lockCandidateIsAbandoned(path, candidateNonce))
          ) {
            continue;
          }
        } else {
          // State and backup temporaries are only created while holding the
          // fixed lock, so no other correct writer can still be using them.
          const metadata = await lstat(path);
          const effectiveUid = process.geteuid?.() ?? process.getuid?.();
          if (
            !metadata.isFile() ||
            this.clock.now() - metadata.mtimeMs <= this.staleLockMs ||
            (process.platform !== "win32" &&
              (effectiveUid === undefined || metadata.uid !== effectiveUid))
          ) {
            continue;
          }
        }
        await this.cleanupUniqueArtifact(path, "abandoned-artifact-unlink");
      } catch {
        // Cleanup is bounded and best-effort. The lock/state protocol does not
        // depend on removing abandoned uniquely named artifacts.
      }
    }
  }

  private async acquireLock(signal?: AbortSignal): Promise<AcquiredLock> {
    const deadline = this.monotonicClock.now() + this.lockTimeoutMs;
    const retryContext: WindowsRetryContext = {
      signal,
      deadline,
      now: () => this.monotonicClock.now(),
    };

    while (true) {
      if (signal?.aborted) throw stateAbortError();
      const existingClaim = await this.observePath(this.reclaimFile, retryContext);
      if (signal?.aborted) throw stateAbortError();
      if (existingClaim) {
        // Never publish a new owner behind a fixed claim left by a crashed
        // reaper. Only that claim's creator may remove it safely.
        const remaining = deadline - this.monotonicClock.now();
        if (remaining <= 0) throw new StateLockTimeoutError(this.lockFile, this.lockTimeoutMs);
        await sleep(Math.min(remaining, 15 + Math.floor(Math.random() * 20)), signal);
        continue;
      }
      const owner: LockOwner = {
        version: 1,
        nonce: crypto.randomUUID(),
        pid: process.pid,
        acquiredAt: this.clock.now(),
        ...(PROCESS_START_MARKER === undefined ? {} : { processStartMarker: PROCESS_START_MARKER }),
      };
      const candidateFile = `${this.lockFile}.${owner.nonce}.candidate`;
      const handle = await open(candidateFile, "wx", 0o600);
      let published = false;
      try {
        // The fixed lock path is never visible in an empty or partially written
        // state. A hard link publishes this fully synced inode atomically and
        // fails rather than replacing an existing owner.
        await handle.writeFile(`${JSON.stringify(owner)}
`, "utf8");
        await handle.sync();
        await this.faultHooks.afterLockCandidateSynced?.();
        try {
          await this.performRetriedFilesystemOperation(
            "lock-publish-link",
            async () => link(candidateFile, this.lockFile),
            retryContext,
          );
          published = true;
        } catch (error) {
          if (isNodeError(error) && error.code === "EEXIST") {
            await handle.close();
            await this.cleanupUniqueArtifact(candidateFile, "lock-candidate-unlink", retryContext);
            await this.removeStaleLock(retryContext);
            const remaining = deadline - this.monotonicClock.now();
            if (remaining <= 0) throw new StateLockTimeoutError(this.lockFile, this.lockTimeoutMs);
            await sleep(Math.min(remaining, 15 + Math.floor(Math.random() * 20)), signal);
            continue;
          }
          if (isDefinitiveHardLinkUnsupportedError(error)) {
            throw new Error(
              `The filesystem does not support atomic hard-link locks for state file: ${this.stateFile}`,
              { cause: error },
            );
          }
          throw error;
        }

        // The open handle remains attached to the published inode for safe
        // heartbeat updates. Candidate cleanup cannot affect lock ownership.
        await this.cleanupUniqueArtifact(candidateFile, "lock-candidate-unlink", retryContext);
        return { handle, owner, deadline };
      } catch (error) {
        if (!published) {
          await handle.close().catch(() => undefined);
          await this.cleanupUniqueArtifact(candidateFile, "lock-candidate-unlink", retryContext);
        }
        throw error;
      }
    }
  }

  private async observePath(
    path: string,
    context: WindowsRetryContext = DEFAULT_WINDOWS_RETRY_CONTEXT,
    retryTransientOpen = true,
  ): Promise<LockObservation | null> {
    const flags =
      process.platform === "win32"
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    const openPath = async () => {
      await this.faultHooks.beforeFilesystemOperation?.("lock-observe-open");
      return open(path, flags);
    };
    let handle: FileHandle;
    try {
      handle = retryTransientOpen
        ? await retryWindowsTransientFilesystemError(openPath, context)
        : await openPath();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new StateSecurityError(this.stateFile, "lock path is a symbolic link.");
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > 4_096) {
        throw new StateSecurityError(this.stateFile, "lock metadata is not a small regular file.");
      }
      if (process.platform !== "win32") {
        const effectiveUid = process.geteuid?.() ?? process.getuid?.();
        if (effectiveUid === undefined || stats.uid !== effectiveUid || (stats.mode & 0o022) !== 0) {
          throw new StateSecurityError(this.stateFile, "lock metadata has unsafe ownership or permissions.");
        }
      }
      const text = await handle.readFile({ encoding: "utf8" });
      return { metadata: parseLockOwner(text), text, stats };
    } finally {
      await handle.close();
    }
  }

  private async observeLock(
    context: WindowsRetryContext = DEFAULT_WINDOWS_RETRY_CONTEXT,
  ): Promise<LockObservation | null> {
    return this.observePath(this.lockFile, context);
  }

  /**
   * Remove only the fixed claim published by this invocation. Correct peers
   * never delete a pre-existing claim, so they cannot replace this pathname
   * between its identity check and unlink.
   */
  private async unlinkCreatedReclaim(
    expected: LockObservation,
    context: WindowsRetryContext,
  ): Promise<"removed" | "changed"> {
    return retryWindowsTransientFilesystemError(async () => {
      const current = await this.observePath(this.reclaimFile, context, false);
      if (!current) return "removed";
      if (!sameLockIdentity(expected, current)) return "changed";
      await this.faultHooks.beforeFilesystemOperation?.("reclaim-unlink");
      try {
        await unlink(this.reclaimFile);
        return "removed";
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return "removed";
        throw error;
      }
    }, context);
  }

  private async removeObservedReclaim(
    expected: LockObservation,
    context: WindowsRetryContext,
  ): Promise<void> {
    // Once a claim exists, cancellation must not skip its cleanup. The existing
    // acquisition deadline still bounds any Windows transient retry.
    const cleanupContext: WindowsRetryContext = { ...context, signal: undefined };
    await this.unlinkCreatedReclaim(expected, cleanupContext);
  }

  /** Retry fixed-lock deletion only while the validated hard-link claim remains. */
  private async unlinkClaimedLock(
    expected: LockObservation,
    claim: LockObservation,
    context: WindowsRetryContext,
  ): Promise<"removed" | "changed"> {
    return retryWindowsTransientFilesystemError(async () => {
      const currentClaim = await this.observePath(this.reclaimFile, context, false);
      const currentLock = await this.observePath(this.lockFile, context, false);
      if (
        !currentClaim ||
        !currentLock ||
        !sameLockIdentity(claim, currentClaim) ||
        !sameLockIdentity(expected, currentLock) ||
        !sameLockIdentity(currentClaim, currentLock)
      ) {
        return "changed";
      }

      await this.faultHooks.beforeFilesystemOperation?.("lock-unlink");
      try {
        await unlink(this.lockFile);
        return "removed";
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return "changed";
        throw error;
      }
    }, context);
  }

  /**
   * Compare-and-unlink using a fixed hard-link claim. Only one reaper can hold
   * the claim. Once held, no other package process can replace `lockFile`
   * between the identity check and unlink.
   */
  private async unlinkObservedLock(
    expected: LockObservation,
    context: WindowsRetryContext = DEFAULT_WINDOWS_RETRY_CONTEXT,
  ): Promise<UnlinkObservedLockResult> {
    let claimedObservation: LockObservation | null = null;
    let bodyFailed = false;
    try {
      try {
        await this.performRetriedFilesystemOperation(
          "lock-claim-link",
          async () => link(this.lockFile, this.reclaimFile),
          context,
        );
      } catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EEXIST")) {
          // A pre-existing fixed claim is never deleted automatically. There is
          // no portable pathname compare-and-unlink primitive in Node, so only
          // its creator may remove it; a crashed claimant requires recovery.
          return { status: "changed" };
        }
        if (isDefinitiveHardLinkUnsupportedError(error)) {
          return { status: "unsupported", error };
        }
        throw error;
      }

      const claim = await this.observePath(this.reclaimFile, context);
      // Successful publication proves this invocation created the fixed path;
      // correct peers never replace it. Remember it for creator-only cleanup
      // even if the source lock changed before or after the link operation.
      if (claim) claimedObservation = claim;
      const current = await this.observeLock(context);
      if (
        !claimedObservation ||
        !current ||
        !sameLockIdentity(expected, claimedObservation) ||
        !sameLockIdentity(claimedObservation, current)
      ) {
        return { status: "changed" };
      }

      await this.faultHooks.afterStaleClaimValidated?.();
      return { status: await this.unlinkClaimedLock(expected, claimedObservation, context) };
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      if (claimedObservation) {
        try {
          await this.removeObservedReclaim(claimedObservation, context);
        } catch (cleanupError) {
          // Preserve the fixed-lock failure when both destructive operations fail.
          if (!bodyFailed) throw cleanupError;
        }
      }
    }
  }

  private async removeStaleLock(
    context: WindowsRetryContext = DEFAULT_WINDOWS_RETRY_CONTEXT,
  ): Promise<void> {
    const observed = await this.observeLock(context);
    if (!observed) return;
    if (this.clock.now() - observed.stats.mtimeMs <= this.staleLockMs) return;
    // Atomic publication always produces valid metadata. Malformed contents are
    // corruption or interference, not proof of a dead owner, so recovery is manual.
    if (!observed.metadata || processIsAlive(observed.metadata)) return;

    // A second path observation is not a compare-and-delete: another reaper can
    // still replace the lock before unlink. The hard-link claim above closes
    // that final race. Unsupported filesystems fail closed.
    await this.unlinkObservedLock(observed, context);
  }

  private async refreshOwnedLock(handle: FileHandle): Promise<void> {
    const now = new Date(this.clock.now());
    // Updating the acquired inode through its handle can never refresh a newer
    // owner's replacement path.
    await handle.utimes(now, now);
  }

  private async releaseOwnedLock(owner: LockOwner): Promise<void> {
    const deadline = this.monotonicClock.now() + this.lockTimeoutMs;
    const context: WindowsRetryContext = {
      signal: undefined,
      deadline,
      now: () => this.monotonicClock.now(),
    };
    while (true) {
      const observed = await this.observeLock(context);
      if (observed?.metadata?.nonce !== owner.nonce) return;
      const result = await this.unlinkObservedLock(observed, context);
      if (result.status === "removed") return;
      if (result.status === "unsupported") {
        // Acquisition already proved hard-link support in this directory. Never
        // weaken release to an unclaimed path unlink if a later claim is unsupported.
        throw new Error(
          `The filesystem cannot create the hard-link claim required to safely release state lock: ${this.lockFile}`,
          { cause: result.error },
        );
      }

      // A claim created by an overlapping stale observer can briefly block this
      // owner. Do not report release success while our fixed lock still exists.
      const remaining = deadline - this.monotonicClock.now();
      if (remaining <= 0) throw new StateLockReleaseError(this.lockFile, this.lockTimeoutMs);
      await sleep(Math.min(remaining, 15 + Math.floor(Math.random() * 20)));
    }
  }

}

export class InMemoryStateStore<T> implements StateStore<T> {
  private state: T;
  private queue: Promise<void> = Promise.resolve();

  constructor(initialState: T) {
    this.state = structuredClone(initialState);
  }

  async read(): Promise<T> {
    await this.queue;
    return structuredClone(this.state);
  }

  async transact<R>(mutator: (state: T) => R | Promise<R>): Promise<R> {
    let resolveTurn: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolvePromise) => {
      resolveTurn = resolvePromise;
    });

    await previous;
    try {
      const working = structuredClone(this.state);
      const result = await mutator(working);
      this.state = working;
      return result;
    } finally {
      resolveTurn?.();
    }
  }
}
