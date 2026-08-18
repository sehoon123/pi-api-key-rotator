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

/**
 * Pi provider config values treat a leading `!` as a command and `$NAME` as
 * environment interpolation. Escape those metacharacters when a literal key
 * must be used as the provider's fallback authentication value.
 */
export function escapePiConfigLiteral(value: string): string {
  const escapedDollars = value.replaceAll("$", () => "$$");
  return escapedDollars.startsWith("!") ? `$${escapedDollars}` : escapedDollars;
}

export function fallbackApiKey(key: ResolvedKeyDefinition): string {
  // v0.1 programmatic configs did not carry `source`; an env name therefore
  // remains sufficient unless the explicit v0.2 source says the key is literal.
  if (key.env && key.env !== "<literal>" && key.source !== "literal") return `$${key.env}`;
  return escapePiConfigLiteral(key.value);
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
    ...targets.map((target) => `  - ${target.provider} (${target.api})`),
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

  const targets = configuredTargets(config);
  const poolId = configuredPoolId(config);
  const providerFallback = fallbackApiKey(firstKey);
  for (const target of targets) {
    // Every target receives the same stream and KeyPool instance. Therefore
    // attempts, rotation thresholds, cooldowns, and disabled keys are shared
    // across all configured provider/API pairs.
    pi.registerProvider(target.provider, {
      api: target.api,
      apiKey: providerFallback,
      streamSimple: rotatingStream,
    });
  }

  const targetsByProvider = new Map(targets.map((target) => [target.provider, target] as const));

  pi.registerCommand("key-rotator", {
    description: "Show, advance, or reset the shared API key rotation pool",
    handler: async (args, ctx) => {
      activeUi = ctx.ui;
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
    ctx.ui.setStatus(STATUS_KEY, undefined);
    activeUi = undefined;
  });
}
