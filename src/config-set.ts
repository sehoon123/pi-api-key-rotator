import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import {
  ConfigValidationError,
  POOL_FIELDS,
  readConfigFileSecurely,
  rejectUnknownFields,
  resolveCommandKeys,
  resolveConfig,
  validateCommandBudget,
  validateConfigVersion,
  validatePhysicalStatePaths,
} from "./config.ts";
import { expandHome, selectConfigPath } from "./pi-host.ts";
import type { CommandRunner } from "./pi-host.ts";
import type { RawRotatorConfig, RotatorConfig, RotatorTarget } from "./types.ts";

export const MAX_POOLS = 128;
const ALL_ROOT_FIELDS = ["configVersion", "pools", ...POOL_FIELDS] as const;

export interface RawMultiPoolConfig {
  configVersion?: 1;
  pools: Array<Omit<RawRotatorConfig, "configVersion">>;
}

export interface RotatorConfigSet {
  pools: RotatorConfig[];
  configFile: string;
  /** Non-fatal config path or POSIX readability warnings. */
  warning?: string;
}

export interface LoadConfigSetOptions {
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Receives non-fatal path and permission warnings before key commands run. */
  warn?: (message: string) => void;
  /** Cancels a running command-backed key during load. */
  signal?: AbortSignal;
  /** Injected in tests. Defaults to a real shell command. */
  runCommand?: CommandRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const stateFiles = new Map<string, { poolId: string; artifact: string }>();

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

    const artifacts = [
      { path: config.stateFile, label: "state file" },
      { path: `${config.stateFile}.lock`, label: "lock file" },
      { path: `${config.stateFile}.lock.reclaim`, label: "lock reclaim file" },
      { path: `${config.stateFile}.bak`, label: "backup file" },
    ];
    for (const artifact of artifacts) {
      const stateKey = canonicalStateFile(artifact.path);
      const previous = stateFiles.get(stateKey);
      if (previous) {
        const sameMainFile = previous.artifact === "state file" && artifact.label === "state file";
        throw new ConfigValidationError(
          configFile,
          sameMainFile
            ? `Pools "${previous.poolId}" and "${id}" resolve to the same state file. ` +
                "Give each independent pool a unique poolId or stateFile."
            : `State paths for pools "${previous.poolId}" and "${id}" collide ` +
                `(${previous.artifact} and ${artifact.label}). Give each pool a distinct stateFile.`,
        );
      }
      stateFiles.set(stateKey, { poolId: id, artifact: artifact.label });
    }
  }
}

/** Resolve either the existing single/shared-pool format or a top-level pools[] document. */
export function resolveConfigSet(
  raw: unknown,
  options: { configFile: string; configRevision?: string; env: NodeJS.ProcessEnv; homeDir: string },
): RotatorConfigSet {
  const { configFile } = options;
  if (!isRecord(raw)) {
    throw new ConfigValidationError(configFile, "The root value must be a JSON object.");
  }
  rejectUnknownFields(raw, ALL_ROOT_FIELDS, "the configuration root", configFile);
  validateConfigVersion(raw, configFile);

  let pools: RotatorConfig[];
  if (Object.hasOwn(raw, "pools")) {
    const conflicts = POOL_FIELDS.filter((name) => Object.hasOwn(raw, name));
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
        rejectUnknownFields(entry, POOL_FIELDS, "the pool definition", configFile);
        return resolveConfig(entry as unknown as RawRotatorConfig, options);
      } catch (error) {
        if (error instanceof ConfigValidationError) {
          throw new ConfigValidationError(configFile, `pools[${index}]: ${validationDetail(error)}`);
        }
        throw error;
      }
    });
  } else {
    // Versionless documents remain valid without migration.
    rejectUnknownFields(raw, ["configVersion", ...POOL_FIELDS], "the configuration root", configFile);
    pools = [resolveConfig(raw as unknown as RawRotatorConfig, options)];
  }

  validateSet(pools, configFile);
  return { pools, configFile };
}

/** Load an entire key-rotator.json document, including all independent pools. */
export async function loadConfigSet(options: LoadConfigSetOptions = {}): Promise<RotatorConfigSet> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const selection = selectConfigPath({
    env,
    homeDir,
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  });
  const configFile = resolvePath(selection.path, homeDir);

  const loaded = await readConfigFileSecurely(configFile);
  const warnings = [selection.warning, loaded.warning].filter(
    (warning): warning is string => warning !== undefined,
  );
  for (const warning of warnings) options.warn?.(warning);

  const set = resolveConfigSet(parseJson(loaded.text, configFile), {
    configFile,
    configRevision: loaded.revision,
    env,
    homeDir,
  });
  await validatePhysicalStatePaths(set.pools, configFile);
  validateCommandBudget(set.pools, configFile);
  for (const pool of set.pools) {
    await resolveCommandKeys(pool, {
      ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  return { ...set, ...(warnings.length === 0 ? {} : { warning: warnings.join("\n") }) };
}
