export interface RotatorTarget {
  provider: string;
  api: string;
}

export type RateLimitScope = "key" | "target" | "pool";

export interface EnvKeyDefinition {
  id: string;
  env: string;
  value?: never;
  command?: never;
}

export interface LiteralKeyDefinition {
  id: string;
  value: string;
  env?: never;
  command?: never;
}

/**
 * Opt-in third source: the secret is produced by an external command, so it is
 * never stored in the config file. The command runs once while the extension
 * loads. Its trimmed stdout is the secret.
 */
export interface CommandKeyDefinition {
  id: string;
  command: string;
  commandTimeoutMs?: number;
  env?: never;
  value?: never;
}

/** A key definition must use exactly one secret source. */
export type KeyDefinition = EnvKeyDefinition | LiteralKeyDefinition | CommandKeyDefinition;

export interface RawRotatorConfig {
  /** Optional schema marker. Versionless documents remain supported. */
  configVersion?: 1;

  /** Optional stable identifier used for the default state-file name. */
  poolId?: string;

  /** Legacy single-target form. Must be used together and without `targets`. */
  provider?: string;
  api?: string;

  /** Multi-target form. Every target shares the same key pool and counters. */
  targets?: RotatorTarget[];

  keys: KeyDefinition[];
  requestsPerKey?: number;
  maxAttemptsPerRequest?: number;
  cooldownMs?: number;
  transientCooldownMs?: number;
  maxRetryAfterMs?: number;
  retryStatuses?: number[];
  disableStatuses?: number[];
  cooldownStatuses?: number[];
  /** Scope used when a status in cooldownStatuses (429 by default) is observed. */
  rateLimitScope?: RateLimitScope;
  /** Consecutive transient/network failures before a target circuit opens. */
  targetFailureThreshold?: number;
  retryNetworkErrors?: boolean;
  stateFile?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  /** Maximum accepted persisted state size. */
  maxStateFileBytes?: number;
}

export type KeySource = "env" | "literal" | "command";

export interface ResolvedKeyDefinition {
  id: string;
  /** Optional so pre-v0.2 programmatic configs remain source compatible. */
  source?: KeySource;
  env?: string;
  /** Set for `source: "command"` keys. Never printed together with a value. */
  command?: string;
  commandTimeoutMs?: number;
  value: string;
}

export interface RotatorConfig {
  /** Resolved configs always set this; optional preserves programmatic v0.1 compatibility. */
  poolId?: string;
  /** Resolved configs always set this; optional preserves programmatic v0.1 compatibility. */
  targets?: RotatorTarget[];

  /** @deprecated Compatibility alias for the first target. */
  provider: string;
  /** @deprecated Compatibility alias for the first target. */
  api: string;

  keys: ResolvedKeyDefinition[];
  requestsPerKey: number;
  maxAttemptsPerRequest: number;
  cooldownMs: number;
  transientCooldownMs: number;
  maxRetryAfterMs: number;
  retryStatuses: ReadonlySet<number>;
  disableStatuses: ReadonlySet<number>;
  cooldownStatuses: ReadonlySet<number>;
  /** Resolved configs set this; omitted programmatic configs keep key-scoped cooldowns. */
  rateLimitScope?: RateLimitScope;
  /** Resolved configs set this; omitted programmatic configs use 2. */
  targetFailureThreshold?: number;
  retryNetworkErrors: boolean;
  stateFile: string;
  lockTimeoutMs: number;
  staleLockMs: number;
  /** Optional for source compatibility with programmatic pre-v0.5 configs. */
  maxStateFileBytes?: number;
  configFile: string;
  /** Monotonic filesystem revision used to fence rolling secret changes. */
  configRevision?: string;
}

export interface KeyRuntimeState {
  /** SHA-256 identity only; the secret itself is never persisted. */
  credentialFingerprint: string | null;
  /** Filesystem revision that installed credentialFingerprint. */
  configRevision: string;
  attempts: number;
  successes: number;
  failures: number;
  /** Highest selected attempt whose outcome controls key health. */
  lastOutcomeAttempt: number;
  disabled: boolean;
  cooldownUntil: number;
  lastStatus: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

export interface TargetRuntimeState {
  failures: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastStatus: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastOutcomeAttempt: number;
}

export interface PoolState {
  magic: "pi-api-key-rotator-state";
  version: 2;
  /** Stable configured identity. Prevents one pool from consuming another pool's state. */
  poolId: string;
  /** Incremented by reset so completions selected before it can be ignored. */
  generation: number;
  currentKeyId: string;
  requestsOnCurrent: number;
  totalAttempts: number;
  updatedAt: number;
  poolCooldownUntil: number;
  /** Highest successful attempt that can fence an older pool-scoped cooldown. */
  poolLastSuccessAttempt: number;
  keys: Record<string, KeyRuntimeState>;
  targets: Record<string, TargetRuntimeState>;
}

export interface SelectedKey {
  id: string;
  /** Optional for compatibility with the legacy KeyPool metadata shape. */
  source?: KeySource;
  env?: string | undefined;
  value: string;
  ordinal: number;
  attemptNumber: number;
  /** Provider target whose circuit was checked for this selection. */
  targetId: string;
  /** Credential identity used to reject stale rolling-config outcomes. */
  credentialFingerprint: string;
  /** Pool generation captured atomically with this attempt selection. */
  epoch: number;
  /** Post-selection view from the same state transaction. */
  snapshot: PoolSnapshot;
}

export interface SelectionResult {
  selected: SelectedKey | null;
  /** Post-selection (or no-selection) view from the same state transaction. */
  snapshot: PoolSnapshot;
}

export interface KeyStatusSnapshot
  extends Omit<KeyRuntimeState, "credentialFingerprint" | "configRevision" | "lastOutcomeAttempt"> {
  id: string;
  /** Optional for compatibility with state snapshots created before v0.2. */
  source?: KeySource;
  env?: string | undefined;
  current: boolean;
  available: boolean;
}

export interface TargetStatusSnapshot extends TargetRuntimeState {
  id: string;
  available: boolean;
}

export interface PoolSnapshot {
  /** Optional so callers constructing legacy snapshots remain source compatible. */
  generation?: number;
  currentKeyId: string;
  requestsOnCurrent: number;
  requestsPerKey: number;
  totalAttempts: number;
  updatedAt: number;
  poolCooldownUntil: number;
  keys: KeyStatusSnapshot[];
  targets: TargetStatusSnapshot[];
}

export interface ProviderResponseLike {
  status: number;
  headers: Record<string, string>;
}

export interface ModelLike {
  api: string;
  provider: string;
  id: string;
  baseUrl?: string;
  [key: string]: unknown;
}

export interface ContextLike {
  [key: string]: unknown;
}

export interface StreamOptionsLike {
  signal?: AbortSignal;
  apiKey?: string;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  /** Pi 0.84.2 headers may use null to suppress a provider default. */
  headers?: Record<string, string | null>;
  onPayload?: (payload: unknown, model: ModelLike) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (response: ProviderResponseLike, model: ModelLike) => void | Promise<void>;
  [key: string]: unknown;
}

export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AssistantMessageLike {
  role: "assistant";
  content: unknown[];
  api: string;
  provider: string;
  model: string;
  usage: UsageLike;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  errorMessage?: string;
  timestamp: number;
  [key: string]: unknown;
}

export type AssistantEventLike =
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse" | "deferred";
      message: AssistantMessageLike;
      [key: string]: unknown;
    }
  | {
      type: "error";
      reason: "error" | "aborted";
      error: AssistantMessageLike;
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface AssistantEventStreamLike extends AsyncIterable<AssistantEventLike> {
  push(event: AssistantEventLike): void;
  result(): Promise<AssistantMessageLike>;
}

export type StreamSimpleLike = (
  model: ModelLike,
  context: ContextLike,
  options?: StreamOptionsLike,
) => AssistantEventStreamLike;

export interface EventStreamFactory {
  (): AssistantEventStreamLike;
}

export interface ExtensionUiLike {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface ExtensionContextLike {
  ui: ExtensionUiLike;
  model?: ModelLike;
  modelRegistry?: {
    getRegisteredProviderConfig?(provider: string): {
      api?: unknown;
      apiKey?: unknown;
      streamSimple?: unknown;
      [key: string]: unknown;
    } | undefined;
    getRegisteredNativeProvider?(provider: string): unknown;
  };
  abort?: () => void;
}

export interface ExtensionApiLike {
  registerProvider(
    name: string,
    config: {
      api: string;
      apiKey: string;
      streamSimple: StreamSimpleLike;
    },
  ): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void;
    },
  ): void;
  on(
    event:
      | "session_start"
      | "model_select"
      | "session_shutdown"
      | "input"
      | "turn_start"
      | "before_provider_headers"
      | "before_provider_request"
      | "session_before_compact"
      | "session_before_tree",
    handler: (event: unknown, ctx: ExtensionContextLike) => unknown | Promise<unknown>,
  ): void;
}

export interface Clock {
  now(): number;
}
