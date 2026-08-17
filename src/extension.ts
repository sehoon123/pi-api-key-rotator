import type { KeyPool } from "./key-pool.ts";
import { createRotatingStream } from "./rotating-stream.ts";
import type {
  EventStreamFactory,
  ExtensionApiLike,
  ExtensionContextLike,
  ModelLike,
  PoolSnapshot,
  RotatorConfig,
  StreamSimpleLike,
} from "./types.ts";

const STATUS_KEY = "pi-api-key-rotator";

export interface RegisterExtensionDependencies {
  config: RotatorConfig;
  pool: KeyPool;
  baseStreamSimple: StreamSimpleLike;
  createEventStream: EventStreamFactory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractModel(event: unknown): ModelLike | undefined {
  if (!isRecord(event) || !isRecord(event.model)) return undefined;
  const model = event.model;
  if (typeof model.api !== "string" || typeof model.provider !== "string" || typeof model.id !== "string") {
    return undefined;
  }
  return model as unknown as ModelLike;
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

export function compactStatus(snapshot: PoolSnapshot, now = Date.now()): string {
  const current = snapshot.keys.find((key) => key.id === snapshot.currentKeyId);
  if (!current) return "keys: unavailable";
  if (current.disabled) return `keys: ${current.id} disabled`;
  if (current.cooldownUntil > now) return `keys: ${current.id} cooldown ${duration(current.cooldownUntil - now)}`;
  return `keys: ${current.id} ${snapshot.requestsOnCurrent}/${snapshot.requestsPerKey}`;
}

export function formatStatus(snapshot: PoolSnapshot, provider: string, now = Date.now()): string {
  const lines = [
    `Provider: ${provider}`,
    `Current: ${snapshot.currentKeyId} (${snapshot.requestsOnCurrent}/${snapshot.requestsPerKey})`,
    `Total HTTP attempts: ${snapshot.totalAttempts}`,
    "",
  ];

  for (const key of snapshot.keys) {
    let state = key.available ? "ready" : "unavailable";
    if (key.disabled) state = "disabled (use /key-rotator reset after fixing the key)";
    else if (key.cooldownUntil > now) state = `cooldown ${duration(key.cooldownUntil - now)}`;
    const marker = key.current ? "*" : " ";
    lines.push(
      `${marker} ${key.id}: ${state}; attempts=${key.attempts}, successes=${key.successes}, failures=${key.failures}`,
    );
  }
  return lines.join("\n");
}

export function registerKeyRotatorExtension(
  pi: ExtensionApiLike,
  dependencies: RegisterExtensionDependencies,
): void {
  const { config, pool } = dependencies;
  let activeUi: ExtensionContextLike["ui"] | undefined;

  const refreshStatus = async (snapshot?: PoolSnapshot): Promise<void> => {
    if (!activeUi) return;
    const resolved = snapshot ?? (await pool.snapshot());
    activeUi.setStatus(STATUS_KEY, compactStatus(resolved));
  };

  const rotatingStream = createRotatingStream({
    config,
    pool,
    baseStreamSimple: dependencies.baseStreamSimple,
    createEventStream: dependencies.createEventStream,
    onStateChange: refreshStatus,
  });

  // A fallback API key reference keeps Pi's provider authentication check
  // satisfied. Every actual request is overridden by the rotating stream.
  pi.registerProvider(config.provider, {
    api: config.api,
    apiKey: `$${config.keys[0]?.env ?? ""}`,
    streamSimple: rotatingStream,
  });

  pi.registerCommand("key-rotator", {
    description: "Show, advance, or reset the API key rotation pool",
    handler: async (args, ctx) => {
      activeUi = ctx.ui;
      const action = args.trim().toLowerCase() || "status";

      if (action === "status") {
        const snapshot = await pool.snapshot();
        ctx.ui.notify(formatStatus(snapshot, config.provider), "info");
        await refreshStatus(snapshot);
        return;
      }
      if (action === "next") {
        const snapshot = await pool.advance();
        ctx.ui.notify(`Advanced to ${snapshot.currentKeyId}.`, "info");
        await refreshStatus(snapshot);
        return;
      }
      if (action === "reset") {
        const snapshot = await pool.reset();
        ctx.ui.notify("All disabled/cooldown states and counters were reset.", "warning");
        await refreshStatus(snapshot);
        return;
      }

      ctx.ui.notify("Usage: /key-rotator [status|next|reset]", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeUi = ctx.ui;
    await refreshStatus();
  });

  pi.on("model_select", async (event, ctx) => {
    activeUi = ctx.ui;
    const model = extractModel(event);
    if (model?.provider === config.provider && model.api !== config.api) {
      ctx.ui.notify(
        `Key rotator is configured for API "${config.api}", but the selected model uses "${model.api}". ` +
          "Update key-rotator.json so the API values match.",
        "error",
      );
    }
    await refreshStatus();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    activeUi = undefined;
  });
}
