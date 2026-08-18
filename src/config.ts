import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  KeySource,
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

export const DEFAULT_CONFIG_FILE = join("~", ".pi", "agent", "key-rotator.json");

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

export interface LoadConfigOptions {
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homeDir, input.slice(2));
  }
  return input;
}

function resolvePath(input: string, homeDir: string, baseDir?: string): string {
  const expanded = expandHome(input, homeDir);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(baseDir ?? process.cwd(), expanded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, configFile: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigValidationError(configFile, `"${field}" must be a non-empty string.`);
  }
  return value.trim();
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

function requireSecret(value: unknown, field: string, configFile: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new ConfigValidationError(configFile, `"${field}" must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new ConfigValidationError(configFile, `"${field}" must not contain leading or trailing whitespace.`);
  }
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new ConfigValidationError(configFile, `"${field}" must not contain control characters.`);
  }
  if (value.length > MAX_SECRET_LENGTH) {
    throw new ConfigValidationError(configFile, `"${field}" exceeds the maximum supported length.`);
  }
  return value;
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

function statusSet(value: unknown, fallback: readonly number[], field: string, configFile: string): ReadonlySet<number> {
  const input = value === undefined ? fallback : value;
  if (!Array.isArray(input) || input.length === 0) {
    throw new ConfigValidationError(configFile, `"${field}" must be a non-empty array of HTTP status codes.`);
  }

  const result = new Set<number>();
  for (const status of input) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new ConfigValidationError(configFile, `"${field}" contains an invalid HTTP status: ${String(status)}.`);
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
        `Every status in "${subsetName}" must also appear in "${supersetName}" (missing ${status}).`,
      );
    }
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

    targets = raw.targets.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new ConfigValidationError(configFile, `targets[${index}] must be an object.`);
      }
      return {
        provider: requireString(entry.provider, `targets[${index}].provider`, configFile),
        api: requireString(entry.api, `targets[${index}].api`, configFile),
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
        provider: requireString(raw.provider, "provider", configFile),
        api: requireString(raw.api, "api", configFile),
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

function resolveKeys(raw: RawRotatorConfig, configFile: string, env: NodeJS.ProcessEnv): ResolvedKeyDefinition[] {
  if (!Array.isArray(raw.keys) || raw.keys.length < 2) {
    throw new ConfigValidationError(configFile, '"keys" must contain at least two key definitions.');
  }

  const ids = new Set<string>();
  const envNames = new Set<string>();
  const secretOwners = new Map<string, string>();
  const missingEnvNames: string[] = [];

  const keys = raw.keys.map((entry, index): ResolvedKeyDefinition => {
    if (!isRecord(entry)) {
      throw new ConfigValidationError(configFile, `keys[${index}] must be an object.`);
    }

    const id = requireIdentifier(entry.id, `keys[${index}].id`, configFile);
    if (ids.has(id)) {
      throw new ConfigValidationError(configFile, `Duplicate key id: ${id}`);
    }
    ids.add(id);

    const hasEnv = Object.hasOwn(entry, "env");
    const hasValue = Object.hasOwn(entry, "value");
    if (hasEnv === hasValue) {
      throw new ConfigValidationError(
        configFile,
        `keys[${index}] (${id}) must specify exactly one of "env" or "value".`,
      );
    }

    let source: KeySource;
    let envName: string | undefined;
    let value: string;

    if (hasEnv) {
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
  options: Required<Pick<LoadConfigOptions, "env" | "homeDir">> & { configFile: string },
): RotatorConfig {
  const { configFile, env, homeDir } = options;
  const targets = resolveTargets(raw, configFile);
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
    keys.length,
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
  const lockTimeoutMs = integerInRange(raw.lockTimeoutMs, 5_000, "lockTimeoutMs", 100, 60_000, configFile);
  const staleLockMs = integerInRange(raw.staleLockMs, 30_000, "staleLockMs", 1_000, 600_000, configFile);

  const retryStatuses = statusSet(raw.retryStatuses, DEFAULT_RETRY_STATUSES, "retryStatuses", configFile);
  const disableStatuses = statusSet(raw.disableStatuses, DEFAULT_DISABLE_STATUSES, "disableStatuses", configFile);
  const cooldownStatuses = statusSet(raw.cooldownStatuses, DEFAULT_COOLDOWN_STATUSES, "cooldownStatuses", configFile);
  ensureSubset(disableStatuses, retryStatuses, "disableStatuses", "retryStatuses", configFile);
  ensureSubset(cooldownStatuses, retryStatuses, "cooldownStatuses", "retryStatuses", configFile);

  const configuredStateFile =
    raw.stateFile === undefined
      ? join("~", ".pi", "agent", `key-rotator-${poolId}.state.json`)
      : requireString(raw.stateFile, "stateFile", configFile);
  const stateFile = resolvePath(configuredStateFile, homeDir, dirname(configFile));

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
    retryNetworkErrors: booleanValue(raw.retryNetworkErrors, true, "retryNetworkErrors", configFile),
    stateFile,
    lockTimeoutMs,
    staleLockMs,
    configFile,
  };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<RotatorConfig> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const environmentPath = env.PI_KEY_ROTATOR_CONFIG?.trim();
  const requestedPath = options.configFile ?? (environmentPath ? environmentPath : DEFAULT_CONFIG_FILE);
  const configFile = resolvePath(requestedPath, homeDir);

  let text: string;
  try {
    text = await readFile(configFile, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new ConfigNotFoundError(configFile);
    }
    throw error;
  }

  return resolveConfig(parseJson(text, configFile), { configFile, env, homeDir });
}
