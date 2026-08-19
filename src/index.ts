import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigNotFoundError } from "./config.ts";
import { loadConfigSet } from "./config-set.ts";
import type { RotatorConfigSet } from "./config-set.ts";
import { registerMultiPoolKeyRotatorExtension } from "./multi-pool-extension.ts";
import { createInitialPoolState, KeyPool } from "./key-pool.ts";
import { JsonFileStateStore } from "./state-store.ts";
import type {
  EventStreamFactory,
  ExtensionApiLike,
  PoolState,
  StreamSimpleLike,
} from "./types.ts";

function registerDisabledCommand(pi: ExtensionAPI, message: string): void {
  console.warn(`[pi-api-key-rotator] ${message}`);
  pi.registerCommand("key-rotator", {
    description: "Explain why the API key rotator is disabled",
    handler: async (_args, ctx) => {
      ctx.ui.notify(message, "error");
    },
  });
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("pi-api-key-rotator", "keys: disabled");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("pi-api-key-rotator", undefined);
  });
}

export default async function apiKeyRotatorExtension(pi: ExtensionAPI): Promise<void> {
  let configSet: RotatorConfigSet;
  try {
    configSet = await loadConfigSet();
  } catch (error) {
    const message =
      error instanceof ConfigNotFoundError
        ? `Configuration is missing at ${error.configFile}. Copy an example config there, add at least one pool with two API keys, and run /reload.`
        : `Extension is disabled because configuration loading failed: ${error instanceof Error ? error.message : String(error)}`;
    registerDisabledCommand(pi, message);
    return;
  }

  const pools = configSet.pools.map((config) => {
    const store = new JsonFileStateStore<PoolState>({
      stateFile: config.stateFile,
      initialState: () => createInitialPoolState(config, Date.now()),
      lockTimeoutMs: config.lockTimeoutMs,
      staleLockMs: config.staleLockMs,
    });
    return { config, pool: new KeyPool(config, store) };
  });

  registerMultiPoolKeyRotatorExtension(pi as unknown as ExtensionApiLike, {
    pools,
    baseStreamSimple: streamSimple as unknown as StreamSimpleLike,
    createEventStream: createAssistantMessageEventStream as unknown as EventStreamFactory,
  });
}
