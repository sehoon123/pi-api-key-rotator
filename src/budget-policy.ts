export const DEFAULT_BUDGET_COOLDOWN_MS = 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inspect only bounded SDK error text, never consume a stream or persist a provider body. */
export function isBudgetExhaustedError(text: string): boolean {
  if (text.length > 16_384) return false;
  let json = text.trim();
  if (!json.startsWith("{")) {
    // Known Pi SDK formats: 429 <JSON>, 429: <JSON>, <provider> API error (429): <JSON>.
    // Do not infer budget health from arbitrary prose, nested message strings, or partial JSON.
    const match = /^(?:429(?:\s+|:\s*)|[^\r\n{}]{1,200} API error\s*\(429\):\s*)(\{[\s\S]*\})$/u.exec(json);
    if (!match?.[1]) return false;
    json = match[1];
  }
  try {
    const body: unknown = JSON.parse(json);
    if (!isRecord(body)) return false;
    const error = isRecord(body.error) ? body.error : body;
    return [error.type, error.code].some(value => value === "budget_exceeded" || value === "insufficient_quota");
  } catch {
    return false;
  }
}
