import { constants as fsConstants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname, parse } from "node:path";
import { MAX_CONFIG_BYTES } from "./config.ts";
import { inspectConfigFile } from "./pi-host.ts";
import type { RotatorConfig, RotatorTarget } from "./types.ts";

export type DoctorSeverity = "OK" | "WARN" | "FAIL";

export interface DoctorCheck {
  severity: DoctorSeverity;
  subject: string;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  severity: DoctorSeverity;
  text: string;
}

export interface DoctorInput {
  configFile: string;
  pools: readonly RotatorConfig[];
  /** Provider -> API pairs captured after Pi accepted every registration. */
  registeredTargets: ReadonlyMap<string, string>;
  /** Read-only runtime validation keyed by pool ID. */
  stateReaders?: ReadonlyMap<string, () => Promise<unknown>>;
}

function nodeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "filesystem error";
}

function targets(config: RotatorConfig): RotatorTarget[] {
  return config.targets?.length ? config.targets : [{ provider: config.provider, api: config.api }];
}

function poolId(config: RotatorConfig): string {
  return config.poolId ?? config.provider;
}

async function configCheck(configFile: string): Promise<DoctorCheck> {
  try {
    const inspected = await inspectConfigFile(configFile);
    if (inspected.refusal === "not-regular") {
      return { severity: "FAIL", subject: "Config", detail: "not a regular file" };
    }
    if (inspected.refusal === "wrong-owner") {
      return { severity: "FAIL", subject: "Config", detail: "not owned by the current user" };
    }
    if (inspected.refusal === "writable-by-others") {
      return { severity: "FAIL", subject: "Config", detail: "writable by group or other users" };
    }
    if (inspected.size > MAX_CONFIG_BYTES) {
      return { severity: "FAIL", subject: "Config", detail: "over the byte limit" };
    }
    if (process.platform === "win32") {
      return { severity: "WARN", subject: "Config", detail: "regular file; Windows ACLs were not inspected" };
    }
    if (inspected.warning) {
      return { severity: "WARN", subject: "Config", detail: "readable by group or other users; use mode 600" };
    }
    return { severity: "OK", subject: "Config", detail: "regular file with safe ownership and mode" };
  } catch (error) {
    return { severity: "FAIL", subject: "Config", detail: `metadata check failed (${nodeErrorCode(error)})` };
  }
}

async function nearestExistingDirectory(input: string): Promise<string | undefined> {
  let candidate = input;
  while (true) {
    try {
      const info = await lstat(candidate);
      return info.isDirectory() ? candidate : undefined;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate || candidate === parse(candidate).root) return undefined;
    candidate = parent;
  }
}

async function stateCheck(config: RotatorConfig, reader?: () => Promise<unknown>): Promise<DoctorCheck> {
  const subject = `State (${poolId(config)})`;
  try {
    let exists = true;
    try {
      const info = await lstat(config.stateFile);
      if (!info.isFile()) {
        return { severity: "FAIL", subject, detail: "state path exists but is not a regular file" };
      }
      if (info.size > (config.maxStateFileBytes ?? 1_048_576)) {
        return { severity: "FAIL", subject, detail: "state file exceeds its configured byte limit" };
      }
      if (process.platform !== "win32") {
        const effectiveUid = process.geteuid?.() ?? process.getuid?.();
        if (effectiveUid === undefined || info.uid !== effectiveUid) {
          return { severity: "FAIL", subject, detail: "state file is not owned by the effective user" };
        }
        if ((info.mode & 0o022) !== 0) {
          return { severity: "FAIL", subject, detail: "state file is writable by group or other users" };
        }
      }
      await access(config.stateFile, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") exists = false;
      else throw error;
    }

    const writableAncestor = await nearestExistingDirectory(dirname(config.stateFile));
    if (!writableAncestor) {
      return { severity: "FAIL", subject, detail: "no usable parent directory" };
    }
    await access(writableAncestor, fsConstants.W_OK | fsConstants.X_OK);

    if (reader) {
      try {
        await reader();
      } catch (error) {
        const name = error instanceof Error && error.name ? error.name : "state validation error";
        return { severity: "FAIL", subject, detail: `read-only state validation failed (${name})` };
      }
    }

    return {
      severity: process.platform === "win32" ? "WARN" : "OK",
      subject,
      detail:
        process.platform === "win32"
          ? exists
            ? "state is readable; Windows ACLs were not inspected"
            : "state can be created; Windows ACLs were not inspected"
          : exists
            ? "state is valid and its parent is writable"
            : "state can be created from a writable ancestor",
    };
  } catch (error) {
    return { severity: "FAIL", subject, detail: `state path is not usable (${nodeErrorCode(error)})` };
  }
}

function targetCheck(
  id: string,
  target: RotatorTarget,
  registeredTargets: ReadonlyMap<string, string>,
): DoctorCheck {
  const registeredApi = registeredTargets.get(target.provider);
  if (registeredApi === undefined) {
    return {
      severity: "FAIL",
      subject: `Target (${id}/${target.provider})`,
      detail: `provider was not registered for ${target.api}`,
    };
  }
  if (registeredApi !== target.api) {
    return {
      severity: "FAIL",
      subject: `Target (${id}/${target.provider})`,
      detail: `registered for ${registeredApi}, expected ${target.api}`,
    };
  }
  return {
    severity: "OK",
    subject: `Target (${id}/${target.provider})`,
    detail: `${target.api} registered locally`,
  };
}

/** Build diagnostics only from local metadata and captured registrations. */
export async function buildDoctorReport(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [await configCheck(input.configFile)];
  for (const config of input.pools) {
    const id = poolId(config);
    checks.push(await stateCheck(config, input.stateReaders?.get(id)));
    for (const target of targets(config)) {
      checks.push(targetCheck(id, target, input.registeredTargets));
    }
  }

  const counts = { OK: 0, WARN: 0, FAIL: 0 };
  for (const check of checks) counts[check.severity] += 1;
  const severity: DoctorSeverity = counts.FAIL > 0 ? "FAIL" : counts.WARN > 0 ? "WARN" : "OK";
  const text = [
    "Key rotator doctor (local checks only; no provider requests sent)",
    ...checks.map((check) => `[${check.severity}] ${check.subject}: ${check.detail}`),
    `Summary: ${counts.OK} OK, ${counts.WARN} WARN, ${counts.FAIL} FAIL`,
  ].join("\n");
  return { checks, severity, text };
}
