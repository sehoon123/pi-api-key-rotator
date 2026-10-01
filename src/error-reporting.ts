import { sanitizeRotatorErrorText } from "./rotating-stream.ts";
import type { ExtensionApiLike, ExtensionContextLike, RotatorConfig } from "./types.ts";

export const ERROR_ENTRY_TYPE = "pi-key-rotator-error";
const MAX_ERRORS = 10;

interface FailureReport {
  poolId: string;
  provider: string;
  model: string;
  timestamp: number;
  summary: string;
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatReport(report: FailureReport): string {
  return [
    `[${new Date(report.timestamp).toISOString()}] ${report.poolId} / ${report.provider} / ${report.model}`,
    report.summary,
    ...(report.detail ? [`Detail: ${report.detail}`] : []),
  ].join("\n");
}

/** Keep safe metadata independently of the host's failed-message retention. */
export function installRotatorErrorReporting(pi: ExtensionApiLike, configs: readonly RotatorConfig[]) {
  const byProvider = new Map<string, RotatorConfig>();
  for (const config of configs) {
    for (const target of config.targets ?? [{ provider: config.provider, api: config.api }]) {
      byProvider.set(target.provider, config);
    }
  }
  let reports: FailureReport[] = [];

  const normalize = (value: unknown): FailureReport | undefined => {
    if (!isRecord(value) || typeof value.provider !== "string") return undefined;
    const config = byProvider.get(value.provider);
    if (!config || typeof value.summary !== "string" || typeof value.model !== "string") return undefined;
    const safe = (text: string) => sanitizeRotatorErrorText(text, config);
    const timestamp = typeof value.timestamp === "number" && Number.isSafeInteger(value.timestamp) &&
      value.timestamp >= 0 && value.timestamp <= 8_640_000_000_000_000 ? value.timestamp : Date.now();
    return {
      poolId: safe(config.poolId ?? config.provider),
      provider: safe(value.provider),
      model: safe(value.model),
      timestamp,
      summary: safe(value.summary),
      ...(typeof value.detail === "string" ? { detail: safe(value.detail) } : {}),
    };
  };

  const restore = (ctx: ExtensionContextLike): void => {
    reports = [];
    try {
      const entries = ctx.sessionManager?.getEntries() ?? [];
      // Scan backward and retain only the ten newest reports, never prompts,
      // provider payloads, headers, stacks, or complete diagnostics objects.
      for (let index = entries.length - 1; index >= 0 && reports.length < MAX_ERRORS; index--) {
        const entry = entries[index];
        if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== ERROR_ENTRY_TYPE) continue;
        const report = normalize(entry.data);
        if (report) reports.unshift(report);
      }
    } catch {
      // Read-only diagnostics must never prevent session startup.
    }
  };

  pi.on("message_end", (event, ctx) => {
    if (!isRecord(event) || !isRecord(event.message)) return;
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error" || !Array.isArray(message.diagnostics)) return;
    const final = message.diagnostics.slice(-256).findLast((entry: unknown) =>
      isRecord(entry) && entry.type === "pi_key_rotator_final" &&
      isRecord(entry.details) && entry.details.source === "pi-api-key-rotator",
    ) as Record<string, unknown> | undefined;
    if (!final || !isRecord(final.error) || !isRecord(final.details)) return;
    const report = normalize({
      provider: message.provider,
      model: message.model,
      timestamp: message.timestamp,
      summary: final.error.message,
      detail: final.details.detail,
    });
    if (!report) return;
    reports = [...reports.slice(-(MAX_ERRORS - 1)), report];
    try {
      pi.appendEntry?.(ERROR_ENTRY_TYPE, report);
    } catch {
      // Reporting is best effort, separate from the outcome's durable-state gate.
    }
    try {
      ctx.ui.notify(
        `${formatReport(report)}\nRecent failures: /key-rotator errors`,
        final.details.reason === "context_overflow" ? "warning" : "error",
      );
    } catch {
      // An unavailable UI must not break RPC/print requests or recovery.
    }
  });

  return {
    restore,
    show(ctx: ExtensionContextLike, poolId?: string): void {
      const selected = poolId === undefined ? reports : reports.filter((report) =>
        report.poolId.toLowerCase() === poolId.toLowerCase(),
      );
      ctx.ui.notify(
        selected.length ? selected.map(formatReport).join("\n\n") :
          "No credential-rotator failures have been recorded in this session.",
        "info",
      );
    },
  };
}
