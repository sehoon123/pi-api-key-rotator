import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RawRotatorConfig, RotatorConfig } from "./types.ts";

const DEFAULT_RETRY_STATUSES = [401, 402, 403, 408, 409, 425, 429, 500, 502, 503, 504] as const;
const DEFAULT_DISABLE_STATUSES = [401, 402, 403] as const;
const DEFAULT_COOLDOWN_STATUSES = [429] as const;

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

function parseJson(text: string, configFile: string): RawRotatorConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(configFile, `JSON parsing failed: ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new ConfigValidationError(configFile, "The root value must be a JSON object.");
  }
  return parsed as unknown as RawRotatorConfig;
}

export function resolveConfig(
  raw: RawRotatorConfig,
  options: Required<Pick<LoadConfigOptions, "env" | "homeDir">> & { configFile: string },
): RotatorConfig {
  const { configFile, env, homeDir } = options;
  const provider = requireString(raw.provider, "provider", configFile);
  const api = requireString(raw.api, "api", configFile);

  if (!Array.isArray(raw.keys) || raw.keys.length < 2) {
    throw new ConfigValidationError(configFile, '"keys" must contain at least two key definitions.');
  }

  const ids = new Set<string>();
  const envNames = new Set<string>();
  const secretFingerprints = new Set<string>();
  const missingEnvNames: string[] = [];

  const keys = raw.keys.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ConfigValidationError(configFile, `keys[${index}] must be an object.`);
    }

    const id = requireString(entry.id, `keys[${index}].id`, configFile);
    const envName = requireString(entry.env, `keys[${index}].env`, configFile);

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
      throw new ConfigValidationError(
        configFile,
        `keys[${index}].id must be 1-64 characters using letters, digits, dot, underscore, or hyphen.`,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new ConfigValidationError(configFile, `keys[${index}].env is not a valid environment variable name.`);
    }
    if (ids.has(id)) {
      throw new ConfigValidationError(configFile, `Duplicate key id: ${id}`);
    }
    if (envNames.has(envName)) {
      throw new ConfigValidationError(configFile, `Duplicate environment variable reference: ${envName}`);
    }

    const value = env[envName]?.trim() ?? "";
    if (value.length === 0) missingEnvNames.push(envName);
    if (value.length > 0 && secretFingerprints.has(value)) {
      throw new ConfigValidationError(
        configFile,
        `Two entries resolve to the same secret value. Check the environment variables near ${envName}.`,
      );
    }

    ids.add(id);
    envNames.add(envName);
    if (value.length > 0) secretFingerprints.add(value);
    return { id, env: envName, value };
  });

  if (missingEnvNames.length > 0) {
    throw new ConfigValidationError(
      configFile,
      `Missing or empty environment variables: ${missingEnvNames.join(", ")}.`,
    );
  }

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
    typeof raw.stateFile === "string" && raw.stateFile.trim().length > 0
      ? raw.stateFile.trim()
      : join("~", ".pi", "agent", `key-rotator-${provider.replace(/[^A-Za-z0-9._-]+/g, "-")}.state.json`);
  const stateFile = resolvePath(configuredStateFile, homeDir, dirname(configFile));

  return {
    provider,
    api,
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
  const requestedPath = options.configFile ?? env.PI_KEY_ROTATOR_CONFIG ?? DEFAULT_CONFIG_FILE;
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
