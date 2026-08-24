import { isUtf8 } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import {
  DEFAULT_CONFIG_FILE_TEMPLATE,
  defaultStateFile,
  expandHome,
  inspectConfigFile,
  MAX_SECRET_UTF8_BYTES,
  runShellCommand,
  selectConfigPath,
} from "./pi-host.ts";
import type { CommandRunner } from "./pi-host.ts";
import type {
  KeySource,
  RateLimitScope,
  RawRotatorConfig,
  ResolvedKeyDefinition,
  RotatorConfig,
  RotatorTarget,
} from "./types.ts";

const DEFAULT_RETRY_STATUSES = [401, 402, 403, 408, 409, 425, 429, 500, 502, 503, 504] as const;
const DEFAULT_DISABLE_STATUSES = [401, 402, 403] as const;
const DEFAULT_COOLDOWN_STATUSES = [429] as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SECRET_LENGTH = 65_536;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_TARGET_NAME_LENGTH = 256;
const MAX_STATE_PATH_LENGTH = 4_096;
const MAX_STATUS_ENTRIES = 500;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STATE_FILE_BYTES = 1_048_576;

export const SUPPORTED_CONFIG_VERSION = 1 as const;
export const MAX_CONFIG_BYTES = 1_048_576;
export const MAX_KEYS = 256;
export const MAX_TARGETS = 128;
export const MAX_COMMAND_KEYS = 64;
export const MAX_COMMAND_TIMEOUT_BUDGET_MS = 600_000;

let lastConfigLoadMarker = 0n;

function rollingConfigRevision(fileRevisionNs: bigint): string {
  const wallMarker = BigInt(Date.now());
  lastConfigLoadMarker = wallMarker > lastConfigLoadMarker ? wallMarker : lastConfigLoadMarker + 1n;
  const filePart = fileRevisionNs.toString().padStart(22, "0");
  const loadPart = lastConfigLoadMarker.toString().padStart(17, "0");
  if (filePart.length > 22 || loadPart.length > 17) {
    throw new Error("The local clock cannot be represented as a rolling config revision.");
  }
  // Leading sentinel keeps the fixed-width tuple a canonical decimal string.
  return `1${filePart}${loadPart}`;
}

export const POOL_FIELDS = [
  "poolId",
  "provider",
  "api",
  "targets",
  "keys",
  "requestsPerKey",
  "maxAttemptsPerRequest",
  "cooldownMs",
  "transientCooldownMs",
  "maxRetryAfterMs",
  "retryStatuses",
  "disableStatuses",
  "cooldownStatuses",
  "rateLimitScope",
  "targetFailureThreshold",
  "retryNetworkErrors",
  "stateFile",
  "lockTimeoutMs",
  "staleLockMs",
  "maxStateFileBytes",
] as const;

export const SINGLE_POOL_ROOT_FIELDS = ["configVersion", ...POOL_FIELDS] as const;

/** Documented default, still written with `~`. See pi-host.ts for the real path. */
export const DEFAULT_CONFIG_FILE = DEFAULT_CONFIG_FILE_TEMPLATE;

export class ConfigNotFoundError extends Error {
  readonly configFile: string;

  constructor(configFile: string) {
    super(`Configuration file not found: ${configFile}`);
    this.name = "ConfigNotFoundError";
    this.configFile = configFile;
  }
}

export class ConfigValidationError extends Error {
  readonly configFile: string;

  constructor(configFile: string, message: string) {
    super(`Invalid key rotator configuration (${configFile}): ${message}`);
    this.name = "ConfigValidationError";
    this.configFile = configFile;
  }
}

export class ConfigSecurityError extends Error {
  readonly configFile: string;

  constructor(configFile: string, message: string) {
    super(`Unsafe key rotator configuration file (${configFile}): ${message}`);
    this.name = "ConfigSecurityError";
    this.configFile = configFile;
  }
}

export interface LoadConfigOptions {
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Receives non-fatal metadata warnings, such as a group-readable mode. */
  warn?: (message: string) => void;
  /** Cancels a running command-backed key during load. */
  signal?: AbortSignal;
  /** Injected in tests. Defaults to a real shell command. */
  runCommand?: CommandRunner;
}

function resolvePath(input: string, homeDir: string, baseDir?: string): string {
  const expanded = expandHome(input, homeDir);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(baseDir ?? process.cwd(), expanded);
}

function canonicalPath(input: string): string {
  // Being case-insensitive here is deliberately stricter on Linux. It avoids a
  // configuration that becomes destructive when copied to Windows or macOS.
  return normalize(resolve(input)).replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

function rejectStateConfigCollision(stateFile: string, configFile: string): void {
  const configPath = canonicalPath(configFile);
  const stateArtifacts = [stateFile, `${stateFile}.lock`, `${stateFile}.lock.reclaim`, `${stateFile}.bak`];
  if (stateArtifacts.some((candidate) => canonicalPath(candidate) === configPath)) {
    throw new ConfigValidationError(
      configFile,
      '"stateFile" and its lock/backup files must not resolve to the configuration file.',
    );
  }
}

interface PhysicalPathIdentity {
  canonical: string;
  inode?: string;
}

/** FAT/exFAT and some Windows/network filesystems use zero when inode identity is unavailable. */
export function physicalInodeIdentity(dev: bigint, ino: bigint): string | undefined {
  return ino === 0n ? undefined : `${dev}:${ino}`;
}

async function physicalPathIdentity(input: string, configFile: string): Promise<PhysicalPathIdentity> {
  let cursor = resolve(input);
  const missingSuffix: string[] = [];
  while (true) {
    try {
      const entry = await lstat(cursor);
      if (missingSuffix.length > 0 && !entry.isDirectory()) {
        throw new ConfigValidationError(
          configFile,
          `A state path ancestor is not a directory: ${cursor}`,
        );
      }
      if (missingSuffix.length === 0 && !entry.isFile()) {
        throw new ConfigValidationError(
          configFile,
          `An existing config/state artifact is not a regular file: ${cursor}`,
        );
      }
      if (missingSuffix.length === 0 && process.platform !== "win32") {
        const effectiveUid = process.geteuid?.() ?? process.getuid?.();
        if (effectiveUid === undefined || entry.uid !== effectiveUid || (entry.mode & 0o022) !== 0) {
          throw new ConfigValidationError(
            configFile,
            `An existing config/state artifact has unsafe ownership or write permissions: ${cursor}`,
          );
        }
      }
      const resolvedAncestor = await realpath(cursor);
      const canonical = canonicalPath(resolve(resolvedAncestor, ...missingSuffix)).normalize("NFC");
      if (missingSuffix.length > 0) return { canonical };
      const metadata = await stat(resolvedAncestor, { bigint: true });
      const inode = physicalInodeIdentity(metadata.dev, metadata.ino);
      return { canonical, ...(inode === undefined ? {} : { inode }) };
    } catch (error) {
      if (error instanceof ConfigValidationError) throw error;
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSuffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Resolve symlinked ancestors and existing inode aliases before any command key
 * is executed. This closes lexical `stateFile` collision bypasses that could
 * otherwise turn the config itself into a stale lock or backup destination.
 */
export async function validatePhysicalStatePaths(
  pools: readonly RotatorConfig[],
  configFile: string,
): Promise<void> {
  const canonicalOwners = new Map<string, string>();
  const inodeOwners = new Map<string, string>();

  const add = async (path: string, owner: string): Promise<void> => {
    const identity = await physicalPathIdentity(path, configFile);
    const previous = canonicalOwners.get(identity.canonical) ??
      (identity.inode === undefined ? undefined : inodeOwners.get(identity.inode));
    if (previous) {
      throw new ConfigValidationError(
        configFile,
        `Filesystem paths for ${previous} and ${owner} resolve to the same file or location.`,
      );
    }
    canonicalOwners.set(identity.canonical, owner);
    if (identity.inode !== undefined) inodeOwners.set(identity.inode, owner);
  };

  await add(configFile, "the configuration file");
  for (const config of pools) {
    const id = config.poolId ?? config.provider;
    await add(config.stateFile, `pool "${id}" state`);
    await add(`${config.stateFile}.lock`, `pool "${id}" lock`);
    await add(`${config.stateFile}.lock.reclaim`, `pool "${id}" lock reclaim`);
    await add(`${config.stateFile}.bak`, `pool "${id}" backup`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const insertion = (current[rightIndex - 1] ?? leftIndex) + 1;
      const deletion = (previous[rightIndex] ?? rightIndex) + 1;
      const substitution =
        (previous[rightIndex - 1] ?? rightIndex - 1) +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current.push(Math.min(insertion, deletion, substitution));
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function suggestedField(name: string, allowed: readonly string[]): string | undefined {
  // Avoid quadratic work on an attacker-sized unknown property name.
  const normalized = name.slice(0, 128).toLocaleLowerCase("en-US");
  let best: { field: string; distance: number } | undefined;
  for (const candidate of allowed) {
    const distance = editDistance(normalized, candidate.toLocaleLowerCase("en-US"));
    if (!best || distance < best.distance) best = { field: candidate, distance };
  }
  if (!best) return undefined;
  const threshold = normalized.length >= 12 ? 3 : normalized.length >= 5 ? 2 : 1;
  return best.distance <= threshold ? best.field : undefined;
}

/** Reject unknown object keys without inspecting or rendering their values. */
export function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
  configFile: string,
): void {
  const unknown = Object.keys(record).find((name) => !allowed.includes(name));
  if (unknown === undefined) return;
  const suggestion = suggestedField(unknown, allowed);
  throw new ConfigValidationError(
    configFile,
    `Unknown field in ${location}; its name was omitted to avoid leaking secret material.` +
      (suggestion === undefined ? "" : ` Did you mean ${JSON.stringify(suggestion)}?`),
  );
}

export function validateConfigVersion(record: Record<string, unknown>, configFile: string): void {
  if (!Object.hasOwn(record, "configVersion")) return;
  if (record.configVersion !== SUPPORTED_CONFIG_VERSION) {
    throw new ConfigValidationError(
      configFile,
      `"configVersion" must be the supported integer version ${SUPPORTED_CONFIG_VERSION}.`,
    );
  }
}

function requireString(value: unknown, field: string, configFile: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigValidationError(configFile, `"${field}" must be a non-empty string.`);
  }
  return value.trim();
}

function requireDisplayString(
  value: unknown,
  field: string,
  maximumLength: number,
  configFile: string,
): string {
  const resolved = requireString(value, field, configFile);
  if (resolved.length > maximumLength) {
    throw new ConfigValidationError(configFile, `"${field}" exceeds the maximum supported length.`);
  }
  if (!hasWellFormedUnicode(resolved)) {
    throw new ConfigValidationError(configFile, `"${field}" must contain well-formed Unicode.`);
  }
  if (/[\u0000-\u001F\u007F]/u.test(resolved)) {
    throw new ConfigValidationError(configFile, `"${field}" must not contain control characters.`);
  }
  return resolved;
}

function requireIdentifier(value: unknown, field: string, configFile: string): string {
  const identifier = requireString(value, field, configFile);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new ConfigValidationError(
      configFile,
      `"${field}" must be 1-64 characters using letters, digits, dot, underscore, or hyphen.`,
    );
  }
  return identifier;
}

function defaultPoolId(provider: string): string {
  const sanitized = provider
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/g, "")
    .slice(0, 64);
  return IDENTIFIER_PATTERN.test(sanitized) ? sanitized : "default";
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requireSecret(value: unknown, field: string, configFile: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new ConfigValidationError(configFile, `"${field}" must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new ConfigValidationError(configFile, `"${field}" must not contain leading or trailing whitespace.`);
  }
  if (!hasWellFormedUnicode(value)) {
    throw new ConfigValidationError(configFile, `"${field}" must contain well-formed Unicode.`);
  }
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new ConfigValidationError(configFile, `"${field}" must not contain control characters.`);
  }
  if (value.length > MAX_SECRET_LENGTH || Buffer.byteLength(value, "utf8") > MAX_SECRET_UTF8_BYTES) {
    throw new ConfigValidationError(
      configFile,
      `"${field}" exceeds the supported character or UTF-8 byte limit.`,
    );
  }
  return value;
}

function minimumStateFileBytes(
  poolId: string,
  keys: readonly ResolvedKeyDefinition[],
  targets: readonly RotatorTarget[],
): number {
  const maximum = Number.MAX_SAFE_INTEGER;
  const keyState = {
    credentialFingerprint: "f".repeat(64),
    configRevision: "9".repeat(40),
    attempts: maximum,
    successes: maximum,
    failures: maximum,
    lastOutcomeAttempt: maximum,
    disabled: true,
    cooldownUntil: maximum,
    lastStatus: 599,
    lastAttemptAt: maximum,
    lastSuccessAt: maximum,
    lastFailureAt: maximum,
  };
  const targetState = {
    failures: maximum,
    consecutiveFailures: maximum,
    cooldownUntil: maximum,
    lastStatus: 599,
    lastFailureAt: maximum,
    lastSuccessAt: maximum,
    lastOutcomeAttempt: maximum,
  };
  const keyEntries = keys.map((key) => [key.id, keyState] as const);
  const keyIds = new Set(keyEntries.map(([id]) => id));
  for (let index = 0; keyEntries.length < keys.length + MAX_KEYS; index += 1) {
    const id = `${"r".repeat(58)}${index.toString(36).padStart(6, "0")}`;
    if (!keyIds.has(id)) {
      keyIds.add(id);
      keyEntries.push([id, keyState]);
    }
  }
  const targetEntries = targets.map((target) => [target.provider, targetState] as const);
  const targetIds = new Set(targetEntries.map(([id]) => id));
  for (let index = 0; targetEntries.length < targets.length + MAX_TARGETS; index += 1) {
    // U+0800..U+08FF are valid three-byte UTF-8 code points. A 256-code-unit
    // provider ID built from them is the largest JSON object key accepted by
    // requireDisplayString; backslashes account for only two bytes each.
    const id = `${"\u0800".repeat(255)}${String.fromCharCode(0x0800 + index)}`;
    if (!targetIds.has(id)) {
      targetIds.add(id);
      targetEntries.push([id, targetState]);
    }
  }
  const probe = {
    magic: "pi-api-key-rotator-state",
    version: 2,
    poolId,
    generation: maximum,
    currentKeyId: keys[0]?.id ?? "",
    requestsOnCurrent: maximum,
    totalAttempts: maximum,
    updatedAt: maximum,
    poolCooldownUntil: maximum,
    poolLastSuccessAttempt: maximum,
    keys: Object.fromEntries(keyEntries),
    targets: Object.fromEntries(targetEntries),
  };
  const maximumState = Buffer.byteLength(`${JSON.stringify(probe, null, 2)}\n`, "utf8");
  return maximumState + 1_024;
}

function integerInRange(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
  configFile: string,
): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || (resolved as number) < min || (resolved as number) > max) {
    throw new ConfigValidationError(configFile, `"${field}" must be an integer from ${min} to ${max}.`);
  }
  return resolved as number;
}

function booleanValue(value: unknown, fallback: boolean, field: string, configFile: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigValidationError(configFile, `"${field}" must be true or false.`);
  }
  return value;
}

function rateLimitScopeValue(value: unknown, configFile: string): RateLimitScope {
  if (value === undefined) return "key";
  if (value === "key" || value === "target" || value === "pool") return value;
  throw new ConfigValidationError(configFile, '"rateLimitScope" must be "key", "target", or "pool".');
}

function statusSet(
  value: unknown,
  fallback: readonly number[],
  field: string,
  configFile: string,
  options: { allowEmpty?: boolean } = {},
): ReadonlySet<number> {
  const input = value === undefined ? fallback : value;
  if (!Array.isArray(input) || (!options.allowEmpty && input.length === 0)) {
    throw new ConfigValidationError(
      configFile,
      `"${field}" must be ${options.allowEmpty ? "an" : "a non-empty"} array of HTTP status codes.`,
    );
  }
  if (input.length > MAX_STATUS_ENTRIES) {
    throw new ConfigValidationError(configFile, `"${field}" contains too many HTTP status entries.`);
  }

  const result = new Set<number>();
  for (const status of input) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      // Do not render the entry: it can be an arbitrary string or object.
      throw new ConfigValidationError(
        configFile,
        `"${field}" contains an invalid HTTP status code; entries must be integers from 100 to 599.`,
      );
    }
    result.add(status);
  }
  return result;
}

function ensureSubset(
  subset: ReadonlySet<number>,
  superset: ReadonlySet<number>,
  subsetName: string,
  supersetName: string,
  configFile: string,
): void {
  for (const status of subset) {
    if (!superset.has(status)) {
      throw new ConfigValidationError(
        configFile,
        `Every status in "${subsetName}" must also appear in "${supersetName}".`,
      );
    }
  }
}

function ensureDisjoint(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
  leftName: string,
  rightName: string,
  configFile: string,
): void {
  for (const status of left) {
    if (right.has(status)) {
      throw new ConfigValidationError(
        configFile,
        `"${leftName}" and "${rightName}" must not overlap.`,
      );
    }
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function securityRefusalMessage(refusal: "not-regular" | "wrong-owner" | "writable-by-others", mode?: number): string {
  if (refusal === "not-regular") {
    return "The path must be a regular file; symbolic links and special files are refused.";
  }
  if (refusal === "wrong-owner") {
    return "The file must be owned by the current operating-system user.";
  }
  const modeDetail = mode === undefined ? "" : ` (mode ${mode.toString(8).padStart(3, "0")})`;
  return `The file must not be writable by group or other users${modeDetail}.`;
}

export interface SecureConfigFile {
  text: string;
  /** Monotonic-enough local revision used only to order rolling config owners. */
  revision: string;
  warning?: string;
}

/** lstat, validate metadata, then open without following a POSIX symlink. */
export async function readConfigFileSecurely(configFile: string): Promise<SecureConfigFile> {
  let inspected;
  try {
    inspected = await inspectConfigFile(configFile);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") throw new ConfigNotFoundError(configFile);
    throw error;
  }

  if (inspected.refusal) {
    throw new ConfigSecurityError(
      configFile,
      securityRefusalMessage(inspected.refusal, inspected.mode),
    );
  }
  if (inspected.size > MAX_CONFIG_BYTES) {
    throw new ConfigValidationError(configFile, `The config file exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
  }

  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(configFile, flags);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ELOOP") {
      throw new ConfigSecurityError(
        configFile,
        "The path must be a regular file; symbolic links and special files are refused.",
      );
    }
    if (code === "ENOENT") {
      throw new ConfigSecurityError(configFile, "The file changed while its security metadata was being validated.");
    }
    throw error;
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new ConfigSecurityError(
        configFile,
        "The path must be a regular file; symbolic links and special files are refused.",
      );
    }
    if (opened.dev !== inspected.dev || opened.ino !== inspected.ino) {
      throw new ConfigSecurityError(
        configFile,
        "The file changed while its security metadata was being validated.",
      );
    }
    if (process.platform !== "win32") {
      const mode = Number(opened.mode & 0o777n);
      const effectiveUid = process.geteuid?.() ?? process.getuid?.();
      if (effectiveUid === undefined || Number(opened.uid) !== effectiveUid) {
        throw new ConfigSecurityError(
          configFile,
          "The file must be owned by the current operating-system user.",
        );
      }
      if ((mode & 0o022) !== 0) {
        throw new ConfigSecurityError(
          configFile,
          securityRefusalMessage("writable-by-others", mode),
        );
      }
    }
    if (opened.size > BigInt(MAX_CONFIG_BYTES)) {
      throw new ConfigValidationError(configFile, `The config file exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
    }

    const contents = await handle.readFile();
    if (contents.byteLength > MAX_CONFIG_BYTES) {
      throw new ConfigValidationError(configFile, `The config file exceeds the ${MAX_CONFIG_BYTES}-byte limit.`);
    }
    if (!isUtf8(contents)) {
      throw new ConfigValidationError(configFile, "The config file must contain valid UTF-8 text.");
    }
    return {
      text: contents.toString("utf8"),
      revision: rollingConfigRevision(opened.ctimeNs > opened.mtimeNs ? opened.ctimeNs : opened.mtimeNs),
      ...(inspected.warning === undefined ? {} : { warning: inspected.warning }),
    };
  } finally {
    await handle.close();
  }
}

function safeJsonParseDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lineColumn = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColumn) return `JSON parsing failed near line ${lineColumn[1]}, column ${lineColumn[2]}.`;

  const position = message.match(/position\s+(\d+)/i);
  if (position) return `JSON parsing failed near character ${position[1]}.`;
  return "JSON parsing failed.";
}

function parseJson(text: string, configFile: string): RawRotatorConfig {
  let parsed: unknown;
  try {
    // UTF-8 BOMs are common in files written by some Windows editors.
    const normalizedText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    parsed = JSON.parse(normalizedText);
  } catch (error) {
    // Node may include a source excerpt in SyntaxError messages. A literal API
    // key can appear in that excerpt, so only retain non-secret location data.
    throw new ConfigValidationError(configFile, safeJsonParseDetail(error));
  }

  if (!isRecord(parsed)) {
    throw new ConfigValidationError(configFile, "The root value must be a JSON object.");
  }
  return parsed as unknown as RawRotatorConfig;
}

function resolveTargets(raw: RawRotatorConfig, configFile: string): RotatorTarget[] {
  const hasTargets = Object.hasOwn(raw, "targets");
  const hasProvider = Object.hasOwn(raw, "provider");
  const hasApi = Object.hasOwn(raw, "api");

  if (hasTargets && (hasProvider || hasApi)) {
    throw new ConfigValidationError(
      configFile,
      'Use either legacy "provider"/"api" fields or the "targets" array, not both.',
    );
  }

  let targets: RotatorTarget[];
  if (hasTargets) {
    if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
      throw new ConfigValidationError(configFile, '"targets" must contain at least one provider/API definition.');
    }
    if (raw.targets.length > MAX_TARGETS) {
      throw new ConfigValidationError(configFile, `"targets" supports at most ${MAX_TARGETS} entries.`);
    }

    targets = raw.targets.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new ConfigValidationError(configFile, `targets[${index}] must be an object.`);
      }
      rejectUnknownFields(entry, ["provider", "api"], `targets[${index}]`, configFile);
      return {
        provider: requireDisplayString(
          entry.provider,
          `targets[${index}].provider`,
          MAX_TARGET_NAME_LENGTH,
          configFile,
        ),
        api: requireDisplayString(entry.api, `targets[${index}].api`, MAX_TARGET_NAME_LENGTH, configFile),
      };
    });
  } else {
    if (hasProvider !== hasApi) {
      throw new ConfigValidationError(configFile, 'Legacy "provider" and "api" must be specified together.');
    }
    if (!hasProvider) {
      throw new ConfigValidationError(
        configFile,
        'Specify either legacy "provider"/"api" fields or a non-empty "targets" array.',
      );
    }
    targets = [
      {
        provider: requireDisplayString(raw.provider, "provider", MAX_TARGET_NAME_LENGTH, configFile),
        api: requireDisplayString(raw.api, "api", MAX_TARGET_NAME_LENGTH, configFile),
      },
    ];
  }

  const providerIds = new Set<string>();
  for (const target of targets) {
    if (providerIds.has(target.provider)) {
      throw new ConfigValidationError(
        configFile,
        `Provider "${target.provider}" appears more than once in "targets". Each Pi provider can be registered only once.`,
      );
    }
    providerIds.add(target.provider);
  }
  return targets;
}

function requireCommand(value: unknown, field: string, configFile: string): string {
  const command = requireString(value, field, configFile);
  if (!hasWellFormedUnicode(command)) {
    throw new ConfigValidationError(configFile, `"${field}" must contain well-formed Unicode.`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(command)) {
    throw new ConfigValidationError(configFile, `"${field}" must not contain control characters.`);
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new ConfigValidationError(configFile, `"${field}" exceeds the maximum supported length.`);
  }
  return command;
}

function resolveKeys(raw: RawRotatorConfig, configFile: string, env: NodeJS.ProcessEnv): ResolvedKeyDefinition[] {
  if (!Array.isArray(raw.keys) || raw.keys.length < 2) {
    throw new ConfigValidationError(configFile, '"keys" must contain at least two key definitions.');
  }
  if (raw.keys.length > MAX_KEYS) {
    throw new ConfigValidationError(configFile, `"keys" supports at most ${MAX_KEYS} entries.`);
  }

  const ids = new Set<string>();
  const envNames = new Set<string>();
  const commands = new Set<string>();
  const secretOwners = new Map<string, string>();
  const missingEnvNames: string[] = [];

  const keys = raw.keys.map((entry, index): ResolvedKeyDefinition => {
    if (!isRecord(entry)) {
      throw new ConfigValidationError(configFile, `keys[${index}] must be an object.`);
    }
    rejectUnknownFields(
      entry,
      ["id", "env", "value", "command", "commandTimeoutMs"],
      `keys[${index}]`,
      configFile,
    );

    const id = requireIdentifier(entry.id, `keys[${index}].id`, configFile);
    if (ids.has(id)) {
      throw new ConfigValidationError(configFile, `Duplicate key id: ${id}`);
    }
    ids.add(id);

    const hasEnv = Object.hasOwn(entry, "env");
    const hasValue = Object.hasOwn(entry, "value");
    const hasCommand = Object.hasOwn(entry, "command");
    if (Number(hasEnv) + Number(hasValue) + Number(hasCommand) !== 1) {
      throw new ConfigValidationError(
        configFile,
        `keys[${index}] (${id}) must specify exactly one of "env", "value", or "command".`,
      );
    }
    if (!hasCommand && Object.hasOwn(entry, "commandTimeoutMs")) {
      throw new ConfigValidationError(
        configFile,
        `keys[${index}] (${id}) sets "commandTimeoutMs" without "command".`,
      );
    }

    let source: KeySource;
    let envName: string | undefined;
    let command: string | undefined;
    let commandTimeoutMs: number | undefined;
    let value: string;

    if (hasCommand) {
      source = "command";
      command = requireCommand(entry.command, `keys[${index}].command`, configFile);
      if (commands.has(command)) {
        throw new ConfigValidationError(configFile, `Duplicate key command for key "${id}".`);
      }
      commands.add(command);
      commandTimeoutMs = integerInRange(
        entry.commandTimeoutMs,
        DEFAULT_COMMAND_TIMEOUT_MS,
        `keys[${index}].commandTimeoutMs`,
        100,
        120_000,
        configFile,
      );
      // Commands run later, in the async loader. `resolveConfig` stays synchronous.
      value = "";
    } else if (hasEnv) {
      source = "env";
      envName = requireString(entry.env, `keys[${index}].env`, configFile);
      if (!ENV_NAME_PATTERN.test(envName)) {
        throw new ConfigValidationError(configFile, `keys[${index}].env is not a valid environment variable name.`);
      }
      if (envNames.has(envName)) {
        throw new ConfigValidationError(configFile, `Duplicate environment variable reference: ${envName}`);
      }
      envNames.add(envName);

      const rawValue = env[envName];
      if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
        missingEnvNames.push(envName);
        value = "";
      } else {
        value = requireSecret(rawValue, `environment variable ${envName}`, configFile);
      }
    } else {
      source = "literal";
      value = requireSecret(entry.value, `keys[${index}].value`, configFile);
    }

    if (value.length > 0) {
      const previousOwner = secretOwners.get(value);
      if (previousOwner) {
        throw new ConfigValidationError(
          configFile,
          `Key "${id}" resolves to the same secret value as key "${previousOwner}".`,
        );
      }
      secretOwners.set(value, id);
    }

    return {
      id,
      source,
      env: envName ?? "<literal>",
      ...(command === undefined
        ? {}
        : { command, commandTimeoutMs: commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS }),
      value,
    };
  });

  if (missingEnvNames.length > 0) {
    throw new ConfigValidationError(
      configFile,
      `Missing or empty environment variables: ${missingEnvNames.join(", ")}.`,
    );
  }
  return keys;
}

export function resolveConfig(
  raw: RawRotatorConfig,
  options: Required<Pick<LoadConfigOptions, "env" | "homeDir">> & {
    configFile: string;
    configRevision?: string;
  },
): RotatorConfig {
  const { configFile, env, homeDir } = options;
  if (!isRecord(raw)) {
    throw new ConfigValidationError(configFile, "The pool definition must be a JSON object.");
  }
  rejectUnknownFields(raw, SINGLE_POOL_ROOT_FIELDS, "the configuration root", configFile);
  validateConfigVersion(raw, configFile);

  const targets = resolveTargets(raw as unknown as RawRotatorConfig, configFile);
  const primaryTarget = targets[0];
  if (!primaryTarget) {
    // Kept as a defensive invariant even though resolveTargets rejects this.
    throw new ConfigValidationError(configFile, "No provider targets were resolved.");
  }

  const poolId =
    raw.poolId === undefined
      ? defaultPoolId(primaryTarget.provider)
      : requireIdentifier(raw.poolId, "poolId", configFile);
  const keys = resolveKeys(raw, configFile, env);

  const requestsPerKey = integerInRange(raw.requestsPerKey, 20, "requestsPerKey", 1, 1_000_000, configFile);
  const maxAttemptsPerRequest = integerInRange(
    raw.maxAttemptsPerRequest,
    Math.min(keys.length, 3),
    "maxAttemptsPerRequest",
    1,
    keys.length,
    configFile,
  );
  const cooldownMs = integerInRange(raw.cooldownMs, 60_000, "cooldownMs", 0, 86_400_000, configFile);
  const transientCooldownMs = integerInRange(
    raw.transientCooldownMs,
    5_000,
    "transientCooldownMs",
    0,
    3_600_000,
    configFile,
  );
  const maxRetryAfterMs = integerInRange(
    raw.maxRetryAfterMs,
    900_000,
    "maxRetryAfterMs",
    0,
    86_400_000,
    configFile,
  );
  const targetFailureThreshold = integerInRange(
    raw.targetFailureThreshold,
    2,
    "targetFailureThreshold",
    1,
    100,
    configFile,
  );
  const lockTimeoutMs = integerInRange(raw.lockTimeoutMs, 5_000, "lockTimeoutMs", 100, 60_000, configFile);
  const staleLockMs = integerInRange(raw.staleLockMs, 30_000, "staleLockMs", 1_000, 600_000, configFile);
  const maxStateFileBytes = integerInRange(
    raw.maxStateFileBytes,
    DEFAULT_MAX_STATE_FILE_BYTES,
    "maxStateFileBytes",
    1_024,
    16_777_216,
    configFile,
  );
  const requiredStateBytes = minimumStateFileBytes(poolId, keys, targets);
  if (maxStateFileBytes < requiredStateBytes) {
    throw new ConfigValidationError(
      configFile,
      `"maxStateFileBytes" must be at least ${requiredStateBytes} bytes for this pool's key set.`,
    );
  }

  const retryStatuses = statusSet(raw.retryStatuses, DEFAULT_RETRY_STATUSES, "retryStatuses", configFile);
  const disableStatuses = statusSet(
    raw.disableStatuses,
    DEFAULT_DISABLE_STATUSES,
    "disableStatuses",
    configFile,
    { allowEmpty: true },
  );
  const cooldownStatuses = statusSet(
    raw.cooldownStatuses,
    DEFAULT_COOLDOWN_STATUSES,
    "cooldownStatuses",
    configFile,
    { allowEmpty: true },
  );
  ensureSubset(disableStatuses, retryStatuses, "disableStatuses", "retryStatuses", configFile);
  ensureSubset(cooldownStatuses, retryStatuses, "cooldownStatuses", "retryStatuses", configFile);
  ensureDisjoint(disableStatuses, cooldownStatuses, "disableStatuses", "cooldownStatuses", configFile);

  const configuredStateFile =
    raw.stateFile === undefined
      ? defaultStateFile(poolId, { env, homeDir })
      : requireDisplayString(raw.stateFile, "stateFile", MAX_STATE_PATH_LENGTH, configFile);
  const stateFile = resolvePath(configuredStateFile, homeDir, dirname(configFile));
  rejectStateConfigCollision(stateFile, configFile);

  return {
    poolId,
    targets,
    provider: primaryTarget.provider,
    api: primaryTarget.api,
    keys,
    requestsPerKey,
    maxAttemptsPerRequest,
    cooldownMs,
    transientCooldownMs,
    maxRetryAfterMs,
    retryStatuses,
    disableStatuses,
    cooldownStatuses,
    rateLimitScope: rateLimitScopeValue(raw.rateLimitScope, configFile),
    targetFailureThreshold,
    retryNetworkErrors: booleanValue(raw.retryNetworkErrors, true, "retryNetworkErrors", configFile),
    stateFile,
    lockTimeoutMs,
    staleLockMs,
    maxStateFileBytes,
    configFile,
    configRevision: options.configRevision ?? "0",
  };
}

export function validateCommandBudget(configs: readonly RotatorConfig[], configFile: string): void {
  const commandKeys = configs.flatMap((config) => config.keys.filter((key) => key.source === "command"));
  const timeoutBudget = commandKeys.reduce((sum, key) => sum + (key.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS), 0);
  if (commandKeys.length > MAX_COMMAND_KEYS) {
    throw new ConfigValidationError(
      configFile,
      `At most ${MAX_COMMAND_KEYS} command-backed keys may be loaded at once.`,
    );
  }
  if (timeoutBudget > MAX_COMMAND_TIMEOUT_BUDGET_MS) {
    throw new ConfigValidationError(
      configFile,
      `The combined command timeout budget must not exceed ${MAX_COMMAND_TIMEOUT_BUDGET_MS} ms.`,
    );
  }
}

/**
 * Run every `command` key source once and store the produced secrets in memory.
 * Never logs stdout, stderr, or a resolved value.
 */
export async function resolveCommandKeys(
  config: RotatorConfig,
  options: { runCommand?: CommandRunner; signal?: AbortSignal } = {},
): Promise<RotatorConfig> {
  const pending = config.keys.filter((key) => key.source === "command");
  if (pending.length === 0) return config;
  const runCommand = options.runCommand ?? runShellCommand;
  const startupDeadline = performance.now() + MAX_COMMAND_TIMEOUT_BUDGET_MS;

  for (const key of pending) {
    const command = key.command ?? "";
    const remainingMs = Math.floor(startupDeadline - performance.now());
    if (remainingMs <= 0) {
      throw new ConfigValidationError(config.configFile, "The aggregate command startup deadline was exceeded.");
    }
    const timeoutMs = Math.max(
      1,
      Math.min(key.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, remainingMs),
    );
    const deadlineController = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadlineController.signal])
      : deadlineController.signal;
    let deadlineReached = false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let result;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          deadlineReached = true;
          deadlineController.abort();
          reject(new Error("command deadline"));
        }, timeoutMs);
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("command aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      result = await Promise.race([runCommand(command, { timeoutMs, signal }), deadline, aborted]);
    } catch {
      // Rejection details can echo command output, so discard them.
      if (deadlineReached) {
        throw new ConfigValidationError(config.configFile, `Key "${key.id}": the "command" source timed out.`);
      }
      throw new ConfigValidationError(config.configFile, `Key "${key.id}": the "command" source could not be started.`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    if (result.timedOut) {
      throw new ConfigValidationError(config.configFile, `Key "${key.id}": the "command" source timed out.`);
    }
    if (result.outputLimitExceeded) {
      throw new ConfigValidationError(
        config.configFile,
        `Key "${key.id}": the "command" source exceeded the stdout limit.`,
      );
    }
    if (result.code !== 0) {
      throw new ConfigValidationError(
        config.configFile,
        `Key "${key.id}": the "command" source exited with code ${String(result.code)}.`,
      );
    }
    key.value = requireSecret(result.stdout.trim(), `command output for key ${key.id}`, config.configFile);
  }

  const owners = new Map<string, string>();
  for (const key of config.keys) {
    if (key.value.length === 0) continue;
    const previous = owners.get(key.value);
    if (previous) {
      throw new ConfigValidationError(
        config.configFile,
        `Key "${key.id}" resolves to the same secret value as key "${previous}".`,
      );
    }
    owners.set(key.value, key.id);
  }
  return config;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<RotatorConfig> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const selection = selectConfigPath({
    env,
    homeDir,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const configFile = resolvePath(selection.path, homeDir);

  const loaded = await readConfigFileSecurely(configFile);
  if (selection.warning) options.warn?.(selection.warning);
  if (loaded.warning) options.warn?.(loaded.warning);

  const config = resolveConfig(parseJson(loaded.text, configFile), {
    configFile,
    configRevision: loaded.revision,
    env,
    homeDir,
  });
  await validatePhysicalStatePaths([config], configFile);
  validateCommandBudget([config], configFile);
  return await resolveCommandKeys(config, {
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
