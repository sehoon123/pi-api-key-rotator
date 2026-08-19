import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import {
  ConfigNotFoundError,
  ConfigValidationError,
  DEFAULT_CONFIG_FILE,
  resolveConfig,
} from "./config.ts";
import type { RawRotatorConfig, RotatorConfig, RotatorTarget } from "./types.ts";

const MAX_POOLS = 128;
const POOL_LEVEL_FIELDS = [
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
  "retryNetworkErrors",
  "stateFile",
  "lockTimeoutMs",
  "staleLockMs",
] as const;

export interface RawMultiPoolConfig {
  pools: RawRotatorConfig[];
}

export interface RotatorConfigSet {
  pools: RotatorConfig[];
  configFile: string;
}

export interface LoadConfigSetOptions {
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) return resolve(homeDir, input.slice(2));
  return input;
}

function resolvePath(input: string, homeDir: string): string {
  const expanded = expandHome(input, homeDir);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function safeJsonParseDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lineColumn = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColumn) return `JSON parsing failed near line ${lineColumn[1]}, column ${lineColumn[2]}.`;
  const position = message.match(/position\s+(\d+)/i);
  if (position) return `JSON parsing failed near character ${position[1]}.`;
  return "JSON parsing failed.";
}

function parseJson(text: string, configFile: string): unknown {
  try {
    const normalizedText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return JSON.parse(normalizedText) as unknown;
  } catch (error) {
    // SyntaxError messages can contain a source excerpt. Literal API keys may
    // be present there, so preserve only non-secret location information.
    throw new ConfigValidationError(configFile, safeJsonParseDetail(error));
  }
}

function poolId(config: RotatorConfig): string {
  return config.poolId ?? config.provider;
}

function targets(config: RotatorConfig): RotatorTarget[] {
  return config.targets?.length ? config.targets : [{ provider: config.provider, api: config.api }];
}

function validationDetail(error: ConfigValidationError): string {
  const marker = "): ";
  const index = error.message.indexOf(marker);
  return index >= 0 ? error.message.slice(index + marker.length) : error.message;
}

function canonicalStateFile(path: string): string {
  // Always compare case-insensitively. It is stricter on Linux, but prevents a
  // config created there from corrupting state when moved to Windows/macOS.
  return normalize(path).replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

function validateSet(pools: RotatorConfig[], configFile: string): void {
  const ids = new Map<string, string>();
  const providers = new Map<string, string>();
  const stateFiles = new Map<string, string>();

  for (const config of pools) {
    const id = poolId(config);
    const canonicalId = id.toLocaleLowerCase("en-US");
    const previousId = ids.get(canonicalId);
    if (previousId) {
      throw new ConfigValidationError(
        configFile,
        `Pool IDs must be unique (case-insensitive): "${previousId}" and "${id}" collide.`,
      );
    }
    ids.set(canonicalId, id);

    for (const target of targets(config)) {
      const previousPool = providers.get(target.provider);
      if (previousPool) {
        throw new ConfigValidationError(
          configFile,
          `Provider "${target.provider}" is assigned to both pool "${previousPool}" and pool "${id}". ` +
            "A Pi provider can belong to only one independent key pool.",
        );
      }
      providers.set(target.provider, id);
    }

    const stateKey = canonicalStateFile(config.stateFile);
    const previousStatePool = stateFiles.get(stateKey);
    if (previousStatePool) {
      throw new ConfigValidationError(
        configFile,
        `Pools "${previousStatePool}" and "${id}" resolve to the same state file. ` +
          "Give each independent pool a unique poolId or stateFile.",
      );
    }
    stateFiles.set(stateKey, id);
  }
}

/** Resolve either the existing single/shared-pool format or a top-level pools[] document. */
export function resolveConfigSet(
  raw: unknown,
  options: { configFile: string; env: NodeJS.ProcessEnv; homeDir: string },
): RotatorConfigSet {
  const { configFile } = options;
  if (!isRecord(raw)) {
    throw new ConfigValidationError(configFile, "The root value must be a JSON object.");
  }

  let pools: RotatorConfig[];
  if (Object.hasOwn(raw, "pools")) {
    const conflicts = POOL_LEVEL_FIELDS.filter((name) => Object.hasOwn(raw, name));
    if (conflicts.length > 0) {
      throw new ConfigValidationError(
        configFile,
        `Top-level "pools" cannot be combined with pool-level fields: ${conflicts.join(", ")}.`,
      );
    }
    if (!Array.isArray(raw.pools) || raw.pools.length === 0) {
      throw new ConfigValidationError(configFile, '"pools" must contain at least one independent pool definition.');
    }
    if (raw.pools.length > MAX_POOLS) {
      throw new ConfigValidationError(configFile, `"pools" supports at most ${MAX_POOLS} entries.`);
    }

    pools = raw.pools.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new ConfigValidationError(configFile, `pools[${index}] must be an object.`);
      }
      try {
        return resolveConfig(entry as unknown as RawRotatorConfig, options);
      } catch (error) {
        if (error instanceof ConfigValidationError) {
          throw new ConfigValidationError(configFile, `pools[${index}]: ${validationDetail(error)}`);
        }
        throw error;
      }
    });
  } else {
    // Existing v0.1/v0.2 documents remain valid without migration.
    pools = [resolveConfig(raw as unknown as RawRotatorConfig, options)];
  }

  validateSet(pools, configFile);
  return { pools, configFile };
}

/** Load an entire key-rotator.json document, including all independent pools. */
export async function loadConfigSet(options: LoadConfigSetOptions = {}): Promise<RotatorConfigSet> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const environmentPath = env.PI_KEY_ROTATOR_CONFIG?.trim();
  const requestedPath = options.configFile ?? (environmentPath ? environmentPath : DEFAULT_CONFIG_FILE);
  const configFile = resolvePath(requestedPath, homeDir);

  let text: string;
  try {
    text = await readFile(configFile, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") throw new ConfigNotFoundError(configFile);
    throw error;
  }

  return resolveConfigSet(parseJson(text, configFile), { configFile, env, homeDir });
}
