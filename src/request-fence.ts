import type { ModelLike, StreamSimpleLike } from "./types.ts";

export interface RegisteredProviderConfigLike {
  api?: unknown;
  apiKey?: unknown;
  streamSimple?: unknown;
  [key: string]: unknown;
}

export interface ModelRegistryRegistrationLookupLike {
  getRegisteredProviderConfig?(provider: string): RegisteredProviderConfigLike | undefined;
  getRegisteredNativeProvider?(provider: string): unknown;
}

export interface RequestFenceContextLike {
  model?: ModelLike;
  modelRegistry?: ModelRegistryRegistrationLookupLike;
  abort?: () => void;
}

export interface ManagedRequestTarget {
  provider: string;
  api: string;
  apiKey: string;
  poolId: string;
  /** The exact function Pi must have retained after binding registrations. */
  streamSimple?: StreamSimpleLike;
  /** Set when state preflight intentionally skipped provider registration. */
  disabledReason?: string;
}

export type RegistrationEvidence =
  | { status: "verified"; api: string }
  | { status: "unverified"; api: string }
  | { status: "disabled"; api: string; detail: string }
  | { status: "missing"; api: string }
  | { status: "overwritten"; api: string; observedApi?: string }
  | { status: "lookup-error"; api: string };

interface RegistrationInspection {
  evidence: RegistrationEvidence;
  registration?: RegisteredProviderConfigLike;
}

const EXPECTED_REGISTRATION_FIELDS = ["api", "apiKey", "streamSimple"] as const;

function inspectRegistration(
  target: ManagedRequestTarget,
  ctx: RequestFenceContextLike,
): RegistrationInspection {
  if (target.disabledReason !== undefined || target.streamSimple === undefined) {
    return {
      evidence: {
        status: "disabled",
        api: target.api,
        detail: target.disabledReason ?? "pool state preflight did not complete",
      },
    };
  }

  const registry = ctx.modelRegistry;
  const lookup = registry?.getRegisteredProviderConfig;
  const nativeLookup = registry?.getRegisteredNativeProvider;
  // Older wildcard-compatible Pi versions may not expose post-bind evidence.
  // The API fence still applies; doctor reports this state as unverified.
  if (typeof lookup !== "function" || typeof nativeLookup !== "function") {
    return { evidence: { status: "unverified", api: target.api } };
  }

  try {
    const registered = lookup.call(registry, target.provider);
    const nativeProvider = nativeLookup.call(registry, target.provider);
    if (nativeProvider !== undefined) {
      return { evidence: { status: "overwritten", api: target.api } };
    }
    if (!registered) return { evidence: { status: "missing", api: target.api } };

    const ownFields = Reflect.ownKeys(registered).sort((left, right) =>
      String(left).localeCompare(String(right)),
    );
    const expectedFields = [...EXPECTED_REGISTRATION_FIELDS].sort();
    const exactFields =
      ownFields.length === expectedFields.length &&
      ownFields.every((name, index) => name === expectedFields[index]);
    const observedApi = registered.api;
    if (
      !exactFields ||
      observedApi !== target.api ||
      registered.apiKey !== target.apiKey ||
      registered.streamSimple !== target.streamSimple
    ) {
      return {
        evidence: {
          status: "overwritten",
          api: target.api,
          ...(typeof observedApi === "string" && observedApi !== target.api
            ? { observedApi }
            : {}),
        },
      };
    }
    return {
      evidence: { status: "verified", api: target.api },
      registration: registered,
    };
  } catch {
    return { evidence: { status: "lookup-error", api: target.api } };
  }
}

/**
 * Read Pi's post-bind provider registry without mutating it. Strict critical
 * fields and exact function identity reject merged or native registrations.
 */
export function registrationEvidence(
  target: ManagedRequestTarget,
  ctx: RequestFenceContextLike,
): RegistrationEvidence {
  return inspectRegistration(target, ctx).evidence;
}

function evidenceBlockReason(
  target: ManagedRequestTarget,
  evidence: RegistrationEvidence,
): string | undefined {
  if (evidence.status === "verified" || evidence.status === "unverified") return undefined;
  if (evidence.status === "disabled") {
    return `Key pool "${target.poolId}" is disabled because its state could not be validated.`;
  }
  if (evidence.status === "missing") {
    return `Pi did not retain the key-rotator registration for provider "${target.provider}".`;
  }
  if (evidence.status === "overwritten") {
    return `Another registration replaced the key-rotator stream for provider "${target.provider}".`;
  }
  return `Pi could not verify the key-rotator registration for provider "${target.provider}".`;
}

/** Return a safe user-facing reason when a managed request must not proceed. */
export function blockedRequestReason(
  target: ManagedRequestTarget,
  model: ModelLike,
  ctx: RequestFenceContextLike,
): string | undefined {
  if (model.api !== target.api) {
    return (
      `Key pool "${target.poolId}" manages provider "${target.provider}" only with API ` +
      `"${target.api}"; the selected model uses "${model.api}".`
    );
  }
  return evidenceBlockReason(target, registrationEvidence(target, ctx));
}

const AUTH_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-goog-api-key",
  "x-amz-security-token",
  "cookie",
] as const;

function looksLikeAuthenticationHeader(name: string): boolean {
  return /(?:auth|api[-_]?key|token|secret|credential|cookie|signature)/iu.test(name);
}

/**
 * Suppress both assembled credentials and common adapter-generated defaults.
 * Pi 0.84.2 treats a null ProviderHeaders entry as an explicit deletion.
 */
export function suppressAuthenticationHeaders(headers: Record<string, string | null>): void {
  for (const name of Object.keys(headers)) {
    if (looksLikeAuthenticationHeader(name)) headers[name] = null;
  }
  for (const name of AUTH_HEADER_NAMES) headers[name] = null;
}

export interface RequestFenceUiLike {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface RequestFenceHostContextLike extends RequestFenceContextLike {
  ui: RequestFenceUiLike;
}

export type RequestFenceEventName =
  | "session_start"
  | "input"
  | "turn_start"
  | "before_provider_headers"
  | "before_provider_request"
  | "session_before_compact"
  | "session_before_tree";

export interface RequestFenceEventApiLike {
  on(
    event: RequestFenceEventName,
    handler: (
      event: unknown,
      ctx: RequestFenceHostContextLike,
    ) => unknown | Promise<unknown>,
  ): void;
}

export interface ManagedRequestFence {
  registrations(ctx: RequestFenceContextLike): ReadonlyMap<string, RegistrationEvidence>;
}

function eventHeaders(event: unknown): Record<string, string | null> | undefined {
  if (typeof event !== "object" || event === null || !("headers" in event)) return undefined;
  const headers = (event as { headers?: unknown }).headers;
  return typeof headers === "object" && headers !== null
    ? headers as Record<string, string | null>
    : undefined;
}

function treeEventWantsSummary(event: unknown): boolean {
  if (typeof event !== "object" || event === null || !("preparation" in event)) return false;
  const preparation = (event as { preparation?: unknown }).preparation;
  return (
    typeof preparation === "object" &&
    preparation !== null &&
    "userWantsSummary" in preparation &&
    preparation.userWantsSummary === true &&
    "entriesToSummarize" in preparation &&
    Array.isArray(preparation.entriesToSummarize) &&
    preparation.entriesToSummarize.length > 0
  );
}

function abortBlockedContext(ctx: RequestFenceHostContextLike): void {
  try {
    ctx.abort?.();
  } catch {
    // Pi 0.84.2's abort contract does not throw. Keep later defense-in-depth
    // hooks active if an unsupported host violates that contract.
  }
}

function notifyBlocked(ctx: RequestFenceHostContextLike, reason: string): void {
  try {
    ctx.ui?.notify(`${reason} The provider request was refused before dispatch.`, "error");
  } catch {
    // Headless and stale UIs still get the fail-closed handler result.
  }
}

/**
 * Install Pi-native lifecycle and request hooks for every configured provider.
 * `input` refuses ordinary prompts before an agent run. `turn_start` also fences
 * continuations and retries. The provider hooks close the remaining race and
 * explicitly delete common auth. Registration violations latch until reload.
 */
export function installManagedRequestFence(
  pi: RequestFenceEventApiLike,
  targets: ReadonlyMap<string, ManagedRequestTarget>,
): ManagedRequestFence {
  const capturedRegistrations = new Map<string, RegisteredProviderConfigLike>();
  const latchedProviders = new Set<string>();

  const evaluateRegistration = (
    target: ManagedRequestTarget,
    ctx: RequestFenceContextLike,
  ): RegistrationEvidence => {
    if (latchedProviders.has(target.provider)) {
      return { status: "overwritten", api: target.api };
    }

    const inspection = inspectRegistration(target, ctx);
    const evidence = inspection.evidence;
    if (evidence.status === "verified" && inspection.registration) {
      const captured = capturedRegistrations.get(target.provider);
      if (captured === undefined) {
        capturedRegistrations.set(target.provider, inspection.registration);
      } else if (captured !== inspection.registration) {
        latchedProviders.add(target.provider);
        return { status: "overwritten", api: target.api };
      }
      return evidence;
    }
    if (
      evidence.status !== "unverified" &&
      evidence.status !== "disabled"
    ) {
      latchedProviders.add(target.provider);
    }
    return evidence;
  };

  const observeRegistration = (
    target: ManagedRequestTarget,
    ctx: RequestFenceContextLike,
  ): RegistrationEvidence => {
    if (latchedProviders.has(target.provider)) {
      return { status: "overwritten", api: target.api };
    }
    const inspection = inspectRegistration(target, ctx);
    const captured = capturedRegistrations.get(target.provider);
    if (
      inspection.evidence.status === "verified" &&
      inspection.registration &&
      captured !== undefined &&
      captured !== inspection.registration
    ) {
      return { status: "overwritten", api: target.api };
    }
    return inspection.evidence;
  };

  // Doctor uses this observer. It reads current and already-latched evidence
  // without capturing an identity or changing future request enforcement.
  const registrations = (
    ctx: RequestFenceContextLike,
  ): ReadonlyMap<string, RegistrationEvidence> =>
    new Map(
      [...targets].map(([provider, target]) => [
        provider,
        observeRegistration(target, ctx),
      ] as const),
    );

  const blockedContext = (
    ctx: RequestFenceHostContextLike,
  ): { target: ManagedRequestTarget; reason: string } | undefined => {
    const model = ctx.model;
    if (!model) return undefined;
    const target = targets.get(model.provider);
    if (!target) return undefined;
    if (model.api !== target.api) {
      return {
        target,
        reason:
          `Key pool "${target.poolId}" manages provider "${target.provider}" only with API ` +
          `"${target.api}"; the selected model uses "${model.api}".`,
      };
    }
    const reason = evidenceBlockReason(target, evaluateRegistration(target, ctx));
    return reason === undefined ? undefined : { target, reason };
  };

  // This is the first post-bind acknowledgement point in Pi 0.84.2. Capture
  // exact registry object identity for every healthy target, not only the
  // currently selected model.
  pi.on("session_start", (_event, ctx) => {
    for (const target of targets.values()) evaluateRegistration(target, ctx);
  });

  pi.on("input", (_event, ctx) => {
    const blocked = blockedContext(ctx);
    if (!blocked) return undefined;
    notifyBlocked(ctx, blocked.reason);
    return { action: "handled" as const };
  });

  pi.on("turn_start", (_event, ctx) => {
    if (blockedContext(ctx)) abortBlockedContext(ctx);
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (!blockedContext(ctx)) return;
    // Abort is the primary fence and must run even if an unsupported header
    // object cannot be inspected. Header deletion is defense in depth.
    abortBlockedContext(ctx);
    try {
      const headers = eventHeaders(event);
      if (headers) suppressAuthenticationHeaders(headers);
    } catch {
      // The synchronous abort above already fenced the verified Pi pipeline.
    }
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (blockedContext(ctx)) abortBlockedContext(ctx);
  });

  const cancelSummary = (_event: unknown, ctx: RequestFenceHostContextLike) => {
    const blocked = blockedContext(ctx);
    if (!blocked) return undefined;
    notifyBlocked(ctx, blocked.reason);
    return { cancel: true as const };
  };
  pi.on("session_before_compact", cancelSummary);
  pi.on("session_before_tree", (event, ctx) => {
    // Pi also emits this event for local tree navigation. Only a requested
    // branch summary can dispatch a managed provider call.
    if (!treeEventWantsSummary(event)) return undefined;
    return cancelSummary(event, ctx);
  });

  return { registrations };
}
