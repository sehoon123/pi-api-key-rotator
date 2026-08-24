import { createHash } from "node:crypto";
import { StateCorruptionError } from "./state-store.ts";
import type { StateStore } from "./state-store.ts";
import type {
  Clock,
  KeyRuntimeState,
  PoolSnapshot,
  PoolState,
  ProviderResponseLike,
  RotatorConfig,
  SelectedKey,
  SelectionResult,
  TargetRuntimeState,
} from "./types.ts";

export const POOL_STATE_MAGIC = "pi-api-key-rotator-state" as const;
export const POOL_STATE_VERSION = 2 as const;
const PERSISTED_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_RETAINED_UNCONFIGURED_KEYS = 256;
const MAX_RETAINED_UNCONFIGURED_TARGETS = 128;
const MAX_PERSISTED_ENTRIES_TO_VALIDATE = 1_024;
const MAX_DATE_MS = 8_640_000_000_000_000;

const systemClock: Clock = { now: () => Date.now() };

function poolIdentity(config: RotatorConfig): string {
  return config.poolId ?? config.provider;
}

function activeConfigRevision(config: RotatorConfig): string {
  return config.configRevision ?? "0";
}

function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const fingerprintCache = new WeakMap<
  RotatorConfig,
  Map<string, { value: string; fingerprint: string }>
>();

function configuredFingerprint(config: RotatorConfig, keyId: string, value: string): string {
  let cached = fingerprintCache.get(config);
  if (!cached) {
    cached = new Map();
    fingerprintCache.set(config, cached);
  }
  const existing = cached.get(keyId);
  if (existing?.value === value) return existing.fingerprint;
  const fingerprint = credentialFingerprint(value);
  cached.set(keyId, { value, fingerprint });
  return fingerprint;
}

function validConfigRevision(value: string): boolean {
  return /^(?:0|[1-9]\d{0,39})$/u.test(value);
}

function compareRevisions(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function createKeyState(
  fingerprint: string | null = null,
  configRevision = "0",
): KeyRuntimeState {
  return {
    credentialFingerprint: fingerprint,
    configRevision,
    attempts: 0,
    successes: 0,
    failures: 0,
    lastOutcomeAttempt: 0,
    disabled: false,
    cooldownUntil: 0,
    lastStatus: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
}

function configuredTargetIds(config: RotatorConfig): string[] {
  const targets = config.targets?.length ? config.targets : [{ provider: config.provider, api: config.api }];
  return targets.map((target) => target.provider);
}

function createTargetState(): TargetRuntimeState {
  return {
    failures: 0,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    lastStatus: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    lastOutcomeAttempt: 0,
  };
}

export function createInitialPoolState(config: RotatorConfig, now: number, generation = 1): PoolState {
  return {
    magic: POOL_STATE_MAGIC,
    version: POOL_STATE_VERSION,
    poolId: poolIdentity(config),
    generation,
    currentKeyId: config.keys[0]?.id ?? "",
    requestsOnCurrent: 0,
    totalAttempts: 0,
    updatedAt: now,
    poolCooldownUntil: 0,
    poolLastSuccessAttempt: 0,
    keys: Object.fromEntries(
      config.keys.map((key) => [
        key.id,
        createKeyState(configuredFingerprint(config, key.id, key.value), activeConfigRevision(config)),
      ]),
    ),
    targets: Object.fromEntries(configuredTargetIds(config).map((id) => [id, createTargetState()])),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isTimestamp(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAX_DATE_MS;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isNullableStatus(value: unknown): value is number | null {
  return value === null || (isNonNegativeInteger(value) && value <= 599);
}

function stateProblem(stateFile: string, detail: string): StateCorruptionError {
  return new StateCorruptionError(stateFile, `${detail} The file was not overwritten.`);
}

function validatedKeyState(value: unknown, keyId: string, stateFile: string): KeyRuntimeState {
  if (!isRecord(value)) throw stateProblem(stateFile, `state for configured key "${keyId}" must be an object.`);
  const fingerprint = value.credentialFingerprint === undefined ? null : value.credentialFingerprint;
  const configRevision = value.configRevision === undefined ? "0" : value.configRevision;
  if (fingerprint !== null && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint))) {
    throw stateProblem(stateFile, `"keys.${keyId}.credentialFingerprint" is invalid.`);
  }
  if (typeof configRevision !== "string" || !validConfigRevision(configRevision)) {
    throw stateProblem(stateFile, `"keys.${keyId}.configRevision" is invalid.`);
  }
  if (!isNonNegativeInteger(value.attempts)) {
    throw stateProblem(stateFile, `"keys.${keyId}.attempts" must be a non-negative integer.`);
  }
  if (!isNonNegativeInteger(value.successes)) {
    throw stateProblem(stateFile, `"keys.${keyId}.successes" must be a non-negative integer.`);
  }
  if (!isNonNegativeInteger(value.failures)) {
    throw stateProblem(stateFile, `"keys.${keyId}.failures" must be a non-negative integer.`);
  }
  const lastOutcomeAttempt = value.lastOutcomeAttempt === undefined ? 0 : value.lastOutcomeAttempt;
  if (!isNonNegativeInteger(lastOutcomeAttempt)) {
    throw stateProblem(stateFile, `"keys.${keyId}.lastOutcomeAttempt" must be a non-negative integer.`);
  }
  if (typeof value.disabled !== "boolean") {
    throw stateProblem(stateFile, `"keys.${keyId}.disabled" must be boolean.`);
  }
  if (!isTimestamp(value.cooldownUntil)) {
    throw stateProblem(stateFile, `"keys.${keyId}.cooldownUntil" must be a non-negative integer.`);
  }
  if (!isNullableStatus(value.lastStatus)) {
    throw stateProblem(stateFile, `"keys.${keyId}.lastStatus" must be null or a non-negative integer.`);
  }
  if (!isNullableTimestamp(value.lastAttemptAt)) {
    throw stateProblem(stateFile, `"keys.${keyId}.lastAttemptAt" must be null or a non-negative integer.`);
  }
  if (!isNullableTimestamp(value.lastSuccessAt)) {
    throw stateProblem(stateFile, `"keys.${keyId}.lastSuccessAt" must be null or a non-negative integer.`);
  }
  if (!isNullableTimestamp(value.lastFailureAt)) {
    throw stateProblem(stateFile, `"keys.${keyId}.lastFailureAt" must be null or a non-negative integer.`);
  }

  // Reconstruct, rather than spreading, so unknown or secret-bearing fields are
  // never copied into a snapshot or the next persisted version.
  return {
    credentialFingerprint: fingerprint,
    configRevision,
    attempts: value.attempts,
    successes: value.successes,
    failures: value.failures,
    lastOutcomeAttempt,
    disabled: value.disabled,
    cooldownUntil: value.cooldownUntil,
    lastStatus: value.lastStatus,
    lastAttemptAt: value.lastAttemptAt,
    lastSuccessAt: value.lastSuccessAt,
    lastFailureAt: value.lastFailureAt,
  };
}

function validatedTargetState(value: unknown, stateFile: string): TargetRuntimeState {
  if (!isRecord(value)) throw stateProblem(stateFile, "persisted target state must be an object.");
  for (const field of ["failures", "consecutiveFailures", "lastOutcomeAttempt"] as const) {
    if (!isNonNegativeInteger(value[field])) {
      throw stateProblem(stateFile, `a persisted target ${field} must be a non-negative integer.`);
    }
  }
  if (!isTimestamp(value.cooldownUntil)) {
    throw stateProblem(stateFile, "a persisted target cooldownUntil is invalid.");
  }
  if (!isNullableStatus(value.lastStatus)) {
    throw stateProblem(stateFile, "a persisted target lastStatus must be null or a non-negative integer.");
  }
  if (!isNullableTimestamp(value.lastFailureAt) || !isNullableTimestamp(value.lastSuccessAt)) {
    throw stateProblem(stateFile, "persisted target timestamps must be null or non-negative integers.");
  }
  return {
    failures: Number(value.failures),
    consecutiveFailures: Number(value.consecutiveFailures),
    cooldownUntil: Number(value.cooldownUntil),
    lastStatus: value.lastStatus as number | null,
    lastFailureAt: value.lastFailureAt as number | null,
    lastSuccessAt: value.lastSuccessAt as number | null,
    lastOutcomeAttempt: Number(value.lastOutcomeAttempt),
  };
}

function validPersistedTargetId(value: string): boolean {
  if (value.length === 0 || value.length > 256 || /[\u0000-\u001F\u007F]/u.test(value)) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strictly validate v2 and migrate a valid v1 object in memory. This function
 * always builds a new object containing only fields understood by this version.
 */
function normalizeState(
  value: unknown,
  config: RotatorConfig,
  now: number,
  stateFile: string,
): PoolState {
  if (!isRecord(value)) throw stateProblem(stateFile, "root value must be a JSON object.");

  let generation: number;
  if (value.version === 1) {
    // v1 had no magic, pool identity, or generation. All other fields are
    // validated before the backward-compatible migration.
    generation = 1;
  } else if (value.version === POOL_STATE_VERSION) {
    if (value.magic !== POOL_STATE_MAGIC) {
      throw stateProblem(stateFile, `"magic" is not recognized for version ${POOL_STATE_VERSION}.`);
    }
    const expectedPoolId = poolIdentity(config);
    if (value.poolId !== expectedPoolId) {
      throw stateProblem(stateFile, "state does not match the active pool identity.");
    }
    if (!isPositiveInteger(value.generation)) {
      throw stateProblem(stateFile, '"generation" must be a positive integer.');
    }
    generation = value.generation;
  } else {
    throw stateProblem(stateFile, "the state version is unsupported or missing.");
  }

  if (typeof value.currentKeyId !== "string") {
    throw stateProblem(stateFile, '"currentKeyId" must be a string.');
  }
  if (!isNonNegativeInteger(value.requestsOnCurrent)) {
    throw stateProblem(stateFile, '"requestsOnCurrent" must be a non-negative integer.');
  }
  if (!isNonNegativeInteger(value.totalAttempts)) {
    throw stateProblem(stateFile, '"totalAttempts" must be a non-negative integer.');
  }
  if (!isTimestamp(value.updatedAt)) {
    throw stateProblem(stateFile, '"updatedAt" must be a non-negative integer.');
  }
  const poolCooldownUntil = value.poolCooldownUntil === undefined ? 0 : value.poolCooldownUntil;
  if (!isTimestamp(poolCooldownUntil)) {
    throw stateProblem(stateFile, '"poolCooldownUntil" must be a non-negative integer.');
  }
  const poolLastSuccessAttempt =
    value.poolLastSuccessAttempt === undefined ? 0 : value.poolLastSuccessAttempt;
  if (!isNonNegativeInteger(poolLastSuccessAttempt)) {
    throw stateProblem(stateFile, '"poolLastSuccessAttempt" must be a non-negative integer.');
  }
  if (!isRecord(value.keys)) throw stateProblem(stateFile, '"keys" must be an object.');
  const persistedTargets = value.targets === undefined ? {} : value.targets;
  if (!isRecord(persistedTargets)) throw stateProblem(stateFile, '"targets" must be an object.');

  if (!validConfigRevision(activeConfigRevision(config))) {
    throw stateProblem(stateFile, "the active configuration revision is invalid.");
  }
  const configuredIds = new Set(config.keys.map((key) => key.id));
  const keys: Record<string, KeyRuntimeState> = {};
  let currentCredentialReplaced = false;
  for (const key of config.keys) {
    const persisted = value.keys[key.id];
    const wantedFingerprint = configuredFingerprint(config, key.id, key.value);
    let normalized =
      persisted === undefined
        ? createKeyState(wantedFingerprint, activeConfigRevision(config))
        : validatedKeyState(persisted, key.id, stateFile);
    if (normalized.credentialFingerprint === null) {
      // One-time migration from state written before credential fencing existed.
      normalized.credentialFingerprint = wantedFingerprint;
      normalized.configRevision = activeConfigRevision(config);
    } else if (normalized.credentialFingerprint === wantedFingerprint) {
      if (compareRevisions(activeConfigRevision(config), normalized.configRevision) > 0) {
        normalized.configRevision = activeConfigRevision(config);
      }
    } else if (compareRevisions(activeConfigRevision(config), normalized.configRevision) > 0) {
      // A newer config owns this key ID. Reset key-specific health so an old
      // disabled/cooldown record cannot affect the replacement credential.
      normalized = createKeyState(wantedFingerprint, activeConfigRevision(config));
      if (value.currentKeyId === key.id) currentCredentialReplaced = true;
    }
    if (normalized.cooldownUntil <= now) normalized.cooldownUntil = 0;
    keys[key.id] = normalized;
  }
  // During a rolling config update, old and new processes can overlap. Preserve
  // strictly validated records for temporarily unconfigured IDs so an old
  // writer cannot erase a 401 disable recorded by the new configuration.
  const unconfiguredKeys = Object.entries(value.keys).filter(([persistedId]) => !configuredIds.has(persistedId));
  if (unconfiguredKeys.length > MAX_PERSISTED_ENTRIES_TO_VALIDATE) {
    throw stateProblem(stateFile, "too many unconfigured persisted key records are present.");
  }
  const retainedKeys = unconfiguredKeys.map(([persistedId, persisted]) => {
    if (!PERSISTED_KEY_ID_PATTERN.test(persistedId)) {
      throw stateProblem(stateFile, "an unconfigured persisted key ID is invalid.");
    }
    return [persistedId, validatedKeyState(persisted, persistedId, stateFile)] as const;
  });
  retainedKeys.sort(([leftId, left], [rightId, right]) => {
    const revisionOrder = compareRevisions(right.configRevision, left.configRevision);
    return revisionOrder !== 0 ? revisionOrder : leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  for (const [persistedId, normalized] of retainedKeys.slice(0, MAX_RETAINED_UNCONFIGURED_KEYS)) {
    if (normalized.cooldownUntil <= now) normalized.cooldownUntil = 0;
    keys[persistedId] = normalized;
  }

  const configuredTargets = new Set(configuredTargetIds(config));
  const targets: Record<string, TargetRuntimeState> = {};
  for (const targetId of configuredTargets) {
    const persisted = persistedTargets[targetId];
    const normalized = persisted === undefined ? createTargetState() : validatedTargetState(persisted, stateFile);
    if (normalized.cooldownUntil > 0 && normalized.cooldownUntil <= now) {
      normalized.cooldownUntil = 0;
      normalized.consecutiveFailures = 0;
    }
    targets[targetId] = normalized;
  }
  const unconfiguredTargets = Object.entries(persistedTargets)
    .filter(([targetId]) => !configuredTargets.has(targetId));
  if (unconfiguredTargets.length > MAX_PERSISTED_ENTRIES_TO_VALIDATE) {
    throw stateProblem(stateFile, "too many unconfigured persisted target records are present.");
  }
  const retainedTargets = unconfiguredTargets.map(([targetId, persisted]) => {
    if (!validPersistedTargetId(targetId)) {
      throw stateProblem(stateFile, "an unconfigured persisted target ID is invalid.");
    }
    return [targetId, validatedTargetState(persisted, stateFile)] as const;
  });
  retainedTargets.sort(([leftId], [rightId]) => leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
  for (const [targetId, normalized] of retainedTargets.slice(0, MAX_RETAINED_UNCONFIGURED_TARGETS)) {
    if (normalized.cooldownUntil > 0 && normalized.cooldownUntil <= now) {
      normalized.cooldownUntil = 0;
      normalized.consecutiveFailures = 0;
    }
    targets[targetId] = normalized;
  }

  if (poolLastSuccessAttempt > value.totalAttempts) {
    throw stateProblem(stateFile, '"poolLastSuccessAttempt" exceeds "totalAttempts".');
  }
  for (const keyState of Object.values(keys)) {
    if (
      keyState.attempts > value.totalAttempts ||
      keyState.lastOutcomeAttempt > value.totalAttempts
    ) {
      throw stateProblem(stateFile, "persisted key counters are internally inconsistent.");
    }
  }
  for (const targetState of Object.values(targets)) {
    if (targetState.lastOutcomeAttempt > value.totalAttempts) {
      throw stateProblem(stateFile, "a persisted target outcome exceeds total attempts.");
    }
  }

  let currentKeyId = value.currentKeyId;
  let requestsOnCurrent = value.requestsOnCurrent;
  if (!configuredIds.has(currentKeyId)) {
    currentKeyId = config.keys[0]?.id ?? "";
    requestsOnCurrent = 0;
  }
  if (currentCredentialReplaced || requestsOnCurrent >= config.requestsPerKey) requestsOnCurrent = 0;

  return {
    magic: POOL_STATE_MAGIC,
    version: POOL_STATE_VERSION,
    poolId: poolIdentity(config),
    generation,
    currentKeyId,
    requestsOnCurrent,
    totalAttempts: value.totalAttempts,
    updatedAt: value.updatedAt,
    poolCooldownUntil: poolCooldownUntil <= now ? 0 : poolCooldownUntil,
    poolLastSuccessAttempt,
    keys,
    targets,
  };
}

function replaceState(target: PoolState, replacement: PoolState): void {
  const record = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) delete record[key];
  Object.assign(record, replacement);
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
  const persistableMaximum = Math.max(
    0,
    Math.min(Number.MAX_SAFE_INTEGER, MAX_DATE_MS) - Math.max(0, Math.floor(now)),
  );
  const configuredMaximum = maximumMs > 0 ? maximumMs : persistableMaximum;
  return Math.min(
    Number.isSafeInteger(normalized) ? normalized : persistableMaximum,
    configuredMaximum,
    persistableMaximum,
  );
}

export class KeyPool {
  private readonly config: RotatorConfig;
  private readonly store: StateStore<PoolState>;
  private readonly clock: Clock;
  private readonly stateFileLabel: string;

  constructor(config: RotatorConfig, store: StateStore<PoolState>, clock: Clock = systemClock) {
    this.config = config;
    this.store = store;
    this.clock = clock;
    this.stateFileLabel =
      "stateFile" in store && typeof store.stateFile === "string" ? store.stateFile : config.stateFile;
  }

  /** Compatibility API. The returned key also carries its same-transaction snapshot. */
  async select(
    excludedKeyIds: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
    targetId = this.config.provider,
  ): Promise<SelectedKey | null> {
    return (await this.selectWithSnapshot(excludedKeyIds, signal, targetId)).selected;
  }

  /** Atomically select an attempt and return the post-selection view, even when none is available. */
  async selectWithSnapshot(
    excludedKeyIds: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
    targetId = this.config.provider,
  ): Promise<SelectionResult> {
    const now = this.clock.now();
    return this.store.transact((rawState) => {
      const state = normalizeState(rawState, this.config, now, this.stateFileLabel);
      if (
        signal?.aborted ||
        state.poolCooldownUntil > now ||
        !state.targets[targetId] ||
        state.targets[targetId].cooldownUntil > now
      ) {
        return { selected: null, snapshot: this.snapshotFromState(state, now) };
      }
      const selectedId = this.findAvailable(state, state.currentKeyId, excludedKeyIds, true, now);
      let selectedDefinition: RotatorConfig["keys"][number] | undefined;
      let attemptNumber = state.totalAttempts;

      if (selectedId) {
        if (state.currentKeyId !== selectedId) {
          state.currentKeyId = selectedId;
          state.requestsOnCurrent = 0;
        }

        const keyState = state.keys[selectedId];
        selectedDefinition = this.config.keys.find((key) => key.id === selectedId);
        if (keyState && selectedDefinition) {
          keyState.attempts += 1;
          keyState.lastAttemptAt = now;
          state.totalAttempts += 1;
          state.requestsOnCurrent += 1;
          state.updatedAt = now;
          attemptNumber = state.totalAttempts;

          if (state.requestsOnCurrent >= this.config.requestsPerKey) {
            const nextId = this.findAvailable(state, selectedId, new Set(), false, now) ?? selectedId;
            state.currentKeyId = nextId;
            state.requestsOnCurrent = 0;
          }
        } else {
          selectedDefinition = undefined;
        }
      }

      replaceState(rawState, state);
      const snapshot = this.snapshotFromState(state, now);
      if (!selectedDefinition) return { selected: null, snapshot };

      const selected: SelectedKey = {
        id: selectedDefinition.id,
        ...(selectedDefinition.source === undefined ? {} : { source: selectedDefinition.source }),
        env: selectedDefinition.env,
        value: selectedDefinition.value,
        ordinal: this.config.keys.findIndex((key) => key.id === selectedDefinition.id),
        attemptNumber,
        targetId,
        credentialFingerprint: configuredFingerprint(
          this.config,
          selectedDefinition.id,
          selectedDefinition.value,
        ),
        epoch: state.generation,
        snapshot,
      };
      return { selected, snapshot };
    }, signal === undefined ? {} : { signal });
  }

  async recordSuccess(
    keyId: string,
    status: number,
    epoch?: number,
    targetId = this.config.provider,
    attemptNumber?: number,
    expectedCredentialFingerprint?: string,
  ): Promise<PoolSnapshot> {
    const now = this.clock.now();
    return this.mutateWithSnapshot(now, (state) => {
      if (epoch !== undefined && epoch !== state.generation) return;
      const outcomeAttempt = attemptNumber ?? state.totalAttempts;
      const keyState = state.keys[keyId];
      if (
        !keyState ||
        (expectedCredentialFingerprint !== undefined &&
          keyState.credentialFingerprint !== expectedCredentialFingerprint)
      ) return;
      keyState.successes += 1;
      if (outcomeAttempt >= keyState.lastOutcomeAttempt) {
        keyState.lastOutcomeAttempt = outcomeAttempt;
        keyState.lastStatus = status;
        keyState.lastSuccessAt = now;
        keyState.disabled = false;
        keyState.cooldownUntil = 0;
      }

      const target = state.targets[targetId];
      if (target && outcomeAttempt >= target.lastOutcomeAttempt) {
        target.lastOutcomeAttempt = outcomeAttempt;
        target.lastSuccessAt = now;
        target.lastStatus = status;
        target.consecutiveFailures = 0;
        target.cooldownUntil = 0;
      }
      if (outcomeAttempt >= state.poolLastSuccessAttempt) {
        state.poolLastSuccessAttempt = outcomeAttempt;
        state.poolCooldownUntil = 0;
      }
      state.updatedAt = now;
    });
  }

  async recordFailure(
    keyId: string,
    response: ProviderResponseLike,
    epoch?: number,
    targetId = this.config.provider,
    attemptNumber?: number,
    expectedCredentialFingerprint?: string,
  ): Promise<PoolSnapshot> {
    const now = this.clock.now();
    return this.mutateWithSnapshot(now, (state) => {
      if (epoch !== undefined && epoch !== state.generation) return;
      const outcomeAttempt = attemptNumber ?? state.totalAttempts;
      const keyState = state.keys[keyId];
      if (
        !keyState ||
        (expectedCredentialFingerprint !== undefined &&
          keyState.credentialFingerprint !== expectedCredentialFingerprint)
      ) return;

      keyState.failures += 1;
      const currentKeyOutcome = outcomeAttempt >= keyState.lastOutcomeAttempt;
      if (currentKeyOutcome) {
        keyState.lastOutcomeAttempt = outcomeAttempt;
        keyState.lastStatus = response.status;
        keyState.lastFailureAt = now;
      }

      if (this.config.disableStatuses.has(response.status)) {
        // Authentication and permission failures belong to the selected key.
        if (currentKeyOutcome) {
          keyState.disabled = true;
          keyState.cooldownUntil = 0;
        }
      } else if (this.config.cooldownStatuses.has(response.status)) {
        const delayMs = parseRetryAfterMs(
          response.headers,
          now,
          this.config.cooldownMs,
          this.config.maxRetryAfterMs,
        );
        if ((this.config.rateLimitScope ?? "key") === "key") {
          if (currentKeyOutcome) {
            keyState.cooldownUntil = Math.max(keyState.cooldownUntil, now + delayMs);
          }
        } else if (this.config.rateLimitScope === "target") {
          this.recordTargetFailure(state, targetId, response.status, outcomeAttempt, now, delayMs, true);
        } else if (outcomeAttempt >= state.poolLastSuccessAttempt) {
          state.poolCooldownUntil = Math.max(state.poolCooldownUntil, now + delayMs);
        }
      } else if (this.config.retryStatuses.has(response.status)) {
        // 5xx/transient failures are target health, not credential health.
        this.recordTargetFailure(
          state,
          targetId,
          response.status,
          outcomeAttempt,
          now,
          this.config.transientCooldownMs,
          false,
        );
      }

      if (state.currentKeyId === keyId && !this.isAvailable(state, keyId, now, new Set())) {
        const nextId = this.findAvailable(state, keyId, new Set(), false, now);
        if (nextId) {
          state.currentKeyId = nextId;
          state.requestsOnCurrent = 0;
        }
      }
      state.updatedAt = now;
    });
  }

  async recordNetworkFailure(
    keyId: string,
    epoch?: number,
    targetId = this.config.provider,
    attemptNumber?: number,
    expectedCredentialFingerprint?: string,
  ): Promise<PoolSnapshot> {
    const now = this.clock.now();
    return this.mutateWithSnapshot(now, (state) => {
      if (epoch !== undefined && epoch !== state.generation) return;
      const outcomeAttempt = attemptNumber ?? state.totalAttempts;
      const keyState = state.keys[keyId];
      if (
        !keyState ||
        (expectedCredentialFingerprint !== undefined &&
          keyState.credentialFingerprint !== expectedCredentialFingerprint)
      ) return;
      keyState.failures += 1;
      if (outcomeAttempt >= keyState.lastOutcomeAttempt) {
        keyState.lastOutcomeAttempt = outcomeAttempt;
        keyState.lastStatus = null;
        keyState.lastFailureAt = now;
      }
      this.recordTargetFailure(
        state,
        targetId,
        null,
        outcomeAttempt,
        now,
        this.config.transientCooldownMs,
        false,
      );
      state.updatedAt = now;
    });
  }

  async advance(): Promise<PoolSnapshot> {
    const now = this.clock.now();
    return this.mutateWithSnapshot(now, (state) => {
      const nextId = this.findAvailable(state, state.currentKeyId, new Set(), false, now);
      if (nextId) state.currentKeyId = nextId;
      state.requestsOnCurrent = 0;
      state.updatedAt = now;
    });
  }

  async reset(): Promise<PoolSnapshot> {
    const now = this.clock.now();
    return this.store.transact((rawState) => {
      const previous = normalizeState(rawState, this.config, now, this.stateFileLabel);
      if (previous.generation >= Number.MAX_SAFE_INTEGER) {
        throw stateProblem(this.stateFileLabel, '"generation" is exhausted and cannot be safely advanced.');
      }
      const fresh = createInitialPoolState(this.config, now, previous.generation + 1);
      replaceState(rawState, fresh);
      return this.snapshotFromState(fresh, now);
    });
  }

  /** Read and normalize in memory only. No transaction, lock file, or durable write. */
  async snapshot(): Promise<PoolSnapshot> {
    const now = this.clock.now();
    const rawState = await this.store.read();
    const state = normalizeState(rawState, this.config, now, this.stateFileLabel);
    return this.snapshotFromState(state, now);
  }

  private recordTargetFailure(
    state: PoolState,
    targetId: string,
    status: number | null,
    attemptNumber: number,
    now: number,
    cooldownMs: number,
    immediate: boolean,
  ): void {
    const target = state.targets[targetId];
    if (!target) return;
    target.failures += 1;
    if (attemptNumber < target.lastOutcomeAttempt) return;
    target.lastOutcomeAttempt = attemptNumber;
    target.lastStatus = status;
    target.lastFailureAt = now;
    target.consecutiveFailures += 1;
    if (immediate || target.consecutiveFailures >= (this.config.targetFailureThreshold ?? 2)) {
      target.cooldownUntil = Math.max(target.cooldownUntil, now + cooldownMs);
    }
  }

  private async mutateWithSnapshot(
    now: number,
    mutator: (state: PoolState) => void,
  ): Promise<PoolSnapshot> {
    return this.store.transact((rawState) => {
      const state = normalizeState(rawState, this.config, now, this.stateFileLabel);
      mutator(state);
      replaceState(rawState, state);
      return this.snapshotFromState(state, now);
    });
  }

  private snapshotFromState(state: PoolState, now: number): PoolSnapshot {
    return {
      generation: state.generation,
      currentKeyId: state.currentKeyId,
      requestsOnCurrent: state.requestsOnCurrent,
      requestsPerKey: this.config.requestsPerKey,
      totalAttempts: state.totalAttempts,
      updatedAt: state.updatedAt,
      poolCooldownUntil: state.poolCooldownUntil,
      keys: this.config.keys.map((key) => {
        const keyState = state.keys[key.id] ?? createKeyState();
        const {
          credentialFingerprint: _credentialFingerprint,
          configRevision: _configRevision,
          lastOutcomeAttempt: _lastOutcomeAttempt,
          ...publicState
        } = keyState;
        return {
          id: key.id,
          ...(key.source === undefined ? {} : { source: key.source }),
          env: key.env,
          current: key.id === state.currentKeyId,
          available: this.isAvailable(state, key.id, now, new Set()),
          ...publicState,
        };
      }),
      targets: configuredTargetIds(this.config).map((id) => {
        const target = state.targets[id] ?? createTargetState();
        return { id, available: state.poolCooldownUntil <= now && target.cooldownUntil <= now, ...target };
      }),
    };
  }

  private isAvailable(state: PoolState, keyId: string, now: number, excluded: ReadonlySet<string>): boolean {
    if (excluded.has(keyId)) return false;
    const keyState = state.keys[keyId];
    const definition = this.config.keys.find((key) => key.id === keyId);
    return Boolean(
      state.poolCooldownUntil <= now &&
        keyState &&
        definition &&
        keyState.credentialFingerprint ===
          configuredFingerprint(this.config, definition.id, definition.value) &&
        !keyState.disabled &&
        keyState.cooldownUntil <= now,
    );
  }

  private findAvailable(
    state: PoolState,
    startId: string,
    excluded: ReadonlySet<string>,
    includeStart: boolean,
    now: number,
  ): string | null {
    const count = this.config.keys.length;
    if (count === 0) return null;
    const startIndex = Math.max(0, this.config.keys.findIndex((key) => key.id === startId));
    const firstOffset = includeStart ? 0 : 1;

    for (let step = firstOffset; step < count + firstOffset; step += 1) {
      const key = this.config.keys[(startIndex + step) % count];
      if (key && this.isAvailable(state, key.id, now, excluded)) return key.id;
    }
    return null;
  }
}
