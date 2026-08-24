import { isUtf8 } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readFile } from "node:fs/promises";
import { MAX_CONFIG_BYTES } from "./config.ts";
import { inspectConfigFile } from "./pi-host.ts";
import type { RegistrationEvidence } from "./request-fence.ts";
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
  /** Legacy local submission map. It is never treated as host acceptance. */
  registeredTargets?: ReadonlyMap<string, string>;
  /** Pi post-bind evidence captured through ModelRegistry public methods. */
  registrationEvidence?: ReadonlyMap<string, RegistrationEvidence>;
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

async function stateCheck(config: RotatorConfig, reader?: () => Promise<unknown>): Promise<DoctorCheck> {
  const subject = `State (${poolId(config)})`;
  try {
    let info;
    try {
      info = await lstat(config.stateFile);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        return { severity: "OK", subject, detail: "state file is absent; this is allowed" };
      }
      throw error;
    }

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
    // Doctor diagnoses existing state. It never requires write permission and
    // never probes creatability by making a directory, lock, or temporary file.
    await access(config.stateFile, fsConstants.R_OK);

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
          ? "state is readable; Windows ACLs were not inspected"
          : "state metadata is safe and the file is readable",
    };
  } catch (error) {
    return { severity: "FAIL", subject, detail: `state path is not usable (${nodeErrorCode(error)})` };
  }
}

interface LockOwner {
  version: 1;
  nonce: string;
  pid: number;
  acquiredAt: number;
  processStartMarker?: string;
}

interface PresentLockSidecar {
  status: "present";
  owner: LockOwner | null;
  mtimeMs: number;
}

type LockSidecarInspection =
  | { status: "missing" }
  | { status: "invalid"; detail: string }
  | PresentLockSidecar;

function parseLockOwner(text: string): LockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Partial<LockOwner>;
  if (
    source.version !== 1 ||
    typeof source.nonce !== "string" ||
    source.nonce.length < 8 ||
    source.nonce.length > 128 ||
    /[\u0000-\u001F\u007F]/u.test(source.nonce) ||
    !Number.isSafeInteger(source.pid) ||
    (source.pid ?? 0) <= 0 ||
    (source.pid ?? 0) > 2_147_483_647 ||
    typeof source.acquiredAt !== "number" ||
    !Number.isSafeInteger(source.acquiredAt) ||
    source.acquiredAt < 0 ||
    (source.processStartMarker !== undefined &&
      (typeof source.processStartMarker !== "string" ||
        source.processStartMarker.length > 64 ||
        !/^\d+$/u.test(source.processStartMarker)))
  ) {
    return null;
  }
  return {
    version: 1,
    nonce: source.nonce,
    pid: source.pid as number,
    acquiredAt: source.acquiredAt,
    ...(source.processStartMarker === undefined ? {} : { processStartMarker: source.processStartMarker }),
  };
}

async function inspectLockSidecar(path: string): Promise<LockSidecarInspection> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return { status: "missing" };
    return { status: "invalid", detail: `metadata check failed (${nodeErrorCode(error)})` };
  }
  if (!before.isFile()) return { status: "invalid", detail: "path is not a regular file" };
  if (before.size > 4_096) return { status: "invalid", detail: "metadata exceeds the 4096-byte limit" };

  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    return { status: "invalid", detail: `read-only open failed (${nodeErrorCode(error)})` };
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 4_096) {
      return { status: "invalid", detail: "metadata is not a small regular file" };
    }
    const reliableIdentity = before.ino !== 0 && opened.ino !== 0;
    if (
      (reliableIdentity && (before.dev !== opened.dev || before.ino !== opened.ino)) ||
      (!reliableIdentity && (before.size !== opened.size || before.mtimeMs !== opened.mtimeMs))
    ) {
      return { status: "invalid", detail: "path changed during read-only inspection" };
    }
    if (process.platform !== "win32") {
      const effectiveUid = process.geteuid?.() ?? process.getuid?.();
      if (effectiveUid === undefined || opened.uid !== effectiveUid || (opened.mode & 0o022) !== 0) {
        return { status: "invalid", detail: "metadata has unsafe ownership or write permissions" };
      }
    }
    const contents = await handle.readFile();
    if (contents.byteLength > 4_096 || !isUtf8(contents)) {
      return { status: "invalid", detail: "metadata is oversized or not valid UTF-8" };
    }
    const text = contents.toString("utf8");
    return {
      status: "present",
      owner: parseLockOwner(text),
      mtimeMs: opened.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

async function linuxProcessStartMarker(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = statText.lastIndexOf(")");
    if (close < 0) return undefined;
    const marker = statText.slice(close + 1).trim().split(/\s+/u)[19];
    return marker && /^\d+$/u.test(marker) ? marker : undefined;
  } catch {
    return undefined;
  }
}

async function processIsAlive(owner: LockOwner): Promise<boolean> {
  try {
    // Signal 0 is a non-mutating existence/permission probe. Doctor never sends
    // a real signal and never attempts lock recovery itself.
    if (owner.pid !== process.pid) process.kill(owner.pid, 0);
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") return false;
    return true;
  }
  if (owner.processStartMarker !== undefined) {
    const currentMarker = await linuxProcessStartMarker(owner.pid);
    return currentMarker === undefined || currentMarker === owner.processStartMarker;
  }
  return true;
}

async function uncheckedLockCheck(config: RotatorConfig): Promise<DoctorCheck> {
  const subject = `Lock (${poolId(config)})`;
  const lockFile = `${config.stateFile}.lock`;
  const reclaimFile = `${config.stateFile}.lock.reclaim`;
  const [lock, reclaim] = await Promise.all([
    inspectLockSidecar(lockFile),
    inspectLockSidecar(reclaimFile),
  ]);

  if (reclaim.status !== "missing") {
    return {
      severity: "FAIL",
      subject,
      detail:
        reclaim.status === "invalid"
          ? `fixed .lock.reclaim evidence is unsafe (${reclaim.detail})`
          : "fixed .lock.reclaim evidence is present; the store fails closed and requires manual recovery",
    };
  }
  if (lock.status === "missing") {
    return { severity: "OK", subject, detail: "no fixed lock sidecars are present" };
  }
  if (lock.status === "invalid" || lock.owner === null) {
    return {
      severity: "FAIL",
      subject,
      detail:
        lock.status === "invalid"
          ? `lock evidence is unsafe (${lock.detail})`
          : "lock metadata is malformed; automatic recovery is refused",
    };
  }

  const live = await processIsAlive(lock.owner);
  if (live) {
    return {
      severity: "WARN",
      subject,
      detail: `a valid live lock is owned by PID ${lock.owner.pid}`,
    };
  }
  if (Date.now() - lock.mtimeMs > config.staleLockMs) {
    return {
      severity: "WARN",
      subject,
      detail: "a valid stale dead-owner lock is reclaimable by the next writer",
    };
  }
  return {
    severity: "WARN",
    subject,
    detail: "a valid dead-owner lock exists but is not stale enough to reclaim yet",
  };
}

async function lockCheck(config: RotatorConfig): Promise<DoctorCheck> {
  try {
    return await uncheckedLockCheck(config);
  } catch (error) {
    return {
      severity: "FAIL",
      subject: `Lock (${poolId(config)})`,
      detail: `read-only lock inspection failed (${nodeErrorCode(error)})`,
    };
  }
}

function targetCheck(
  id: string,
  target: RotatorTarget,
  registeredTargets: ReadonlyMap<string, string> | undefined,
  evidenceByProvider: ReadonlyMap<string, RegistrationEvidence> | undefined,
): DoctorCheck {
  const subject = `Target (${id}/${target.provider})`;
  const evidence = evidenceByProvider?.get(target.provider);
  if (evidence) {
    switch (evidence.status) {
      case "verified":
        return {
          severity: "OK",
          subject,
          detail: `Pi retained the exact key-rotator stream for ${target.api}`,
        };
      case "unverified":
        return {
          severity: "WARN",
          subject,
          detail: `local submission uses ${target.api}, but this Pi version exposes no post-bind acknowledgement`,
        };
      case "disabled":
        return {
          severity: "FAIL",
          subject,
          detail: `pool state preflight disabled registration for ${target.api}`,
        };
      case "missing":
        return {
          severity: "FAIL",
          subject,
          detail: `Pi did not retain a provider registration for ${target.api}`,
        };
      case "overwritten":
        return {
          severity: "FAIL",
          subject,
          detail:
            evidence.observedApi === undefined
              ? `another registration replaced the expected ${target.api} stream`
              : `registered for ${evidence.observedApi}, expected ${target.api}`,
        };
      case "lookup-error":
        return {
          severity: "FAIL",
          subject,
          detail: "Pi registration acknowledgement could not be read safely",
        };
    }
  }

  const submittedApi = registeredTargets?.get(target.provider);
  if (submittedApi !== undefined && submittedApi !== target.api) {
    return {
      severity: "FAIL",
      subject,
      detail: `local submission used ${submittedApi}, expected ${target.api}`,
    };
  }
  return {
    severity: "WARN",
    subject,
    detail:
      submittedApi === undefined
        ? `no post-bind acknowledgement is available for ${target.api}`
        : `${target.api} was submitted locally, but Pi acceptance was not verified`,
  };
}

/** Build diagnostics only from local metadata and captured registrations. */
export async function buildDoctorReport(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [await configCheck(input.configFile)];
  for (const config of input.pools) {
    const id = poolId(config);
    checks.push(await stateCheck(config, input.stateReaders?.get(id)));
    checks.push(await lockCheck(config));
    for (const target of targets(config)) {
      checks.push(
        targetCheck(id, target, input.registeredTargets, input.registrationEvidence),
      );
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
