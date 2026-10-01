import { installRotatorErrorReporting } from "./error-reporting.ts";
import type { KeyPool } from "./key-pool.ts";
import { installManagedRequestFence } from "./request-fence.ts";
import type { ManagedRequestTarget } from "./request-fence.ts";
import { createRotatingStream } from "./rotating-stream.ts";
import type {
  EventStreamFactory,
  ExtensionApiLike,
  ExtensionContextLike,
  ModelLike,
  PoolSnapshot,
  ProviderErrorPolicy,
  ResolvedKeyDefinition,
  RotatorConfig,
  RotatorTarget,
  StreamSimpleLike,
} from "./types.ts";

export const STATUS_KEY = "pi-api-key-rotator";

export interface RegisterExtensionDependencies {
  config: RotatorConfig;
  pool: KeyPool;
  baseStreamSimple: StreamSimpleLike;
  createEventStream: EventStreamFactory;
  errorPolicy?: ProviderErrorPolicy | undefined;
}

type InactiveReason =
  | { kind: "no-model" }
  | { kind: "unmanaged"; provider: string }
  | { kind: "api-mismatch"; provider: string; configuredApi: string; selectedApi: string }
  | { kind: "pool-disabled"; poolId: string };

type SelectionState =
  | { kind: "active"; target: RotatorTarget }
  | { kind: "inactive"; reason: InactiveReason };

interface UiOwner {
  generation: number;
  ui: ExtensionContextLike["ui"];
}

interface OwnerToken {
  owner: UiOwner;
  selectionGeneration: number;
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

function configuredTargets(config: Pick<RotatorConfig, "provider" | "api" | "targets">): RotatorTarget[] {
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

export async function registerKeyRotatorExtension(
  pi: ExtensionApiLike,
  dependencies: RegisterExtensionDependencies,
): Promise<void> {
  const { config, pool } = dependencies;
  const firstKey = config.keys[0];
  if (!firstKey) throw new Error("Key rotator requires at least one resolved API key.");

  const targets = configuredTargets(config);
  const poolId = configuredPoolId(config);
  const targetsByProvider = new Map(targets.map((target) => [target.provider, target] as const));
  let preflightFailure: string | undefined;
  try {
    // Read-only startup validation. A rejection disables this pool without a
    // transaction, lock, reset, or overwrite of its evidence.
    await pool.snapshot();
  } catch (error) {
    preflightFailure = sanitizedStateFailure(error);
  }

  let ownerGeneration = 0;
  let activeOwner: UiOwner | undefined;
  let selectionGeneration = 0;
  let selection: SelectionState = { kind: "inactive", reason: { kind: "no-model" } };
  let footerSequence = 0;
  let queuedFooter: { snapshot: PoolSnapshot; token: OwnerToken } | undefined;
  let footerQueued = false;

  const beginOwner = (ui: ExtensionContextLike["ui"]): UiOwner => {
    ownerGeneration += 1;
    const owner = { generation: ownerGeneration, ui };
    activeOwner = owner;
    return owner;
  };

  const selectionForModel = (model: ModelLike | undefined): SelectionState => {
    if (!model) return { kind: "inactive", reason: { kind: "no-model" } };
    const target = targetsByProvider.get(model.provider);
    if (!target) {
      return { kind: "inactive", reason: { kind: "unmanaged", provider: model.provider } };
    }
    if (model.api !== target.api) {
      return {
        kind: "inactive",
        reason: {
          kind: "api-mismatch",
          provider: model.provider,
          configuredApi: target.api,
          selectedApi: model.api,
        },
      };
    }
    if (preflightFailure !== undefined) {
      return { kind: "inactive", reason: { kind: "pool-disabled", poolId } };
    }
    return { kind: "active", target };
  };

  const setSelection = (next: SelectionState): void => {
    selectionGeneration += 1;
    selection = next;
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

  const refreshStatus = async (
    snapshot?: PoolSnapshot,
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
      const resolved = snapshot ?? (await pool.snapshot());
      if (!stillOwns(token)) return;
      commitFooter(token, sequence, compactStatus(resolved));
    } catch {
      if (!stillOwns(token)) return;
      commitFooter(token, sequence, "keys: state unavailable");
    }
  };

  const queueFooter = (snapshot: PoolSnapshot, token: OwnerToken): void => {
    if (!stillOwns(token)) return;
    queuedFooter = { snapshot, token };
    if (footerQueued) return;
    footerQueued = true;
    queueMicrotask(() => {
      footerQueued = false;
      const pending = queuedFooter;
      queuedFooter = undefined;
      if (!pending || !stillOwns(pending.token) || selection.kind !== "active") return;
      void refreshStatus(pending.snapshot, pending.token);
    });
  };

  const managedTargets = new Map<string, ManagedRequestTarget>();
  for (const target of targets) {
    managedTargets.set(target.provider, {
      provider: target.provider,
      api: target.api,
      apiKey: MANAGED_KEY_PLACEHOLDER,
      poolId,
      ...(preflightFailure !== undefined ? { disabledReason: "state preflight failed" } : {}),
    });
  }

  if (preflightFailure === undefined) {
    const providerFallback = fallbackApiKey(firstKey);
    for (const target of targets) {
      // Keep a direct per-provider Pi registration and preserve the exact model
      // object. Direct mismatches are denied inside createRotatingStream.
      const guardedStream = ((model, context, options) => {
        const selected = selection;
        const requestOwner =
          model.provider === target.provider &&
          model.api === target.api &&
          selected.kind === "active" &&
          selected.target.provider === target.provider &&
          selected.target.api === target.api
            ? captureOwner()
            : undefined;
        const rotatingStream = createRotatingStream({
          config,
          pool,
          baseStreamSimple: dependencies.baseStreamSimple,
          createEventStream: dependencies.createEventStream,
          errorPolicy: dependencies.errorPolicy,
          ...(requestOwner
            ? { onStateChange: (snapshot: PoolSnapshot) => queueFooter(snapshot, requestOwner) }
            : {}),
        });
        return rotatingStream(model, context, options);
      }) as StreamSimpleLike;
      pi.registerProvider(target.provider, {
        api: target.api,
        apiKey: providerFallback,
        streamSimple: guardedStream,
      });
      managedTargets.set(target.provider, {
        provider: target.provider,
        api: target.api,
        apiKey: providerFallback,
        poolId,
        streamSimple: guardedStream,
      });
    }
  }
  installManagedRequestFence(pi, managedTargets);
  const errorReporter = installRotatorErrorReporting(pi, [config]);

  pi.registerCommand("key-rotator", {
    description: "Show, advance, or reset the shared API key rotation pool",
    handler: async (args, ctx) => {
      const token = adoptCommandContext(ctx);
      let commandFooterSequence: number | undefined;
      const reserveFooter = (): number => {
        commandFooterSequence ??= ++footerSequence;
        return commandFooterSequence;
      };
      try {
        const action = args.trim().toLowerCase() || "status";

        if (action === "errors") {
          errorReporter.show(ctx);
          return;
        }
        if (action === "status") {
          const footerOrder = reserveFooter();
          if (preflightFailure !== undefined) {
            token.owner.ui.notify(
              [
                `Pool: ${poolId}`,
                "Rotation: disabled",
                "Reason: state preflight failed; the state file was not changed so evidence is preserved.",
                `State error: ${preflightFailure}`,
              ].join("\n"),
              "warning",
            );
            await refreshStatus(undefined, token, footerOrder);
            return;
          }
          const snapshot = await pool.snapshot();
          if (!stillOwns(token)) return;
          token.owner.ui.notify(formatStatus(snapshot, config), "info");
          await refreshStatus(snapshot, token, footerOrder);
          return;
        }
        if (action === "next" || action === "reset") {
          const selected = selection;
          if (selected.kind === "inactive") {
            token.owner.ui.notify(
              `Rotation is inactive because ${inactiveCommandReason(selected.reason)}. ` +
                `The bare destructive command "${action}" was refused.`,
              "warning",
            );
            return;
          }
          const footerOrder = reserveFooter();
          const snapshot = action === "next" ? await pool.advance() : await pool.reset();
          if (!stillOwns(token)) return;
          token.owner.ui.notify(
            action === "next"
              ? `Advanced pool "${poolId}" to ${snapshot.currentKeyId}.`
              : `Reset counters, cooldowns, and disabled states for pool "${poolId}".`,
            action === "next" ? "info" : "warning",
          );
          await refreshStatus(snapshot, token, footerOrder);
          return;
        }

        token.owner.ui.notify("Usage: /key-rotator [status|errors|next|reset]", "warning");
      } catch {
        if (!stillOwns(token)) return;
        token.owner.ui.notify(
          "Key-rotator state operation failed. Inspect the state file before retrying.",
          "error",
        );
        await refreshStatus(undefined, token, commandFooterSequence ?? reserveFooter());
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    errorReporter.restore(ctx);
    beginOwner(ctx.ui);
    setSelection(selectionForModel(ctx.model));
    const token = captureOwner();
    if (token) await refreshStatus(undefined, token);
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
        `Key rotator target "${reason.provider}" expects API "${reason.configuredApi}", ` +
          `but the selected model uses "${reason.selectedApi}". Update key-rotator.json or models.json so the API values match.`,
        "error",
      );
    }
    if (token) await refreshStatus(undefined, token);
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
