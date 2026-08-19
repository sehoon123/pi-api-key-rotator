import { compactStatus, fallbackApiKey, formatStatus } from "./extension.ts";
import type { KeyPool } from "./key-pool.ts";
import { createRotatingStream } from "./rotating-stream.ts";
import type {
  EventStreamFactory,
  ExtensionApiLike,
  ExtensionContextLike,
  ModelLike,
  PoolSnapshot,
  RotatorConfig,
  RotatorTarget,
  StreamSimpleLike,
} from "./types.ts";

const STATUS_KEY = "pi-api-key-rotator";

export interface PoolRuntime {
  config: RotatorConfig;
  pool: KeyPool;
}

export interface RegisterMultiPoolDependencies {
  pools: PoolRuntime[];
  baseStreamSimple: StreamSimpleLike;
  createEventStream: EventStreamFactory;
}

interface RegisteredPool extends PoolRuntime {
  id: string;
  targets: RotatorTarget[];
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

function poolId(config: RotatorConfig): string {
  return config.poolId ?? config.provider;
}

function targets(config: RotatorConfig): RotatorTarget[] {
  return config.targets?.length ? config.targets : [{ provider: config.provider, api: config.api }];
}

function validateRegistrationPlan(runtimes: PoolRuntime[]): RegisteredPool[] {
  if (runtimes.length === 0) throw new Error("Key rotator requires at least one configured pool.");

  const ids = new Set<string>();
  const providers = new Map<string, string>();
  return runtimes.map((runtime) => {
    const id = poolId(runtime.config);
    const canonicalId = id.toLocaleLowerCase("en-US");
    if (ids.has(canonicalId)) throw new Error(`Duplicate key-rotator pool ID: ${id}`);
    ids.add(canonicalId);

    if (!runtime.config.keys[0]) throw new Error(`Key rotator pool "${id}" has no resolved API keys.`);
    const resolvedTargets = targets(runtime.config);
    if (resolvedTargets.length === 0) throw new Error(`Key rotator pool "${id}" has no provider targets.`);

    const localProviders = new Set<string>();
    for (const target of resolvedTargets) {
      if (localProviders.has(target.provider)) {
        throw new Error(`Provider "${target.provider}" appears more than once in pool "${id}".`);
      }
      localProviders.add(target.provider);
      const previousPool = providers.get(target.provider);
      if (previousPool) {
        throw new Error(
          `Provider "${target.provider}" belongs to both pool "${previousPool}" and pool "${id}".`,
        );
      }
      providers.set(target.provider, id);
    }
    return { ...runtime, id, targets: resolvedTargets };
  });
}

function concisePoolStatus(id: string, snapshot: PoolSnapshot): string {
  return `${id}: ${compactStatus(snapshot).replace(/^keys:\s*/, "")}`;
}

function usage(): string {
  return [
    "Usage:",
    "  /key-rotator status [poolId]",
    "  /key-rotator list",
    "  /key-rotator next <poolId|all>",
    "  /key-rotator reset <poolId|all>",
  ].join("\n");
}

/** Register one independent rotating stream and stateful KeyPool per pool. */
export function registerMultiPoolKeyRotatorExtension(
  pi: ExtensionApiLike,
  dependencies: RegisterMultiPoolDependencies,
): void {
  // Validate the whole plan before registering anything. This avoids a partially
  // active extension when a later pool contains an overlapping provider.
  const pools = validateRegistrationPlan(dependencies.pools);
  const byId = new Map(pools.map((runtime) => [runtime.id.toLocaleLowerCase("en-US"), runtime] as const));
  const byProvider = new Map<string, RegisteredPool>();
  let activeUi: ExtensionContextLike["ui"] | undefined;
  let activePoolId: string | undefined = pools.length === 1 ? pools[0]?.id : undefined;

  const findPool = (id: string): RegisteredPool | undefined => byId.get(id.toLocaleLowerCase("en-US"));

  const refreshFooter = async (): Promise<void> => {
    if (!activeUi) return;
    const active = activePoolId ? findPool(activePoolId) : undefined;
    if (active) {
      activeUi.setStatus(STATUS_KEY, concisePoolStatus(active.id, await active.pool.snapshot()));
      return;
    }
    activeUi.setStatus(STATUS_KEY, `${pools.length} independent key pools`);
  };

  for (const runtime of pools) {
    const firstKey = runtime.config.keys[0];
    if (!firstKey) throw new Error(`Key rotator pool "${runtime.id}" has no resolved API keys.`);

    const rotatingStream = createRotatingStream({
      config: runtime.config,
      pool: runtime.pool,
      baseStreamSimple: dependencies.baseStreamSimple,
      createEventStream: dependencies.createEventStream,
      onStateChange: async () => {
        if (activePoolId === runtime.id || (pools.length === 1 && !activePoolId)) await refreshFooter();
      },
    });

    const providerFallback = fallbackApiKey(firstKey);
    for (const target of runtime.targets) {
      byProvider.set(target.provider, runtime);
      pi.registerProvider(target.provider, {
        api: target.api,
        apiKey: providerFallback,
        streamSimple: rotatingStream,
      });
    }
  }

  const notifyAllStatuses = async (ctx: ExtensionContextLike): Promise<void> => {
    const rendered = await Promise.all(
      pools.map(async (runtime) => formatStatus(await runtime.pool.snapshot(), runtime.config)),
    );
    ctx.ui.notify(rendered.join("\n\n"), "info");
  };

  const resolveCommandPools = (
    rawSelector: string | undefined,
    allowAll: boolean,
    ctx: ExtensionContextLike,
  ): RegisteredPool[] | undefined => {
    const selector = rawSelector?.trim();
    if (selector?.toLowerCase() === "all") {
      if (allowAll) return pools;
      ctx.ui.notify('"all" is not valid for this command.', "warning");
      return undefined;
    }
    if (selector) {
      const selected = findPool(selector);
      if (selected) return [selected];
      ctx.ui.notify(`Unknown key pool "${selector}".\n${usage()}`, "warning");
      return undefined;
    }
    const active = activePoolId ? findPool(activePoolId) : undefined;
    if (active) return [active];
    if (pools.length === 1 && pools[0]) return [pools[0]];
    ctx.ui.notify("Multiple independent pools are configured; specify a poolId or use all.\n" + usage(), "warning");
    return undefined;
  };

  pi.registerCommand("key-rotator", {
    description: "Inspect, advance, or reset independent API key rotation pools",
    handler: async (args, ctx) => {
      activeUi = ctx.ui;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "status";
      const selector = tokens[1];
      if (tokens.length > 2) {
        ctx.ui.notify(usage(), "warning");
        return;
      }

      if (action === "list") {
        const summaries = await Promise.all(
          pools.map(async (runtime) => concisePoolStatus(runtime.id, await runtime.pool.snapshot())),
        );
        ctx.ui.notify(summaries.join("\n"), "info");
        await refreshFooter();
        return;
      }

      if (action === "status") {
        if (!selector) {
          await notifyAllStatuses(ctx);
        } else {
          const selected = resolveCommandPools(selector, false, ctx);
          if (!selected) return;
          const runtime = selected[0];
          if (!runtime) return;
          ctx.ui.notify(formatStatus(await runtime.pool.snapshot(), runtime.config), "info");
          activePoolId = runtime.id;
        }
        await refreshFooter();
        return;
      }

      if (action === "next" || action === "reset") {
        const selected = resolveCommandPools(selector, true, ctx);
        if (!selected) return;
        for (const runtime of selected) {
          const snapshot = action === "next" ? await runtime.pool.advance() : await runtime.pool.reset();
          ctx.ui.notify(
            action === "next"
              ? `Advanced pool "${runtime.id}" to ${snapshot.currentKeyId}.`
              : `Reset counters, cooldowns, and disabled states for pool "${runtime.id}".`,
            action === "next" ? "info" : "warning",
          );
        }
        if (selected.length === 1 && selected[0]) activePoolId = selected[0].id;
        await refreshFooter();
        return;
      }

      ctx.ui.notify(usage(), "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeUi = ctx.ui;
    if (ctx.model) activePoolId = byProvider.get(ctx.model.provider)?.id ?? activePoolId;
    await refreshFooter();
  });

  pi.on("model_select", async (event, ctx) => {
    activeUi = ctx.ui;
    const model = extractModel(event);
    const runtime = model ? byProvider.get(model.provider) : undefined;
    if (runtime && model) {
      activePoolId = runtime.id;
      const target = runtime.targets.find((candidate) => candidate.provider === model.provider);
      if (target && model.api !== target.api) {
        ctx.ui.notify(
          `Key pool "${runtime.id}" expects provider "${target.provider}" to use API "${target.api}", ` +
            `but the selected model uses "${model.api}". Update key-rotator.json or models.json.`,
          "error",
        );
      }
    }
    await refreshFooter();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    activeUi = undefined;
  });
}
