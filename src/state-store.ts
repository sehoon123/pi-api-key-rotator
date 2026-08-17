import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { Clock } from "./types.ts";

export interface StateStore<T> {
  read(): Promise<T>;
  transact<R>(mutator: (state: T) => R | Promise<R>): Promise<R>;
}

export interface JsonFileStateStoreOptions<T> {
  stateFile: string;
  initialState: () => T;
  lockTimeoutMs: number;
  staleLockMs: number;
  clock?: Clock;
}

export class StateLockTimeoutError extends Error {
  constructor(lockFile: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms while waiting for state lock: ${lockFile}`);
    this.name = "StateLockTimeoutError";
  }
}

const systemClock: Clock = { now: () => Date.now() };

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class JsonFileStateStore<T> implements StateStore<T> {
  readonly stateFile: string;
  readonly lockFile: string;
  private readonly initialState: () => T;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly clock: Clock;

  constructor(options: JsonFileStateStoreOptions<T>) {
    this.stateFile = options.stateFile;
    this.lockFile = `${options.stateFile}.lock`;
    this.initialState = options.initialState;
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.staleLockMs = options.staleLockMs;
    this.clock = options.clock ?? systemClock;
  }

  async read(): Promise<T> {
    return this.withLock(async () => this.readUnlocked());
  }

  async transact<R>(mutator: (state: T) => R | Promise<R>): Promise<R> {
    return this.withLock(async () => {
      const state = await this.readUnlocked();
      const result = await mutator(state);
      await this.writeUnlocked(state);
      return result;
    });
  }

  private async readUnlocked(): Promise<T> {
    try {
      const text = await readFile(this.stateFile, "utf8");
      return JSON.parse(text) as T;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return this.initialState();
      if (error instanceof SyntaxError) return this.initialState();
      throw error;
    }
  }

  private async writeUnlocked(state: T): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const contents = `${JSON.stringify(state, null, 2)}\n`;

    await writeFile(temporaryFile, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(temporaryFile, this.stateFile);
    } catch (error) {
      if (isNodeError(error) && (error.code === "EEXIST" || error.code === "EPERM")) {
        await unlink(this.stateFile).catch((unlinkError: unknown) => {
          if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") throw unlinkError;
        });
        await rename(temporaryFile, this.stateFile);
      } else {
        throw error;
      }
    } finally {
      await unlink(temporaryFile).catch((unlinkError: unknown) => {
        if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }

  private async withLock<R>(operation: () => Promise<R>): Promise<R> {
    await mkdir(dirname(this.lockFile), { recursive: true });
    const startedAt = this.clock.now();
    let handle: FileHandle;

    while (true) {
      try {
        handle = await open(this.lockFile, "wx", 0o600);
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;

        await this.removeStaleLock();
        if (this.clock.now() - startedAt >= this.lockTimeoutMs) {
          throw new StateLockTimeoutError(this.lockFile, this.lockTimeoutMs);
        }
        await sleep(15 + Math.floor(Math.random() * 20));
      }
    }

    try {
      await handle.writeFile(`${process.pid} ${this.clock.now()}\n`, "utf8");
      return await operation();
    } finally {
      await handle.close();
      await unlink(this.lockFile).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const metadata = await stat(this.lockFile);
      if (this.clock.now() - metadata.mtimeMs <= this.staleLockMs) return;
      await unlink(this.lockFile);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
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
