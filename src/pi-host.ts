/**
 * Pi-specific path handling plus host-independent config-file inspection and
 * command-backed secret loading. Keep provider/stream integration out of this file.
 */
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Config path override understood by this extension. */
export const CONFIG_PATH_ENV = "PI_KEY_ROTATOR_CONFIG";
export const AGENT_DIR_SEGMENTS = [".pi", "agent"] as const;
export const CONFIG_FILE_NAME = "key-rotator.json";
export const stateFileName = (poolId: string): string => `key-rotator-${poolId}.state.json`;

/** Path template used in messages and as the documented default. */
export const DEFAULT_CONFIG_FILE_TEMPLATE = join("~", ...AGENT_DIR_SEGMENTS, CONFIG_FILE_NAME);

export interface PathEnvironment {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
}

export function expandHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homeDir, input.slice(2));
  return input;
}

/** Pi's default coding-agent directory is `<home>/.pi/agent`. */
export function resolveAgentDir(options: PathEnvironment = {}): string {
  return join(options.homeDir ?? homedir(), ...AGENT_DIR_SEGMENTS);
}

export function defaultConfigFile(options: PathEnvironment = {}): string {
  return join(resolveAgentDir(options), CONFIG_FILE_NAME);
}

export function defaultStateFile(poolId: string, options: PathEnvironment = {}): string {
  return join(resolveAgentDir(options), stateFileName(poolId));
}

export interface ConfigPathSelection {
  path: string;
  origin: "explicit" | "env" | "default";
  warning?: string;
}

/** explicit option -> PI_KEY_ROTATOR_CONFIG -> ~/.pi/agent/key-rotator.json. */
export function selectConfigPath(options: PathEnvironment & { configFile?: string } = {}): ConfigPathSelection {
  const env = options.env ?? process.env;
  if (options.configFile) return { path: options.configFile, origin: "explicit" };
  const configured = env[CONFIG_PATH_ENV]?.trim();
  if (configured) return { path: configured, origin: "env" };
  return { path: defaultConfigFile(options), origin: "default" };
}

export type ConfigFileRefusal = "not-regular" | "wrong-owner" | "writable-by-others";

export interface ConfigFileInspection {
  size: number;
  dev: bigint;
  ino: bigint;
  uid?: number;
  mode?: number;
  warning?: string;
  refusal?: ConfigFileRefusal;
}

/**
 * Inspect config metadata without reading its contents. On POSIX, callers must
 * refuse every `refusal` before parsing the file or starting a key command.
 */
export async function inspectConfigFile(configFile: string): Promise<ConfigFileInspection> {
  const info = await lstat(configFile, { bigint: true });
  const metadata = {
    size: Number(info.size),
    dev: info.dev,
    ino: info.ino,
    uid: Number(info.uid),
  };
  if (!info.isFile()) return { ...metadata, refusal: "not-regular" };
  if (process.platform === "win32") return metadata;

  const mode = Number(info.mode & 0o777n);
  const currentUid = process.geteuid?.() ?? process.getuid?.();
  if (currentUid === undefined || Number(info.uid) !== currentUid) {
    return { ...metadata, mode, refusal: "wrong-owner" };
  }
  if ((mode & 0o022) !== 0) {
    return { ...metadata, mode, refusal: "writable-by-others" };
  }
  if ((mode & 0o044) !== 0) {
    return {
      ...metadata,
      mode,
      warning:
        `${configFile} is readable by other users (mode ${mode.toString(8).padStart(3, "0")}). ` +
        "Run chmod 600 on the file.",
    };
  }
  return { ...metadata, mode };
}

/** Warning-only compatibility helper for diagnostics and tests. */
export async function checkConfigPermissions(configFile: string): Promise<string | undefined> {
  try {
    return (await inspectConfigFile(configFile)).warning;
  } catch {
    return undefined;
  }
}

export const MAX_SECRET_UTF8_BYTES = 128 * 1024;
export const MAX_COMMAND_STDOUT_BYTES = MAX_SECRET_UTF8_BYTES + 1024;

export interface CommandResult {
  stdout: string;
  code: number | null;
  timedOut: boolean;
  /** True when the byte cap was reached. The stdout value is only the capped prefix. */
  outputLimitExceeded?: boolean;
}

export interface CommandRunnerOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type CommandRunner = (command: string, options: CommandRunnerOptions) => Promise<CommandResult>;

function commandAbortError(): Error {
  const error = new Error("Command execution was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Run a command-backed key source once. stderr is never piped because a
 * failing secret tool can echo the secret. POSIX commands run in their own
 * process group so timeout/cancellation can terminate descendants best-effort.
 */
export const runShellCommand: CommandRunner = async (command, options) => {
  const { spawn } = await import("node:child_process");
  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted) {
      rejectPromise(commandAbortError());
      return;
    }

    const child =
      process.platform === "win32"
        ? spawn(command, {
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          })
        : spawn("/bin/sh", ["-c", command], {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const stdout = (): string => Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");

    const killTree = (): void => {
      if (process.platform === "win32") {
        if (child.pid !== undefined) {
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            killer.on("error", () => {
              child.kill("SIGKILL");
            });
            killer.on("close", (code) => {
              if (code !== 0) child.kill("SIGKILL");
            });
            killer.unref();
            return;
          } catch {
            // Direct termination below is the best fallback available here.
          }
        }
        child.kill("SIGKILL");
        return;
      }

      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The shell may have exited while a descendant still owns stdout.
        }
      }
      child.kill("SIGKILL");
    };

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.unref();
    };

    const resolveResult = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    const rejectResult = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };

    function onAbort(): void {
      if (settled) return;
      killTree();
      rejectResult(commandAbortError());
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_COMMAND_STDOUT_BYTES - stdoutBytes;
      if (bytes.length <= remaining) {
        if (bytes.length > 0) {
          stdoutChunks.push(bytes);
          stdoutBytes += bytes.length;
        }
        return;
      }

      if (remaining > 0) {
        stdoutChunks.push(bytes.subarray(0, remaining));
        stdoutBytes += remaining;
      }
      killTree();
      resolveResult({ stdout: stdout(), code: null, timedOut: false, outputLimitExceeded: true });
    });

    child.on("error", (error) => {
      rejectResult(error);
    });
    child.on("close", (code) => {
      resolveResult({ stdout: stdout(), code, timedOut: false });
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      if (settled) return;
      killTree();
      resolveResult({ stdout: stdout(), code: null, timedOut: true });
    }, Math.max(1, options.timeoutMs));
    if (options.signal?.aborted) onAbort();
  });
};
