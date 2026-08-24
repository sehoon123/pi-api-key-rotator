import type { KeyPool } from "./key-pool.ts";
import { createRotatingStream } from "./rotating-stream.ts";
import type {
  EventStreamFactory,
  ExtensionApiLike,
  ExtensionContextLike,
  ModelLike,
  PoolSnapshot,
  ResolvedKeyDefinition,
  RotatorConfig,
  StreamSimpleLike,
} from "./types.ts";

export const STATUS_KEY = "pi-api-key-rotator";

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

/**
 * Non-secret stand-in for the provider fallback `apiKey`. Pi requires a
 * non-empty value before calling `streamSimple`; the rotating stream replaces
 * this marker with the selected real key for each provider attempt.
 */
export const MANAGED_KEY_PLACEHOLDER = "rotator-managed-key";

/** Compatibility helper. Configured literals are never provider fallbacks. */
export function escapePiConfigLiteral(_value: string): string {
  return MANAGED_KEY_PLACEHOLDER;
}

/** Compatibility alias for callers shared with the Prime package. */
export function sanitizeProviderLiteral(_value: string): string {
  return MANAGED_KEY_PLACEHOLDER;
}

/** The provider registry always receives an inert, non-empty marker. */
export function fallbackApiKey(_key: ResolvedKeyDefinition): string {
  return MANAGED_KEY_PLACEHOLDER;
}

function configuredTargets(config: Pick<RotatorConfig, "provider" | "api" | "targets">) {
  return config.targets?.length
    ? config.targets
    : [{ provider: config.provider, api: config.api }];
}

function configuredPoolId(config: Pick<RotatorConfig, "provider" | "poolId">): string {
  return config.poolId ?? config.provider;
}

export function compactStatus(snapshot: PoolSnapshot, now = Date.now()): string {
  const current = snapshot.keys.find((key) => key.id === snapshot.currentKeyId);
  if (!current) return "keys: unavailable";
  if (current.disabled) return `keys: ${current.id} disabled`;
  if (current.cooldownUntil > now) return `keys: ${current.id} cooldown ${duration(current.cooldownUntil - now)}`;
  return `keys: ${current.id} ${snapshot.requestsOnCurrent}/${snapshot.requestsPerKey}`;
}

export function formatStatus(
  snapshot: PoolSnapshot,
  configOrProvider: string | Pick<RotatorConfig, "provider" | "api" | "poolId" | "targets">,
  now = Date.now(),
): string {
  const poolId = typeof configOrProvider === "string" ? configOrProvider : configuredPoolId(configOrProvider);
  const targets =
    typeof configOrProvider === "string"
      ? [{ provider: configOrProvider, api: "configured adapter" }]
      : configuredTargets(configOrProvider);
  const lines = [
    `Pool: ${poolId}`,
    "Targets:",
    ...targets.map((target) => {
      const health = snapshot.targets.find((entry) => entry.id === target.provider);
      const state =
        health && health.cooldownUntil > now
          ? `circuit open ${duration(health.cooldownUntil - now)}`
          : "ready";
      return `  - ${target.provider} (${target.api}): ${state}; transient failures=${health?.failures ?? 0}`;
    }),
    ...(snapshot.poolCooldownUntil > now
      ? [`Pool cooldown: ${duration(snapshot.poolCooldownUntil - now)}`]
      : []),
    `Current: ${snapshot.currentKeyId} (${snapshot.requestsOnCurrent}/${snapshot.requestsPerKey})`,
    `Total provider attempts: ${snapshot.totalAttempts}`,
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
  const firstKey = config.keys[0];
  if (!firstKey) throw new Error("Key rotator requires at least one resolved API key.");

  let activeUi: ExtensionContextLike["ui"] | undefined;

  const refreshStatus = async (snapshot?: PoolSnapshot): Promise<void> => {
    if (!activeUi) return;
    try {
      const resolved = snapshot ?? (await pool.snapshot());
      activeUi.setStatus(STATUS_KEY, compactStatus(resolved));
    } catch {
      try {
        activeUi.setStatus(STATUS_KEY, "keys: state unavailable");
      } catch {
        // Footer rendering must never fail a session or command.
      }
    }
  };

  const rotatingStream = createRotatingStream({
    config,
    pool,
    baseStreamSimple: dependencies.baseStreamSimple,
    createEventStream: dependencies.createEventStream,
    onStateChange: refreshStatus,
  });

  const targets = configuredTargets(config);
  const poolId = configuredPoolId(config);
  const providerFallback = fallbackApiKey(firstKey);
  for (const target of targets) {
    // Pi stores stream handlers per provider. Each registration therefore gets
    // a target-specific guard. A mismatched provider or API passes through and
    // cannot consume this pool's keys or counters.
    const guardedStream = ((model, context, options) =>
      model.provider === target.provider && model.api === target.api
        ? rotatingStream(model, context, options)
        : dependencies.baseStreamSimple(model, context, options)) as StreamSimpleLike;
    pi.registerProvider(target.provider, {
      api: target.api,
      apiKey: providerFallback,
      streamSimple: guardedStream,
    });
  }

  const targetsByProvider = new Map(targets.map((target) => [target.provider, target] as const));

  pi.registerCommand("key-rotator", {
    description: "Show, advance, or reset the shared API key rotation pool",
    handler: async (args, ctx) => {
      activeUi = ctx.ui;
      try {
        const action = args.trim().toLowerCase() || "status";

        if (action === "status") {
          const snapshot = await pool.snapshot();
          ctx.ui.notify(formatStatus(snapshot, config), "info");
          await refreshStatus(snapshot);
          return;
        }
        if (action === "next") {
          const snapshot = await pool.advance();
          ctx.ui.notify(`Advanced pool "${poolId}" to ${snapshot.currentKeyId}.`, "info");
          await refreshStatus(snapshot);
          return;
        }
        if (action === "reset") {
          const snapshot = await pool.reset();
          ctx.ui.notify(
            `Reset counters, cooldowns, and disabled states for pool "${poolId}".`,
            "warning",
          );
          await refreshStatus(snapshot);
          return;
        }

        ctx.ui.notify("Usage: /key-rotator [status|next|reset]", "warning");
      } catch {
        ctx.ui.notify("Key-rotator state operation failed. Inspect the state file before retrying.", "error");
        await refreshStatus();
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeUi = ctx.ui;
    await refreshStatus();
  });

  pi.on("model_select", async (event, ctx) => {
    activeUi = ctx.ui;
    const model = extractModel(event);
    const target = model ? targetsByProvider.get(model.provider) : undefined;
    if (model && target && model.api !== target.api) {
      ctx.ui.notify(
        `Key rotator target "${target.provider}" expects API "${target.api}", ` +
          `but the selected model uses "${model.api}". Update key-rotator.json or models.json so the API values match.`,
        "error",
      );
    }
    await refreshStatus();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Session shutdown must not fail because the footer renderer failed.
    }
    activeUi = undefined;
  });
}
