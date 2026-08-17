import type { StateStore } from "./state-store.ts";
import type {
  Clock,
  KeyRuntimeState,
  PoolSnapshot,
  PoolState,
  ProviderResponseLike,
  RotatorConfig,
  SelectedKey,
} from "./types.ts";

const systemClock: Clock = { now: () => Date.now() };

function createKeyState(): KeyRuntimeState {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    disabled: false,
    cooldownUntil: 0,
    lastStatus: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
}

export function createInitialPoolState(config: RotatorConfig, now: number): PoolState {
  return {
    version: 1,
    currentKeyId: config.keys[0]?.id ?? "",
    requestsOnCurrent: 0,
    totalAttempts: 0,
    updatedAt: now,
    keys: Object.fromEntries(config.keys.map((key) => [key.id, createKeyState()])),
  };
}

function finiteNonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeKeyState(value: unknown): KeyRuntimeState {
  const source = typeof value === "object" && value !== null ? (value as Partial<KeyRuntimeState>) : {};
  return {
    attempts: finiteNonNegativeInteger(source.attempts),
    successes: finiteNonNegativeInteger(source.successes),
    failures: finiteNonNegativeInteger(source.failures),
    disabled: source.disabled === true,
    cooldownUntil: finiteNonNegativeInteger(source.cooldownUntil),
    lastStatus: nullableFiniteNumber(source.lastStatus),
    lastAttemptAt: nullableFiniteNumber(source.lastAttemptAt),
    lastSuccessAt: nullableFiniteNumber(source.lastSuccessAt),
    lastFailureAt: nullableFiniteNumber(source.lastFailureAt),
  };
}

function normalizeState(state: PoolState, config: RotatorConfig, now: number): void {
  state.version = 1;
  state.totalAttempts = finiteNonNegativeInteger(state.totalAttempts);
  state.requestsOnCurrent = finiteNonNegativeInteger(state.requestsOnCurrent);
  state.updatedAt = finiteNonNegativeInteger(state.updatedAt, now);
  if (typeof state.keys !== "object" || state.keys === null || Array.isArray(state.keys)) {
    state.keys = {};
  }
  if (typeof state.currentKeyId !== "string") state.currentKeyId = "";

  const configuredIds = new Set(config.keys.map((key) => key.id));
  for (const id of Object.keys(state.keys ?? {})) {
    if (!configuredIds.has(id)) delete state.keys[id];
  }
  for (const key of config.keys) {
    const keyState = normalizeKeyState(state.keys[key.id]);
    state.keys[key.id] = keyState;
    if (keyState.cooldownUntil <= now) keyState.cooldownUntil = 0;
  }

  if (!configuredIds.has(state.currentKeyId)) {
    state.currentKeyId = config.keys[0]?.id ?? "";
    state.requestsOnCurrent = 0;
  }
  if (state.requestsOnCurrent >= config.requestsPerKey) {
    state.requestsOnCurrent = 0;
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function parseRetryAfterMs(
  headers: Record<string, string>,
  now: number,
  fallbackMs: number,
  maximumMs: number,
): number {
  const raw = headerValue(headers, "retry-after")?.trim();
  let delayMs = fallbackMs;

  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      delayMs = Math.ceil(seconds * 1_000);
    } else {
      const timestamp = Date.parse(raw);
      if (Number.isFinite(timestamp)) delayMs = Math.max(0, timestamp - now);
    }
  }

  const normalized = Math.max(0, Math.floor(delayMs));
  return maximumMs > 0 ? Math.min(normalized, maximumMs) : normalized;
}

export class KeyPool {
  private readonly config: RotatorConfig;
  private readonly store: StateStore<PoolState>;
  private readonly clock: Clock;

  constructor(config: RotatorConfig, store: StateStore<PoolState>, clock: Clock = systemClock) {
    this.config = config;
    this.store = store;
    this.clock = clock;
  }

  async select(excludedKeyIds: ReadonlySet<string> = new Set()): Promise<SelectedKey | null> {
    const now = this.clock.now();
    return this.store.transact((state) => {
      normalizeState(state, this.config, now);
      const selectedId = this.findAvailable(state, state.currentKeyId, excludedKeyIds, true);
      if (!selectedId) return null;

      if (state.currentKeyId !== selectedId) {
        state.currentKeyId = selectedId;
        state.requestsOnCurrent = 0;
      }

      const keyState = state.keys[selectedId];
      if (!keyState) return null;
      keyState.attempts += 1;
      keyState.lastAttemptAt = now;
      state.totalAttempts += 1;
      state.requestsOnCurrent += 1;
      state.updatedAt = now;

      const selected = this.config.keys.find((key) => key.id === selectedId);
      if (!selected) return null;
      const attemptNumber = state.totalAttempts;

      if (state.requestsOnCurrent >= this.config.requestsPerKey) {
        const nextId = this.findAvailable(state, selectedId, new Set(), false) ?? selectedId;
        state.currentKeyId = nextId;
        state.requestsOnCurrent = 0;
      }

      return {
        id: selected.id,
        env: selected.env,
        value: selected.value,
        ordinal: this.config.keys.findIndex((key) => key.id === selected.id),
        attemptNumber,
      };
    });
  }

  async recordSuccess(keyId: string, status: number): Promise<void> {
    const now = this.clock.now();
    await this.store.transact((state) => {
      normalizeState(state, this.config, now);
      const keyState = state.keys[keyId];
      if (!keyState) return;
      keyState.successes += 1;
      keyState.lastStatus = status;
      keyState.lastSuccessAt = now;
      state.updatedAt = now;
    });
  }

  async recordFailure(keyId: string, response: ProviderResponseLike): Promise<void> {
    const now = this.clock.now();
    await this.store.transact((state) => {
      normalizeState(state, this.config, now);
      const keyState = state.keys[keyId];
      if (!keyState) return;

      keyState.failures += 1;
      keyState.lastStatus = response.status;
      keyState.lastFailureAt = now;

      if (this.config.disableStatuses.has(response.status)) {
        keyState.disabled = true;
        keyState.cooldownUntil = 0;
      } else if (this.config.cooldownStatuses.has(response.status)) {
        const delayMs = parseRetryAfterMs(
          response.headers,
          now,
          this.config.cooldownMs,
          this.config.maxRetryAfterMs,
        );
        keyState.cooldownUntil = now + delayMs;
      } else if (this.config.retryStatuses.has(response.status)) {
        keyState.cooldownUntil = now + this.config.transientCooldownMs;
      }

      if (state.currentKeyId === keyId && !this.isAvailable(state, keyId, now, new Set())) {
        const nextId = this.findAvailable(state, keyId, new Set(), false);
        if (nextId) {
          state.currentKeyId = nextId;
          state.requestsOnCurrent = 0;
        }
      }
      state.updatedAt = now;
    });
  }

  async recordNetworkFailure(keyId: string): Promise<void> {
    const now = this.clock.now();
    await this.store.transact((state) => {
      normalizeState(state, this.config, now);
      const keyState = state.keys[keyId];
      if (!keyState) return;
      keyState.failures += 1;
      keyState.lastStatus = null;
      keyState.lastFailureAt = now;
      keyState.cooldownUntil = now + this.config.transientCooldownMs;

      if (state.currentKeyId === keyId) {
        const nextId = this.findAvailable(state, keyId, new Set(), false);
        if (nextId) {
          state.currentKeyId = nextId;
          state.requestsOnCurrent = 0;
        }
      }
      state.updatedAt = now;
    });
  }

  async advance(): Promise<PoolSnapshot> {
    const now = this.clock.now();
    await this.store.transact((state) => {
      normalizeState(state, this.config, now);
      const nextId = this.findAvailable(state, state.currentKeyId, new Set(), false);
      if (nextId) state.currentKeyId = nextId;
      state.requestsOnCurrent = 0;
      state.updatedAt = now;
    });
    return this.snapshot();
  }

  async reset(): Promise<PoolSnapshot> {
    const now = this.clock.now();
    await this.store.transact((state) => {
      const fresh = createInitialPoolState(this.config, now);
      Object.assign(state, fresh);
    });
    return this.snapshot();
  }

  async snapshot(): Promise<PoolSnapshot> {
    const now = this.clock.now();
    return this.store.transact((state) => {
      normalizeState(state, this.config, now);
      return {
        currentKeyId: state.currentKeyId,
        requestsOnCurrent: state.requestsOnCurrent,
        requestsPerKey: this.config.requestsPerKey,
        totalAttempts: state.totalAttempts,
        updatedAt: state.updatedAt,
        keys: this.config.keys.map((key) => {
          const keyState = state.keys[key.id] ?? createKeyState();
          return {
            id: key.id,
            env: key.env,
            current: key.id === state.currentKeyId,
            available: this.isAvailable(state, key.id, now, new Set()),
            ...keyState,
          };
        }),
      };
    });
  }

  private isAvailable(state: PoolState, keyId: string, now: number, excluded: ReadonlySet<string>): boolean {
    if (excluded.has(keyId)) return false;
    const keyState = state.keys[keyId];
    return Boolean(keyState && !keyState.disabled && keyState.cooldownUntil <= now);
  }

  private findAvailable(
    state: PoolState,
    startId: string,
    excluded: ReadonlySet<string>,
    includeStart: boolean,
  ): string | null {
    const count = this.config.keys.length;
    if (count === 0) return null;
    const startIndex = Math.max(0, this.config.keys.findIndex((key) => key.id === startId));
    const firstOffset = includeStart ? 0 : 1;

    for (let step = firstOffset; step < count + firstOffset; step += 1) {
      const key = this.config.keys[(startIndex + step) % count];
      if (key && this.isAvailable(state, key.id, this.clock.now(), excluded)) return key.id;
    }
    return null;
  }
}
