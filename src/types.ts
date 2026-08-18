export interface RotatorTarget {
  provider: string;
  api: string;
}

export interface EnvKeyDefinition {
  id: string;
  env: string;
  value?: never;
}

export interface LiteralKeyDefinition {
  id: string;
  value: string;
  env?: never;
}

/** A key definition must use exactly one secret source. */
export type KeyDefinition = EnvKeyDefinition | LiteralKeyDefinition;

export interface RawRotatorConfig {
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
  retryNetworkErrors?: boolean;
  stateFile?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export type KeySource = "env" | "literal";

export interface ResolvedKeyDefinition {
  id: string;
  /** Optional so pre-v0.2 programmatic configs remain source compatible. */
  source?: KeySource;
  env?: string;
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
  retryNetworkErrors: boolean;
  stateFile: string;
  lockTimeoutMs: number;
  staleLockMs: number;
  configFile: string;
}

export interface KeyRuntimeState {
  attempts: number;
  successes: number;
  failures: number;
  disabled: boolean;
  cooldownUntil: number;
  lastStatus: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

export interface PoolState {
  version: 1;
  currentKeyId: string;
  requestsOnCurrent: number;
  totalAttempts: number;
  updatedAt: number;
  keys: Record<string, KeyRuntimeState>;
}

export interface SelectedKey {
  id: string;
  /** Optional for compatibility with the legacy KeyPool metadata shape. */
  source?: KeySource;
  env?: string | undefined;
  value: string;
  ordinal: number;
  attemptNumber: number;
}

export interface KeyStatusSnapshot extends KeyRuntimeState {
  id: string;
  /** Optional for compatibility with state snapshots created before v0.2. */
  source?: KeySource;
  env?: string | undefined;
  current: boolean;
  available: boolean;
}

export interface PoolSnapshot {
  currentKeyId: string;
  requestsOnCurrent: number;
  requestsPerKey: number;
  totalAttempts: number;
  updatedAt: number;
  keys: KeyStatusSnapshot[];
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
    event: "session_start" | "model_select" | "session_shutdown",
    handler: (event: unknown, ctx: ExtensionContextLike) => Promise<void> | void,
  ): void;
}

export interface Clock {
  now(): number;
}
