import type { ModelLike, StreamSimpleLike } from "./types.ts";

export interface RegisteredProviderConfigLike {
  api?: unknown;
  streamSimple?: unknown;
}

export interface ModelRegistryRegistrationLookupLike {
  getRegisteredProviderConfig?(provider: string): RegisteredProviderConfigLike | undefined;
}

export interface RequestFenceContextLike {
  model?: ModelLike;
  modelRegistry?: ModelRegistryRegistrationLookupLike;
  abort?: () => void;
}

export interface ManagedRequestTarget {
  provider: string;
  api: string;
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

/**
 * Read Pi's post-bind provider registry without mutating it. Function identity
 * distinguishes our direct stream registration from a later competing one.
 */
export function registrationEvidence(
  target: ManagedRequestTarget,
  ctx: RequestFenceContextLike,
): RegistrationEvidence {
  if (target.disabledReason !== undefined || target.streamSimple === undefined) {
    return {
      status: "disabled",
      api: target.api,
      detail: target.disabledReason ?? "pool state preflight did not complete",
    };
  }

  const lookup = ctx.modelRegistry?.getRegisteredProviderConfig;
  if (typeof lookup !== "function") return { status: "unverified", api: target.api };

  let registered: RegisteredProviderConfigLike | undefined;
  try {
    registered = lookup.call(ctx.modelRegistry, target.provider);
  } catch {
    return { status: "lookup-error", api: target.api };
  }
  if (!registered) return { status: "missing", api: target.api };
  if (registered.api !== target.api || registered.streamSimple !== target.streamSimple) {
    return {
      status: "overwritten",
      api: target.api,
      ...(typeof registered.api === "string" ? { observedApi: registered.api } : {}),
    };
  }
  return { status: "verified", api: target.api };
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

  const evidence = registrationEvidence(target, ctx);
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
