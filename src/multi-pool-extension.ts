import { compactStatus, fallbackApiKey, formatStatus, STATUS_KEY } from "./extension.ts";
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

export interface PoolRuntime {
  config: RotatorConfig;
  pool: KeyPool;
}

export interface RegisterMultiPoolDependencies {
  pools: PoolRuntime[];
  baseStreamSimple: StreamSimpleLike;
  createEventStream: EventStreamFactory;
  /** Called after every direct Pi provider registration succeeds. */
  onRegistered?: (targets: ReadonlyMap<string, string>) => void;
  /** Local-only operational report. It must not make provider requests. */
  doctor?: () => Promise<{ text: string; severity: "OK" | "WARN" | "FAIL" }>;
}

interface RegisteredPool extends PoolRuntime {
  id: string;
  targets: RotatorTarget[];
}

interface EnabledPool extends RegisteredPool {
  mode: "enabled";
}

interface DisabledPool extends RegisteredPool {
  mode: "disabled";
  /** Sanitized startup failure retained for local status output. */
  failure: string;
}

type PreparedPool = EnabledPool | DisabledPool;

type InactiveReason =
  | { kind: "no-model" }
  | { kind: "unmanaged"; provider: string }
  | {
      kind: "api-mismatch";
      poolId: string;
      provider: string;
      configuredApi: string;
      selectedApi: string;
    }
  | { kind: "pool-disabled"; poolId: string };

type SelectionState =
  | { kind: "active"; runtime: EnabledPool; target: RotatorTarget }
  | { kind: "inactive"; reason: InactiveReason };

interface UiOwner {
  generation: number;
  ui: ExtensionContextLike["ui"];
}

interface OwnerToken {
  owner: UiOwner;
  selectionGeneration: number;
}

interface FooterSnapshot {
  poolId: string;
  snapshot: PoolSnapshot;
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

function sanitizedStateFailure(error: unknown): string {
  // The evidence is the untouched state file, not exception text. A custom
  // StateStore can throw arbitrary or encoded credentials, so retain only a
  // fixed diagnostic class and never forward error.message.
  const name = error instanceof Error ? error.name : "";
  if (name === "StateFileTooLargeError") return "state file exceeds its configured size limit";
  if (name === "StateSecurityError") return "state file failed security validation";
  if (name === "StateCorruptionError") return "state file failed structural validation";
  return "state validation failed";
}

async function preflightPools(pools: RegisteredPool[]): Promise<PreparedPool[]> {
  return Promise.all(
    pools.map(async (runtime): Promise<PreparedPool> => {
      try {
        // snapshot() is deliberately read-only: a rejected preflight must leave
        // the original file and all forensic evidence untouched.
        await runtime.pool.snapshot();
        return { ...runtime, mode: "enabled" };
      } catch (error) {
        return {
          ...runtime,
          mode: "disabled",
          failure: sanitizedStateFailure(error),
        };
      }
    }),
  );
}

function isEnabled(runtime: PreparedPool): runtime is EnabledPool {
  return runtime.mode === "enabled";
}

function concisePoolStatus(id: string, snapshot: PoolSnapshot): string {
  return `${id}: ${compactStatus(snapshot).replace(/^keys:\s*/, "")}`;
}

function disabledPoolStatus(runtime: DisabledPool): string {
  return [
    `Pool: ${runtime.id}`,
    "Rotation: disabled",
    "Reason: state preflight failed; the state file was not changed so evidence is preserved.",
    `State error: ${runtime.failure}`,
  ].join("\n");
}

function conciseDisabledPoolStatus(runtime: DisabledPool): string {
  return `${runtime.id}: disabled (state preflight failed; evidence preserved)`;
}

function inactiveFooter(reason: InactiveReason): string {
  switch (reason.kind) {
    case "no-model":
      return "rotation inactive: no model selected";
    case "unmanaged":
      return `rotation inactive: provider "${reason.provider}" is unmanaged`;
    case "api-mismatch":
      return (
        `rotation inactive: API mismatch for provider "${reason.provider}" ` +
        `(selected "${reason.selectedApi}", configured "${reason.configuredApi}")`
      );
    case "pool-disabled":
      return `rotation inactive: pool "${reason.poolId}" is disabled after state preflight failure`;
  }
}

function inactiveCommandReason(reason: InactiveReason): string {
  switch (reason.kind) {
    case "no-model":
      return "no model is selected";
    case "unmanaged":
      return `provider "${reason.provider}" is unmanaged`;
    case "api-mismatch":
      return (
        `provider "${reason.provider}" uses API "${reason.selectedApi}" instead of ` +
        `configured API "${reason.configuredApi}"`
      );
    case "pool-disabled":
      return `pool "${reason.poolId}" is disabled because state preflight failed`;
  }
}

function usage(): string {
  return [
    "Usage:",
    "  /key-rotator status [poolId]",
    "  /key-rotator list",
    "  /key-rotator doctor",
    "  /key-rotator next <poolId|all>",
    "  /key-rotator reset <poolId|all>",
  ].join("\n");
}

/** Register one independent rotating stream and stateful KeyPool per healthy pool. */
export async function registerMultiPoolKeyRotatorExtension(
  pi: ExtensionApiLike,
  dependencies: RegisterMultiPoolDependencies,
): Promise<void> {
  // Validate the whole plan before any asynchronous work or registration. This
  // avoids a partially active extension for an overlapping provider plan.
  const plannedPools = validateRegistrationPlan(dependencies.pools);
  // Every pool gets an independent read-only preflight. A bad state disables
  // only that pool; healthy pools still register their direct Pi providers.
  const pools = await preflightPools(plannedPools);
  const enabledPools = pools.filter(isEnabled);
  const byId = new Map(pools.map((runtime) => [runtime.id.toLocaleLowerCase("en-US"), runtime] as const));
  const byProvider = new Map<string, PreparedPool>();
  for (const runtime of pools) {
    for (const target of runtime.targets) byProvider.set(target.provider, runtime);
  }

  let ownerGeneration = 0;
  let activeOwner: UiOwner | undefined;
  let selectionGeneration = 0;
  let selection: SelectionState = { kind: "inactive", reason: { kind: "no-model" } };
  let footerSequence = 0;
  let queuedFooter:
    | { runtime: EnabledPool; snapshot: PoolSnapshot; token: OwnerToken }
    | undefined;
  let footerQueued = false;

  const findPool = (id: string): PreparedPool | undefined => byId.get(id.toLocaleLowerCase("en-US"));

  const beginOwner = (ui: ExtensionContextLike["ui"]): UiOwner => {
    ownerGeneration += 1;
    const owner = { generation: ownerGeneration, ui };
    activeOwner = owner;
    return owner;
  };

  const setSelection = (next: SelectionState): void => {
    selectionGeneration += 1;
    selection = next;
  };

  const selectionForModel = (model: ModelLike | undefined): SelectionState => {
    if (!model) return { kind: "inactive", reason: { kind: "no-model" } };
    const runtime = byProvider.get(model.provider);
    if (!runtime) {
      return { kind: "inactive", reason: { kind: "unmanaged", provider: model.provider } };
    }
    const target = runtime.targets.find((candidate) => candidate.provider === model.provider);
    if (!target) {
      return { kind: "inactive", reason: { kind: "unmanaged", provider: model.provider } };
    }
    if (model.api !== target.api) {
      return {
        kind: "inactive",
        reason: {
          kind: "api-mismatch",
          poolId: runtime.id,
          provider: model.provider,
          configuredApi: target.api,
          selectedApi: model.api,
        },
      };
    }
    if (!isEnabled(runtime)) {
      return { kind: "inactive", reason: { kind: "pool-disabled", poolId: runtime.id } };
    }
    return { kind: "active", runtime, target };
  };

  const captureOwner = (): OwnerToken | undefined =>
    activeOwner ? { owner: activeOwner, selectionGeneration } : undefined;

  const stillOwns = (token: OwnerToken): boolean =>
    activeOwner === token.owner && selectionGeneration === token.selectionGeneration;

  const adoptCommandContext = (ctx: ExtensionContextLike): OwnerToken => {
    if (!activeOwner || activeOwner.ui !== ctx.ui) {
      beginOwner(ctx.ui);
      setSelection(selectionForModel(ctx.model));
    }
    // beginOwner above or an existing active owner makes this non-null.
    return captureOwner() as OwnerToken;
  };

  const commitFooter = (token: OwnerToken, sequence: number, text: string): void => {
    if (!stillOwns(token) || sequence !== footerSequence) return;
    try {
      token.owner.ui.setStatus(STATUS_KEY, text);
    } catch {
      // Footer rendering must never fail a session, command, or request.
    }
  };

  const refreshFooter = async (
    provided?: FooterSnapshot,
    token = captureOwner(),
    reservedSequence?: number,
  ): Promise<void> => {
    if (!token) return;
    const sequence = reservedSequence ?? ++footerSequence;
    const selected = selection;
    if (selected.kind === "inactive") {
      commitFooter(token, sequence, inactiveFooter(selected.reason));
      return;
    }

    try {
      const snapshot =
        provided?.poolId === selected.runtime.id
          ? provided.snapshot
          : await selected.runtime.pool.snapshot();
      // The await above can cross a session, UI, or model change. Both owner
      // generations and the monotonic footer sequence fence the result.
      if (!stillOwns(token)) return;
      commitFooter(token, sequence, concisePoolStatus(selected.runtime.id, snapshot));
    } catch {
      if (!stillOwns(token)) return;
      commitFooter(token, sequence, `${selected.runtime.id}: state unavailable`);
    }
  };

  const queueFooter = (runtime: EnabledPool, snapshot: PoolSnapshot, token: OwnerToken): void => {
    if (!stillOwns(token)) return;
    queuedFooter = { runtime, snapshot, token };
    if (footerQueued) return;
    footerQueued = true;
    queueMicrotask(() => {
      footerQueued = false;
      const pending = queuedFooter;
      queuedFooter = undefined;
      if (!pending || !stillOwns(pending.token)) return;
      const selected = selection;
      if (selected.kind !== "active" || selected.runtime !== pending.runtime) return;
      // Coalesce callbacks in callback order. refreshFooter's sequence fence
      // prevents an older awaited read from overwriting this newer snapshot.
      void refreshFooter(
        { poolId: pending.runtime.id, snapshot: pending.snapshot },
        pending.token,
      );
    });
  };

  const registeredTargets = new Map<string, string>();
  for (const runtime of enabledPools) {
    const firstKey = runtime.config.keys[0];
    if (!firstKey) throw new Error(`Key rotator pool "${runtime.id}" has no resolved API keys.`);
    const providerFallback = fallbackApiKey(firstKey);

    for (const target of runtime.targets) {
      // Pi keeps streamSimple per provider. Retain direct target-specific
      // registrations and pass the original Pi model through unchanged.
      const guardedStream = ((model, context, options) => {
        if (model.provider !== target.provider || model.api !== target.api) {
          return dependencies.baseStreamSimple(model, context, options);
        }

        const selected = selection;
        const requestOwner =
          selected.kind === "active" &&
          selected.runtime === runtime &&
          selected.target.provider === target.provider &&
          selected.target.api === target.api
            ? captureOwner()
            : undefined;
        // A per-request callback closes over the selection/session owner that
        // launched it. A late provider outcome can never paint a later model.
        const rotatingStream = createRotatingStream({
          config: runtime.config,
          pool: runtime.pool,
          baseStreamSimple: dependencies.baseStreamSimple,
          createEventStream: dependencies.createEventStream,
          ...(requestOwner
            ? { onStateChange: (snapshot: PoolSnapshot) => queueFooter(runtime, snapshot, requestOwner) }
            : {}),
        });
        return rotatingStream(model, context, options);
      }) as StreamSimpleLike;

      pi.registerProvider(target.provider, {
        api: target.api,
        apiKey: providerFallback,
        streamSimple: guardedStream,
      });
      registeredTargets.set(target.provider, target.api);
    }
  }
  dependencies.onRegistered?.(new Map(registeredTargets));

  type PoolRead =
    | { runtime: PreparedPool; text: string }
    | { runtime: EnabledPool; text: string; snapshot: PoolSnapshot };

  const hasSnapshot = (
    entry: PoolRead,
  ): entry is { runtime: EnabledPool; text: string; snapshot: PoolSnapshot } =>
    "snapshot" in entry;

  const readConciseStatus = async (runtime: PreparedPool): Promise<PoolRead> => {
    if (!isEnabled(runtime)) return { runtime, text: conciseDisabledPoolStatus(runtime) };
    try {
      const snapshot = await runtime.pool.snapshot();
      return { runtime, snapshot, text: concisePoolStatus(runtime.id, snapshot) };
    } catch (error) {
      return {
        runtime,
        text: `${runtime.id}: state unavailable (${sanitizedStateFailure(error)})`,
      };
    }
  };

  const readDetailedStatus = async (runtime: PreparedPool): Promise<PoolRead> => {
    if (!isEnabled(runtime)) return { runtime, text: disabledPoolStatus(runtime) };
    try {
      const snapshot = await runtime.pool.snapshot();
      return { runtime, snapshot, text: formatStatus(snapshot, runtime.config) };
    } catch (error) {
      return {
        runtime,
        text: [
          `Pool: ${runtime.id}`,
          "Rotation state: unavailable",
          `State error: ${sanitizedStateFailure(error)}`,
        ].join("\n"),
      };
    }
  };

  const notifyAllStatuses = async (
    token: OwnerToken,
  ): Promise<Map<string, PoolSnapshot> | undefined> => {
    const entries = await Promise.all(pools.map(readDetailedStatus));
    if (!stillOwns(token)) return undefined;
    token.owner.ui.notify(entries.map((entry) => entry.text).join("\n\n"), "info");
    return new Map(
      entries.flatMap((entry) =>
        "snapshot" in entry ? [[entry.runtime.id, entry.snapshot] as const] : [],
      ),
    );
  };

  const resolveCommandPools = (
    rawSelector: string | undefined,
    allowAll: boolean,
    token: OwnerToken,
  ): EnabledPool[] | undefined => {
    const selector = rawSelector?.trim();
    if (selector?.toLowerCase() === "all") {
      if (!allowAll) {
        token.owner.ui.notify('"all" is not valid for this command.', "warning");
        return undefined;
      }
      const disabled = pools.filter((runtime): runtime is DisabledPool => !isEnabled(runtime));
      if (disabled.length > 0) {
        token.owner.ui.notify(
          `Skipped disabled pool${disabled.length === 1 ? "" : "s"} ${disabled.map((runtime) => `"${runtime.id}"`).join(", ")}; state evidence remains unchanged.`,
          "warning",
        );
      }
      if (enabledPools.length > 0) return enabledPools;
      token.owner.ui.notify("No healthy key pools are available for this command.", "warning");
      return undefined;
    }
    if (selector) {
      const selected = findPool(selector);
      if (!selected) {
        token.owner.ui.notify(`Unknown key pool "${selector}".\n${usage()}`, "warning");
        return undefined;
      }
      if (!isEnabled(selected)) {
        token.owner.ui.notify(
          `Pool "${selected.id}" is disabled because state preflight failed. Its state evidence was not changed.`,
          "warning",
        );
        return undefined;
      }
      return [selected];
    }

    const selected = selection;
    if (selected.kind === "active") return [selected.runtime];
    token.owner.ui.notify(
      `Rotation is inactive because ${inactiveCommandReason(selected.reason)}. ` +
        "The bare destructive command was refused; specify a poolId or use all explicitly.\n" +
        usage(),
      "warning",
    );
    return undefined;
  };

  pi.registerCommand("key-rotator", {
    description: "Inspect, diagnose, advance, or reset independent API key rotation pools",
    handler: async (args, ctx) => {
      const token = adoptCommandContext(ctx);
      let commandFooterSequence: number | undefined;
      const reserveFooter = (): number => {
        commandFooterSequence ??= ++footerSequence;
        return commandFooterSequence;
      };
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const action = tokens[0]?.toLowerCase() ?? "status";
        const selector = tokens[1];
        if (tokens.length > 2) {
          token.owner.ui.notify(usage(), "warning");
          return;
        }

        if (action === "doctor") {
          if (selector || !dependencies.doctor) {
            token.owner.ui.notify(usage(), "warning");
            return;
          }
          const footerOrder = reserveFooter();
          const report = await dependencies.doctor();
          if (!stillOwns(token)) return;
          token.owner.ui.notify(
            report.text,
            report.severity === "FAIL" ? "error" : report.severity === "WARN" ? "warning" : "info",
          );
          if (report.severity !== "FAIL") await refreshFooter(undefined, token, footerOrder);
          return;
        }

        if (action === "list") {
          const footerOrder = reserveFooter();
          const entries = await Promise.all(pools.map(readConciseStatus));
          if (!stillOwns(token)) return;
          token.owner.ui.notify(entries.map((entry) => entry.text).join("\n"), "info");
          const activeRuntime = selection.kind === "active" ? selection.runtime : undefined;
          const active = activeRuntime
            ? entries.find((entry) => entry.runtime === activeRuntime && hasSnapshot(entry))
            : undefined;
          await refreshFooter(
            active && hasSnapshot(active)
              ? { poolId: active.runtime.id, snapshot: active.snapshot }
              : undefined,
            token,
            footerOrder,
          );
          return;
        }

        if (action === "status") {
          const footerOrder = reserveFooter();
          let footerSnapshot: FooterSnapshot | undefined;
          if (!selector) {
            const snapshots = await notifyAllStatuses(token);
            if (!stillOwns(token) || !snapshots) return;
            if (selection.kind === "active") {
              const active = snapshots.get(selection.runtime.id);
              if (active) footerSnapshot = { poolId: selection.runtime.id, snapshot: active };
            }
          } else {
            const selected = findPool(selector);
            if (!selected) {
              token.owner.ui.notify(`Unknown key pool "${selector}".\n${usage()}`, "warning");
              return;
            }
            const entry = await readDetailedStatus(selected);
            if (!stillOwns(token)) return;
            token.owner.ui.notify(entry.text, isEnabled(selected) ? "info" : "warning");
            if ("snapshot" in entry) {
              footerSnapshot = { poolId: entry.runtime.id, snapshot: entry.snapshot };
            }
          }
          await refreshFooter(footerSnapshot, token, footerOrder);
          return;
        }

        if (action === "next" || action === "reset") {
          const selected = resolveCommandPools(selector, true, token);
          if (!selected) return;
          const footerOrder = reserveFooter();
          const snapshots = new Map<string, PoolSnapshot>();
          for (const runtime of selected) {
            if (!stillOwns(token)) return;
            const snapshot = action === "next" ? await runtime.pool.advance() : await runtime.pool.reset();
            if (!stillOwns(token)) return;
            snapshots.set(runtime.id, snapshot);
            token.owner.ui.notify(
              action === "next"
                ? `Advanced pool "${runtime.id}" to ${snapshot.currentKeyId}.`
                : `Reset counters, cooldowns, and disabled states for pool "${runtime.id}".`,
              action === "next" ? "info" : "warning",
            );
          }
          const activeSnapshot =
            selection.kind === "active" ? snapshots.get(selection.runtime.id) : undefined;
          await refreshFooter(
            selection.kind === "active" && activeSnapshot
              ? { poolId: selection.runtime.id, snapshot: activeSnapshot }
              : undefined,
            token,
            footerOrder,
          );
          return;
        }

        token.owner.ui.notify(usage(), "warning");
      } catch {
        if (!stillOwns(token)) return;
        token.owner.ui.notify(
          "Key-rotator state operation failed. Run /key-rotator doctor before retrying.",
          "error",
        );
        await refreshFooter(undefined, token, commandFooterSequence ?? reserveFooter());
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    beginOwner(ctx.ui);
    setSelection(selectionForModel(ctx.model));
    const token = captureOwner();
    if (token) await refreshFooter(undefined, token);
  });

  pi.on("model_select", async (event, ctx) => {
    if (!activeOwner || activeOwner.ui !== ctx.ui) beginOwner(ctx.ui);
    const model = extractModel(event);
    const nextSelection = selectionForModel(model);
    setSelection(nextSelection);
    const token = captureOwner();

    if (nextSelection.kind === "inactive" && nextSelection.reason.kind === "api-mismatch") {
      const reason = nextSelection.reason;
      ctx.ui.notify(
        `Key pool "${reason.poolId}" expects provider "${reason.provider}" to use API "${reason.configuredApi}", ` +
          `but the selected model uses "${reason.selectedApi}". Update key-rotator.json or models.json.`,
        "error",
      );
    }
    if (token) await refreshFooter(undefined, token);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (activeOwner?.ui === ctx.ui) {
      activeOwner = undefined;
      selectionGeneration += 1;
      selection = { kind: "inactive", reason: { kind: "no-model" } };
      footerSequence += 1;
    }
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Session shutdown must not fail because the footer renderer failed.
    }
  });
}
