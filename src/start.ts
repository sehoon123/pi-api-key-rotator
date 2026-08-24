/**
 * Host-free extension orchestration. `index.ts` owns Pi's static imports and
 * injects the two public stream functions here, so startup can be tested with
 * local fakes and without making provider requests.
 */
import { loadConfigSet } from "./config-set.ts";
import { ConfigNotFoundError } from "./config.ts";
import { buildDoctorReport } from "./doctor.ts";
import { STATUS_KEY } from "./extension.ts";
import { createInitialPoolState, KeyPool } from "./key-pool.ts";
import { registerMultiPoolKeyRotatorExtension } from "./multi-pool-extension.ts";
import type { PoolRuntime } from "./multi-pool-extension.ts";
import { JsonFileStateStore } from "./state-store.ts";
import type {
  EventStreamFactory,
  ExtensionApiLike,
  PoolState,
  StreamSimpleLike,
} from "./types.ts";

export const LOG_PREFIX = "[pi-api-key-rotator]";

export interface StartOptions {
  /** Pi's builtin compatibility stream, statically imported by `index.ts`. */
  baseStreamSimple: StreamSimpleLike;
  /** Pi's public assistant-message event-stream factory. */
  createEventStream: EventStreamFactory;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Diagnostic sink. Defaults to console.warn. */
  warn?: (message: string) => void;
}

export type StartResult = "active" | "disabled";

/** Register the `/key-rotator` command that only explains why nothing rotates. */
export function registerDisabledCommand(pi: ExtensionApiLike, message: string, warn: (m: string) => void): void {
  warn(message);
  pi.registerCommand("key-rotator", {
    description: "Explain why the API key rotator is disabled",
    handler: async (_args, ctx) => {
      ctx.ui.notify(message, "error");
    },
  });
  pi.on("session_start", (_event, ctx) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, "keys: disabled");
    } catch {
      // Disabled mode must remain usable when footer rendering fails.
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Session shutdown must not fail because the footer renderer failed.
    }
  });
}

/**
 * Start the extension using only injected host functions. Configuration or
 * registration failures end in an explaining disabled mode instead of escaping.
 */
export async function startKeyRotator(pi: ExtensionApiLike, options: StartOptions): Promise<StartResult> {
  const warn = options.warn ?? ((message: string) => console.warn(`${LOG_PREFIX} ${message}`));
  const pathEnv = {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  };

  if (typeof options.baseStreamSimple !== "function" || typeof options.createEventStream !== "function") {
    registerDisabledCommand(pi, "Extension is disabled because this Pi version does not expose the required stream APIs.", warn);
    return "disabled";
  }

  let configSet;
  try {
    configSet = await loadConfigSet({ ...pathEnv, warn });
  } catch (error) {
    const message =
      error instanceof ConfigNotFoundError
        ? `Configuration is missing at ${error.configFile}. Copy an example config there, add at least one pool with two API keys, and run /reload.`
        : `Extension is disabled because configuration loading failed: ${error instanceof Error ? error.message : String(error)}`;
    registerDisabledCommand(pi, message, warn);
    return "disabled";
  }

  let pools: PoolRuntime[];
  try {
    pools = configSet.pools.map((config) => {
      const store = new JsonFileStateStore<PoolState>({
        stateFile: config.stateFile,
        initialState: () => createInitialPoolState(config, Date.now()),
        lockTimeoutMs: config.lockTimeoutMs,
        staleLockMs: config.staleLockMs,
        ...(config.maxStateFileBytes === undefined ? {} : { maxStateFileBytes: config.maxStateFileBytes }),
      });
      return { config, pool: new KeyPool(config, store) };
    });
  } catch (error) {
    registerDisabledCommand(
      pi,
      `Extension is disabled because state initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      warn,
    );
    return "disabled";
  }

  let registeredTargets = new Map<string, string>();
  try {
    await registerMultiPoolKeyRotatorExtension(pi, {
      pools,
      baseStreamSimple: options.baseStreamSimple,
      createEventStream: options.createEventStream,
      doctor: async () =>
        buildDoctorReport({
          configFile: configSet.configFile,
          pools: configSet.pools,
          registeredTargets,
          stateReaders: new Map(
            pools.map((runtime) => [
              runtime.config.poolId ?? runtime.config.provider,
              () => runtime.pool.snapshot(),
            ]),
          ),
        }),
      onRegistered: (registered) => {
        registeredTargets = new Map(registered);
      },
    });
  } catch (error) {
    registerDisabledCommand(
      pi,
      `Extension is disabled because registration failed: ${error instanceof Error ? error.message : String(error)}`,
      warn,
    );
    return "disabled";
  }

  return "active";
}
