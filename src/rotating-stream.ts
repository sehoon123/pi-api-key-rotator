import type { KeyPool } from "./key-pool.ts";
import type {
  AssistantEventLike,
  AssistantEventStreamLike,
  AssistantMessageLike,
  ContextLike,
  EventStreamFactory,
  ModelLike,
  PoolSnapshot,
  ProviderResponseLike,
  ProviderErrorPolicy,
  RotatorConfig,
  StreamOptionsLike,
  StreamSimpleLike,
} from "./types.ts";

export interface RotatingStreamDependencies {
  config: RotatorConfig;
  pool: KeyPool;
  baseStreamSimple: StreamSimpleLike;
  createEventStream: EventStreamFactory;
  errorPolicy?: ProviderErrorPolicy | undefined;
  onStateChange?: (snapshot: PoolSnapshot) => void | Promise<void>;
}

interface AttemptResult {
  outcome: "forwarded" | "retry-http" | "retry-network" | "aborted" | "callback-error";
  response?: ProviderResponseLike | undefined;
  error?: unknown;
  /** A provider terminal held back until the durable outcome mutation finishes. */
  terminalEvent?: AssistantEventLike | undefined;
  /** Structural events buffered until semantic output or durable finalization. */
  pendingEvents?: AssistantEventLike[] | undefined;
  /** True after an incremental source event was exposed to the caller. */
  started?: boolean;
  /** Latest caller-visible partial, used to preserve content in a synthetic terminal. */
  partialMessage?: AssistantMessageLike;
  /** Only a pre-semantic, non-auth/non-transient overflow may reach Pi recovery. */
  contextOverflow?: boolean;
}

type DiagnosticDecision =
  | {
      kind: "http";
      decision: "forward" | "retry";
      response: ProviderResponseLike;
    }
  | { kind: "network" };

const MAX_FORWARDED_ERROR_TEXT = 2_000;
const FINAL_ERROR_MESSAGE = "The credential rotator stopped this request. Review diagnostics for details.";
const FINAL_DIAGNOSTIC_TYPE = "pi_key_rotator_final";
const PACKAGE_NAME = "pi-api-key-rotator";

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function syntheticMessage(
  model: ModelLike,
  reason: "error" | "aborted",
  message: string,
  now = Date.now(),
): AssistantMessageLike {
  const result: AssistantMessageLike = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: reason,
    errorMessage: message,
    timestamp: now,
  };
  return result;
}

function finalizeErrorMessage(
  error: AssistantMessageLike,
  reason: string,
  summary: string,
  config?: RotatorConfig,
  detail?: string,
  contextOverflow = false,
): void {
  const redactor = config ? createErrorRedactor(config) : undefined;
  const safe = (value: string): string =>
    redactor ? sanitizeText(value, redactor) : value.slice(0, MAX_FORWARDED_ERROR_TEXT);
  const safeSummary = safe(summary);
  const safeDetail = detail === undefined ? undefined : safe(detail);
  const existing = Array.isArray(error.diagnostics) ? error.diagnostics : [];
  error.diagnostics = [
    ...existing,
    {
      type: FINAL_DIAGNOSTIC_TYPE,
      timestamp: Date.now(),
      error: { name: "PiKeyRotatorFinalized", message: safeSummary },
      details: {
        source: PACKAGE_NAME,
        reason: contextOverflow ? "context_overflow" : reason,
        ...(safeDetail === undefined ? {} : { detail: safeDetail }),
      },
    },
  ];
  // Pi classifies recovery from errorMessage, not diagnostics. Preserve a
  // recognized overflow marker so it can compact the input, but keep finalized
  // rotation/transport failures neutral to avoid replaying output or bypassing
  // the wrapper's attempt budget with a second, agent-level retry loop.
  error.errorMessage = contextOverflow ? "context_length_exceeded" : FINAL_ERROR_MESSAGE;
}

function emitSyntheticError(
  output: AssistantEventStreamLike,
  model: ModelLike,
  message: string,
  reason: "error" | "aborted" = "error",
  config?: RotatorConfig,
  diagnosticDetail?: string,
  baseMessage?: AssistantMessageLike,
): void {
  const redactor = config ? createErrorRedactor(config) : undefined;
  const safeMessage = redactor
    ? sanitizeText(message, redactor)
    : message.slice(0, MAX_FORWARDED_ERROR_TEXT);
  const error = syntheticMessage(model, reason, safeMessage);
  if (baseMessage) preserveAssistantProtocolFields(baseMessage, error);
  error.stopReason = reason;
  error.errorMessage = safeMessage;
  delete error.stopReasonRaw;
  if (reason === "error") {
    const safeDetail = diagnosticDetail === undefined
      ? undefined
      : redactor
        ? sanitizeText(diagnosticDetail, redactor)
        : diagnosticDetail.slice(0, MAX_FORWARDED_ERROR_TEXT);
    finalizeErrorMessage(error, "rotator_terminal_error", safeMessage, config, safeDetail);
  }
  output.push({ type: "error", reason, error });
}

function isTerminal(event: AssistantEventLike): boolean {
  return event.type === "done" || event.type === "error";
}

function isErrorTerminal(event: AssistantEventLike | undefined): boolean {
  return event?.type === "error";
}
function partialHasSemanticContent(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.content)) return false;
  return value.content.some((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "toolCall" || block.type === "tool_call") return true;
    for (const field of ["text", "thinking", "content", "name", "arguments"]) {
      if (typeof block[field] === "string" && block[field].length > 0) return true;
    }
    return false;
  });
}

function isSemanticIncrement(event: AssistantEventLike): boolean {
  if (event.type === "start") return partialHasSemanticContent(event.partial);
  if (event.type === "toolcall_end") return true;
  if (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta"
  ) {
    return typeof event.delta !== "string" || event.delta.length > 0;
  }
  if (event.type === "text_end" || event.type === "thinking_end") {
    return typeof event.content === "string" && event.content.length > 0;
  }
  if (
    event.type === "text_start" ||
    event.type === "thinking_start" ||
    event.type === "toolcall_start"
  ) {
    return partialHasSemanticContent(event.partial);
  }
  // Unknown extension events are treated as visible output for compatibility.
  return true;
}

function errorText(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "error" &&
    "error" in error &&
    typeof error.error === "object" &&
    error.error !== null &&
    "errorMessage" in error.error &&
    typeof error.error.errorMessage === "string"
  ) {
    return error.error.errorMessage.length > 0 ? error.error.errorMessage : "provider error";
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  return "provider error";
}

function redactionTokens(config: RotatorConfig): string[] {
  const tokens = new Set<string>();
  for (const key of config.keys) {
    const secret = key.value;
    if (!secret) continue;
    // A bounded prefix detects an occurrence without making full encoded copies
    // of large command outputs. sanitizeText then drops the whole remaining
    // string leaf, so no credential suffix survives.
    const prefix = [...secret].slice(0, 8).join("");
    tokens.add(prefix);
    try {
      const encodedPrefix = encodeURIComponent(prefix);
      if (encodedPrefix !== prefix) tokens.add(encodedPrefix);
    } catch {
      // An unpaired surrogate has no canonical encodeURIComponent form.
    }
    const jsonEscapedPrefix = JSON.stringify(prefix).slice(1, -1);
    if (jsonEscapedPrefix !== prefix) tokens.add(jsonEscapedPrefix);

    // Six bytes align to a base64 block, so this token is an exact prefix of
    // the encoding for any longer secret and the full encoding for a short one.
    const bytes = Buffer.from(prefix, "utf8");
    const alignedPrefix = bytes.subarray(0, Math.min(bytes.length, 6));
    tokens.add(alignedPrefix.toString("base64"));
    tokens.add(alignedPrefix.toString("base64url"));
  }
  return [...tokens].sort((left, right) => right.length - left.length);
}

function requestRedactionConfig(
  config: RotatorConfig,
  options: StreamOptionsLike | undefined,
): RotatorConfig {
  const extras = new Set<string>();
  const add = (value: string | undefined): void => {
    // Pi supplies this public inert registry marker on managed calls.
    if (!value || value === "rotator-managed-key") return;
    const bounded = [...value].slice(0, 32).join("");
    if (bounded) extras.add(bounded);
  };
  try {
    add(options?.apiKey);
    for (const [name, value] of Object.entries(options?.headers ?? {}).slice(0, 64)) {
      if (!/(?:auth|key|token|secret|credential|cookie)/iu.test(name)) continue;
      if (typeof value !== "string") continue;
      add(value);
      const scheme = /^(?:bearer|basic|token)\s+(.+)$/iu.exec(value)?.[1];
      add(scheme);
      for (const segment of value.split(/[;,]/u).slice(0, 32)) {
        const separator = segment.indexOf("=");
        if (separator >= 0) add(segment.slice(separator + 1).trim());
      }
    }
  } catch {
    // A non-plain caller options object must not prevent stream construction.
  }
  if (extras.size === 0) return config;
  return {
    ...config,
    keys: [
      ...config.keys,
      ...[...extras].map((value, index) => ({
        id: `request-redaction-${index}`,
        env: "<request>",
        value,
        source: "literal" as const,
      })),
    ],
  };
}

interface ErrorRedactor {
  overlap: number;
  pattern?: RegExp;
}

function createErrorRedactor(config: RotatorConfig): ErrorRedactor {
  const tokens = redactionTokens(config);
  const overlap = tokens.reduce((maximum, token) => Math.max(maximum, token.length), 0);
  if (tokens.length === 0) return { overlap };
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return { overlap, pattern: new RegExp(escaped.join("|"), "gu") };
}

function sanitizeText(text: string, redactor: ErrorRedactor): string {
  // Bound work before matching while retaining enough overlap to catch a
  // secret prefix that starts just before the displayed truncation boundary.
  const bounded = text.slice(0, MAX_FORWARDED_ERROR_TEXT + redactor.overlap);
  if (!redactor.pattern) return bounded.slice(0, MAX_FORWARDED_ERROR_TEXT);

  // Tokens are intentionally bounded prefixes so very large command/env keys
  // cannot force equally large encoded copies or regular expressions. Once a
  // prefix matches, discard the rest of this string leaf: replacing only the
  // prefix would expose the credential suffix, which is often reconstructable.
  redactor.pattern.lastIndex = 0;
  const match = redactor.pattern.exec(bounded);
  if (!match) return bounded.slice(0, MAX_FORWARDED_ERROR_TEXT);
  const marker = "[REDACTED]";
  const visiblePrefix = bounded.slice(0, Math.min(match.index, MAX_FORWARDED_ERROR_TEXT - marker.length));
  return `${visiblePrefix}${marker}`;
}

/** Apply the same credential redaction before rendering or persisting reports. */
export function sanitizeRotatorErrorText(text: string, config: RotatorConfig): string {
  return sanitizeText(text, createErrorRedactor(config));
}

function safeErrorText(
  error: unknown,
  config: RotatorConfig,
  redactor = createErrorRedactor(config),
): string {
  try {
    return sanitizeText(errorText(error), redactor);
  } catch {
    return "provider error";
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizedClone(
  value: unknown,
  config: RotatorConfig,
  redactor = createErrorRedactor(config),
  seen = new WeakMap<object, unknown>(),
  budget = { remaining: 4_096 },
  depth = 0,
): unknown {
  if (typeof value === "string") return sanitizeText(value, redactor);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return "[Unsupported]";
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 32 || budget.remaining <= 0) return "[Truncated]";
  budget.remaining -= 1;
  const existing = seen.get(value);
  if (existing !== undefined) return "[Circular]";

  if (Array.isArray(value)) {
    const cloned: unknown[] = [];
    seen.set(value, cloned);
    for (const entry of value.slice(0, 256)) {
      cloned.push(sanitizedClone(entry, config, redactor, seen, budget, depth + 1));
    }
    if (value.length > 256) cloned.push("[Truncated]");
    return cloned;
  }

  const cloned: Record<PropertyKey, unknown> = {};
  seen.set(value, cloned);
  const keys = Reflect.ownKeys(value);
  for (const key of keys.slice(0, 256)) {
    try {
      const clonedKey = typeof key === "string" ? sanitizeText(key, redactor) : "[Symbol]";
      Object.defineProperty(cloned, clonedKey, {
        value: sanitizedClone((value as Record<PropertyKey, unknown>)[key], config, redactor, seen, budget, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch {
      // Provider diagnostics should be plain data. Ignore inaccessible extras.
    }
  }
  if (keys.length > 256) cloned.truncated = "[Truncated]";
  return cloned;
}

const ASSISTANT_PROTOCOL_FIELDS = [
  "role",
  "content",
  "api",
  "provider",
  "model",
  "responseModel",
  "responseId",
  "usage",
  "stopReason",
  "stopReasonRaw",
  "timestamp",
] as const;

function cloneProtocolValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // Provider protocol values should be cloneable. Preserve them rather than
    // deleting already-visible assistant output if a custom adapter is not.
    return value;
  }
}

function preserveAssistantProtocolFields(original: unknown, sanitized: unknown): unknown {
  if (!isRecord(original) || !isRecord(sanitized)) return sanitized;
  for (const field of ASSISTANT_PROTOCOL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(original, field)) {
      sanitized[field] = cloneProtocolValue(original[field]);
    }
  }
  return sanitized;
}

function sanitizeAssistantErrorMessage(value: unknown, config: RotatorConfig): unknown {
  if (!isRecord(value)) return sanitizedClone(value, config);
  const redactor = createErrorRedactor(config);
  const cloned: Record<PropertyKey, unknown> = {};
  const seen = new WeakMap<object, unknown>([[value, cloned]]);
  const budget = { remaining: 4_096 };
  const protocolFields = new Set<string>(ASSISTANT_PROTOCOL_FIELDS);
  const keys = Reflect.ownKeys(value);
  for (const key of keys.slice(0, 256)) {
    try {
      const stableField = typeof key === "string" &&
        (protocolFields.has(key) || key === "errorMessage" || key === "diagnostics");
      const clonedKey = stableField
        ? key
        : typeof key === "string"
          ? sanitizeText(key, redactor)
          : "[Symbol]";
      const clonedValue = protocolFields.has(String(key))
        ? cloneProtocolValue(value[key])
        : sanitizedClone(value[key], config, redactor, seen, budget, 1);
      Object.defineProperty(cloned, clonedKey, {
        value: clonedValue,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch {
      // Ignore inaccessible non-protocol extras from custom adapters.
    }
  }
  if (keys.length > 256) cloned.truncated = "[Truncated]";
  return cloned;
}

function sanitizeForwardedEvent(
  event: AssistantEventLike,
  config: RotatorConfig,
  contextOverflow = false,
): AssistantEventLike {
  if (!isErrorTerminal(event)) return event;
  const originalDetail = safeErrorText(event, config);
  const error = sanitizeAssistantErrorMessage(event.error, config);
  if (isRecord(error)) {
    finalizeErrorMessage(
      error as unknown as AssistantMessageLike,
      "provider_terminal_finalized",
      originalDetail,
      config,
      undefined,
      contextOverflow,
    );
  }
  // Error event envelope names are protocol, not diagnostic data. Rebuilding it
  // avoids a secret prefix such as "error" rewriting the `error` property key.
  return { type: "error", reason: event.reason, error };
}

function forwardEvent(
  output: AssistantEventStreamLike,
  event: AssistantEventLike,
  config: RotatorConfig,
  contextOverflow = false,
): void {
  output.push(sanitizeForwardedEvent(event, config, contextOverflow));
}


function diagnosticStatus(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.length <= 16 && /^\d+$/u.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

function diagnosticHeaders(details: Record<PropertyKey, unknown>): Record<string, string> {
  const direct = details.retryAfter ?? details.retry_after;
  if (typeof direct === "string" && direct.length <= 128) return { "retry-after": direct };
  if (isRecord(details.headers)) {
    for (const [name, value] of Object.entries(details.headers)) {
      if (name.toLowerCase() === "retry-after" && typeof value === "string" && value.length <= 128) {
        return { "retry-after": value };
      }
    }
  }
  return {};
}

function statusForFailureKind(kind: string): number | undefined {
  if (["invalid_request", "invalid_request_error", "refusal", "safety", "malformed_response"].includes(kind)) {
    return 400;
  }
  if (["auth", "authentication", "authentication_error", "authorization"].includes(kind)) return 401;
  if (["permission", "permission_error", "forbidden"].includes(kind)) return 403;
  if (["rate_limit", "rate_limit_error"].includes(kind)) return 429;
  if (["overloaded", "overloaded_error", "server_error"].includes(kind)) return 503;
  return undefined;
}

function classifyTerminalDiagnostic(
  event: AssistantEventLike,
  config: RotatorConfig,
): DiagnosticDecision | undefined {
  if (!isErrorTerminal(event) || !isRecord(event.error) || !Array.isArray(event.error.diagnostics)) {
    return undefined;
  }

  let httpDecision: DiagnosticDecision | undefined;
  for (const diagnostic of event.error.diagnostics.slice(0, 256)) {
    if (!isRecord(diagnostic)) continue;
    if (diagnostic.type === "provider_transport_failure") {
      // Pi uses this diagnostic for failures of the selected transport. It is
      // target health, not an HTTP response or credential verdict.
      return { kind: "network" };
    }
    if (
      diagnostic.type !== "provider_stream_failure" &&
      diagnostic.type !== "pi_messages_response_failure" &&
      diagnostic.type !== "bedrock_response_failure"
    ) {
      continue;
    }
    if (!isRecord(diagnostic.details)) continue;

    const kind =
      typeof diagnostic.details.kind === "string" && diagnostic.details.kind.length <= 128
        ? diagnostic.details.kind.trim().toLowerCase().replaceAll("-", "_")
        : "";
    const status = diagnosticStatus(diagnostic.details.status) ?? statusForFailureKind(kind);
    if (status === undefined) continue;
    httpDecision = {
      kind: "http",
      decision: config.retryStatuses.has(status) ? "retry" : "forward",
      response: { status, headers: diagnosticHeaders(diagnostic.details) },
    };
  }
  return httpDecision;
}

function anthropicInBandStatus(event: AssistantEventLike): number | undefined {
  if (!isErrorTerminal(event) || !isRecord(event.error) || typeof event.error.errorMessage !== "string") {
    return undefined;
  }
  const message = event.error.errorMessage;
  if (message.length > 16_384 || !message.trimStart().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!isRecord(parsed) || parsed.type !== "error" || !isRecord(parsed.error)) return undefined;
    const kind = parsed.error.type;
    return typeof kind === "string" && kind.length <= 128
      ? statusForFailureKind(kind.trim().toLowerCase().replaceAll("-", "_"))
      : undefined;
  } catch {
    return undefined;
  }
}

function piAdapterStatusFallback(model: ModelLike, event: AssistantEventLike): number | undefined {
  if (!isErrorTerminal(event) || !isRecord(event.error) || typeof event.error.errorMessage !== "string") {
    return undefined;
  }
  if (model.api === "anthropic-messages") {
    const inBand = anthropicInBandStatus(event);
    if (inBand !== undefined) return inBand;
  }

  const message = event.error.errorMessage.slice(0, 256);
  let match: RegExpExecArray | null = null;
  if (
    model.api === "openai-completions" ||
    model.api === "anthropic-messages" ||
    model.api === "google-generative-ai" ||
    model.api === "google-vertex"
  ) {
    // Pi's shared error formatter produces either `<status> <message>` (SDK
    // message already complete) or `<status>: <body>` (separate parsed body).
    match = /^\s*([45]\d{2})(?=\s|:)/u.exec(message);
  } else if (model.api === "openai-responses") {
    match = /^\s*OpenAI API error\s*\(([45]\d{2})\):/u.exec(message);
  } else if (model.api === "azure-openai-responses") {
    match = /^\s*Azure OpenAI API error\s*\(([45]\d{2})\):/u.exec(message);
  }
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 400 && status <= 599 ? status : undefined;
}

function forwardFinalTerminal(
  output: AssistantEventStreamLike,
  model: ModelLike,
  event: AssistantEventLike,
  response: ProviderResponseLike | undefined,
  config: RotatorConfig,
  contextOverflow = false,
): void {
  const terminalDetail = isErrorTerminal(event) ? safeErrorText(event, config) : undefined;
  const looksLikeHostAuthFailure =
    isErrorTerminal(event) &&
    ((response !== undefined && (response.status === 401 || response.status === 403)) ||
      /^\s*(?:401|403)(?:\s|:|$)/u.test(terminalDetail ?? ""));
  if (looksLikeHostAuthFailure) {
    // Do not expose a raw auth-looking terminal to Pi's host policy. The pool
    // has already applied the credential verdict and finalized this attempt.
    emitSyntheticError(
      output,
      model,
      "The selected credential was rejected and the credential rotator finalized this request.",
      "error",
      config,
      terminalDetail,
      event.error as AssistantMessageLike,
    );
    return;
  }
  if (event.type === "done" && response && response.status >= 400) {
    emitSyntheticError(
      output,
      model,
      "The provider returned an unsuccessful HTTP response without an error terminal.",
      "error",
      config,
      undefined,
      event.message as AssistantMessageLike,
    );
    return;
  }
  forwardEvent(output, event, config, contextOverflow);
}

function tokenOccurrence(value: string, token: string, cursor: number): number {
  let index = value.indexOf(token, cursor);
  while (index >= 0) {
    const before = index === 0 ? "" : value[index - 1] ?? "";
    const afterIndex = index + token.length;
    const after = afterIndex >= value.length ? "" : value[afterIndex] ?? "";
    const startsWord = /^[A-Za-z0-9_]$/u.test(token[0] ?? "");
    const endsWord = /^[A-Za-z0-9_]$/u.test(token[token.length - 1] ?? "");
    const embeddedAtStart = startsWord && /^[A-Za-z0-9_]$/u.test(before);
    const embeddedAtEnd = endsWord && /^[A-Za-z0-9_]$/u.test(after);
    if (!embeddedAtStart && !embeddedAtEnd) return index;
    index = value.indexOf(token, index + 1);
  }
  return -1;
}

function replaceTokensOnce(value: string, replacements: ReadonlyMap<string, string>): string {
  const tokens = [...replacements.keys()].filter(Boolean).sort((left, right) => right.length - left.length);
  if (tokens.length === 0) return value;
  let cursor = 0;
  const chunks: string[] = [];
  while (cursor < value.length) {
    let matched: string | undefined;
    let matchIndex = value.length;
    for (const token of tokens) {
      const index = tokenOccurrence(value, token, cursor);
      if (index < 0 || index > matchIndex) continue;
      if (index < matchIndex || (matched !== undefined && token.length > matched.length)) {
        matched = token;
        matchIndex = index;
      }
    }
    if (matched === undefined) {
      chunks.push(value.slice(cursor));
      break;
    }
    chunks.push(value.slice(cursor, matchIndex), replacements.get(matched) ?? "");
    cursor = matchIndex + matched.length;
  }
  return chunks.join("");
}

function rotateEmbeddedAuthHeaders(
  headers: StreamOptionsLike["headers"],
  previousApiKey: string | undefined,
  selectedApiKey: string,
  config: RotatorConfig,
): StreamOptionsLike["headers"] {
  if (!headers) return undefined;
  const oldSecrets = new Set([
    ...(previousApiKey ? [previousApiKey] : []),
    ...config.keys.map((key) => key.value).filter(Boolean),
  ]);
  const replacements = new Map<string, string>();
  const selectedBytes = Buffer.from(selectedApiKey, "utf8");
  for (const oldSecret of oldSecrets) {
    if (oldSecret === selectedApiKey) continue;
    const oldBytes = Buffer.from(oldSecret, "utf8");
    replacements.set(oldSecret, selectedApiKey);
    try {
      replacements.set(encodeURIComponent(oldSecret), encodeURIComponent(selectedApiKey));
    } catch {
      // An unpaired surrogate has no canonical encodeURIComponent form.
    }
    replacements.set(oldBytes.toString("base64"), selectedBytes.toString("base64"));
    replacements.set(oldBytes.toString("base64url"), selectedBytes.toString("base64url"));
  }

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      typeof value === "string" ? replaceTokensOnce(value, replacements) : value,
    ]),
  );
}

function notifyStateChange(deps: RotatingStreamDependencies, snapshot: PoolSnapshot): void {
  if (!deps.onStateChange) return;
  try {
    // Footer rendering is best-effort UI work. Never add its latency to a
    // provider attempt or turn a UI failure into a request failure.
    void Promise.resolve(deps.onStateChange(snapshot)).catch(() => undefined);
  } catch {
    // UI/status updates must never break provider requests.
  }
}

function describeUnavailable(snapshot: PoolSnapshot, targetId: string): string {
  const now = Date.now();
  if (snapshot.poolCooldownUntil > now) {
    return `pool cooldown until ${new Date(snapshot.poolCooldownUntil).toISOString()}`;
  }
  const target = snapshot.targets.find((entry) => entry.id === targetId);
  if (target && target.cooldownUntil > now) {
    return `target circuit open until ${new Date(target.cooldownUntil).toISOString()}`;
  }
  const disabled = snapshot.keys.filter((key) => key.disabled).map((key) => key.id);
  const cooling = snapshot.keys.filter((key) => !key.disabled && key.cooldownUntil > now);
  const details: string[] = [];

  if (disabled.length > 0) details.push(`disabled: ${disabled.join(", ")}`);
  if (cooling.length > 0) {
    const earliest = Math.min(...cooling.map((key) => key.cooldownUntil));
    details.push(`cooldown until ${new Date(earliest).toISOString()}: ${cooling.map((key) => key.id).join(", ")}`);
  }
  return details.length > 0 ? details.join("; ") : "no eligible keys remain for this request";
}

async function runAttempt(
  deps: RotatingStreamDependencies,
  output: AssistantEventStreamLike,
  model: ModelLike,
  context: ContextLike,
  options: StreamOptionsLike | undefined,
  redactionConfig: RotatorConfig,
  selectedKey: { id: string; value: string },
): Promise<AttemptResult> {
  let response: ProviderResponseLike | undefined;
  let decision: "forward" | "retry" | undefined;
  let terminalEvent: AssistantEventLike | undefined;
  const pendingEvents: AssistantEventLike[] = [];
  let forwardedAny = false;
  let latestPartial: AssistantMessageLike | undefined;
  let contextOverflow = false;
  let callbackFailure: { name: "onPayload" | "onResponse"; error: unknown } | undefined;

  const forwardOne = (event: AssistantEventLike): void => {
    forwardEvent(output, event, redactionConfig);
    if (isRecord(event.partial)) latestPartial = event.partial as unknown as AssistantMessageLike;
    forwardedAny = true;
  };
  const heldPending = (): { pendingEvents?: AssistantEventLike[] } =>
    pendingEvents.length > 0 ? { pendingEvents: [...pendingEvents] } : {};
  const heldPartial = (): { partialMessage?: AssistantMessageLike } =>
    latestPartial === undefined ? {} : { partialMessage: latestPartial };
  const reportCallbackFailure = (name: "onPayload" | "onResponse", error: unknown): void => {
    if (callbackFailure) return;
    callbackFailure = { name, error };
    emitSyntheticError(
      output,
      model,
      `${name} callback failed. The provider attempt was stopped without penalizing the credential.`,
      "error",
      redactionConfig,
      safeErrorText(error, redactionConfig),
      latestPartial,
    );
  };

  const originalOnPayload = options?.onPayload;
  const originalOnResponse = options?.onResponse;
  const retryAbort = new AbortController();
  const attemptSignal = options?.signal
    ? AbortSignal.any([options.signal, retryAbort.signal])
    : retryAbort.signal;
  const rememberResponse = (received: ProviderResponseLike): void => {
    response = { status: received.status, headers: { ...received.headers } };
    if (!forwardedAny) {
      // Some adapters (notably Codex in pi-ai 0.84.x) report their own internal
      // attempts. Until output commits, the newest physical response wins.
      decision = deps.config.retryStatuses.has(received.status) ? "retry" : "forward";
    }
  };
  const discardTentativeSuccess = (): void => {
    // An HTTP handshake is not a completed streamed response. A body that
    // breaks or ends before semantic output is still eligible for failover.
    if (!forwardedAny && response && response.status >= 200 && response.status < 400) {
      response = undefined;
      decision = deps.config.retryNetworkErrors ? undefined : "forward";
    }
  };
  const configuredFetch = options?.fetch;
  const originalFetch = (typeof configuredFetch === "function" ? configuredFetch : globalThis.fetch) as typeof fetch;
  const observedFetch: typeof fetch = async (input, init) => {
    const fetched = await originalFetch(input, init);
    try {
      // Several Pi 0.84.x SDK adapters call onResponse only after a successful
      // `.withResponse()`. Observing the injected fetch preserves non-2xx
      // status and Retry-After without consuming or cloning the response body.
      rememberResponse({
        status: fetched.status,
        headers: Object.fromEntries(fetched.headers.entries()),
      });
    } catch {
      // A non-standard caller fetch must keep its original behavior even when
      // its response metadata cannot be inspected.
    }
    return fetched;
  };
  const rotatedHeaders = rotateEmbeddedAuthHeaders(
    options?.headers,
    options?.apiKey,
    selectedKey.value,
    deps.config,
  );
  const attemptOptions: StreamOptionsLike = {
    ...options,
    signal: attemptSignal,
    ...(rotatedHeaders ? { headers: rotatedHeaders } : {}),
    apiKey: selectedKey.value,
    maxRetries: 0,
    fetch: observedFetch,
    ...(originalOnPayload
      ? {
          onPayload: async (payload: unknown, receivedModel: ModelLike) => {
            try {
              return await originalOnPayload(payload, receivedModel);
            } catch (error) {
              reportCallbackFailure("onPayload", error);
              throw error;
            }
          },
        }
      : {}),
    onResponse: async (received, receivedModel) => {
      rememberResponse(received);
      try {
        await originalOnResponse?.(received, receivedModel);
      } catch (error) {
        reportCallbackFailure("onResponse", error);
        throw error;
      } finally {
        if (!forwardedAny && decision === "retry") retryAbort.abort();
      }
    },
  };

  let source: AssistantEventStreamLike;
  try {
    source = deps.baseStreamSimple(model, context, attemptOptions);
  } catch (error) {
    if (callbackFailure) return { outcome: "callback-error", response, error: callbackFailure.error };
    if (options?.signal?.aborted) return { outcome: "aborted", response, error };
    return deps.config.retryNetworkErrors
      ? { outcome: "retry-network", response, error }
      : { outcome: "forwarded", response, error, started: false, ...heldPending() };
  }

  try {
    for await (const event of source) {
      if (callbackFailure) return { outcome: "callback-error", response, error: callbackFailure.error };
      if (options?.signal?.aborted) return { outcome: "aborted", response, started: forwardedAny, ...heldPartial() };

      if (!isTerminal(event)) {
        if (forwardedAny) {
          forwardOne(event);
          continue;
        }
        // `start` and block-start events can be emitted before an in-band SSE
        // failure. Buffer them until real text/thinking/tool content commits the
        // attempt, so a 200 + empty start + rate_limit_error can still fail over.
        pendingEvents.push(event);
        if (isSemanticIncrement(event)) {
          decision = "forward";
          for (const pending of pendingEvents.splice(0)) forwardOne(pending);
        }
        continue;
      }

      // Hold the terminal until the outer layer has durably recorded the
      // outcome. Incremental events remain zero-buffer and are forwarded above.
      terminalEvent = event;
      if (isErrorTerminal(event)) {
        const diagnostic = classifyTerminalDiagnostic(event, deps.config);
        if (diagnostic?.kind === "network") {
          // A Pi transport diagnostic is authoritative even when an adapter
          // reported a tentative HTTP 200 before its stream transport failed.
          response = undefined;
          if (!forwardedAny) decision = deps.config.retryNetworkErrors ? undefined : "forward";
        } else if (diagnostic?.kind === "http") {
          // Structured provider diagnostics remain authoritative for durable
          // accounting even after semantic output. Output commitment only
          // prevents failover/replay; it must not turn a late 401 into success.
          response = diagnostic.response;
          if (!forwardedAny) decision = diagnostic.decision;
        } else {
          const fallbackStatus = piAdapterStatusFallback(model, event);
          // A successful HTTP handshake is only tentative for streaming APIs:
          // Anthropic can send a typed error as an HTTP-200 SSE event. A real
          // non-2xx response observed through fetch/onResponse stays authoritative.
          if (fallbackStatus !== undefined && (response === undefined || response.status < 400)) {
            response = { status: fallbackStatus, headers: {} };
            if (!forwardedAny) {
              decision = deps.config.retryStatuses.has(fallbackStatus) ? "retry" : "forward";
            }
          }
        }
        const failure = event.error as AssistantMessageLike;
        const tentativeSuccess = response !== undefined && response.status >= 200 && response.status < 400;
        if (
          !forwardedAny &&
          !partialHasSemanticContent(failure) &&
          failure.stopReason === "error" &&
          diagnostic?.kind !== "network" &&
          (response === undefined || tentativeSuccess || response.status === 400 || response.status === 413) &&
          deps.errorPolicy?.isContextOverflow(failure)
        ) {
          contextOverflow = true;
          // This is a deterministic input failure, not a credential/transport
          // verdict. Do not rotate keys or open the target circuit.
          if (response === undefined || tentativeSuccess) response = { status: 400, headers: {} };
          decision = "forward";
        } else if (
          tentativeSuccess &&
          deps.errorPolicy?.isRetryableAssistantError(failure)
        ) {
          // Plain SDK transport errors may have no structured diagnostic even
          // on newer hosts. Do not let an earlier HTTP 200 hide this failure.
          response = undefined;
          if (!forwardedAny) decision = deps.config.retryNetworkErrors ? undefined : "forward";
        }
      } else if (decision === undefined) {
        decision = "forward";
      }
    }
  } catch (error) {
    if (callbackFailure) return { outcome: "callback-error", response, error: callbackFailure.error };

    // A terminal event is authoritative even if a non-conforming iterator throws
    // while being closed. In particular, a late abort must not append a second
    // terminal after a provider terminal has already been observed.
    if (terminalEvent) {
      if (decision === "retry" && response) return { outcome: "retry-http", response, error: terminalEvent };
      if (decision === "forward") {
        return {
          outcome: "forwarded",
          response,
          terminalEvent,
          contextOverflow,
          started: forwardedAny,
          ...heldPending(),
          ...(isErrorTerminal(terminalEvent) ? { error: terminalEvent } : {}),
        };
      }
    }
    if (options?.signal?.aborted) return { outcome: "aborted", response, error, started: forwardedAny, ...heldPartial() };
    discardTentativeSuccess();
    if (decision === "forward" || forwardedAny) {
      return { outcome: "forwarded", response, error, started: forwardedAny, ...heldPartial(), ...heldPending() };
    }
    if (decision === "retry" && response) return { outcome: "retry-http", response, error };
    return deps.config.retryNetworkErrors
      ? { outcome: "retry-network", response, error }
      : { outcome: "forwarded", response, error, started: false, ...heldPending() };
  }

  if (callbackFailure) return { outcome: "callback-error", response, error: callbackFailure.error };

  // Once a terminal has been observed it wins over an abort that races with the
  // iterator's final return. This prevents done+aborted duplicate terminals.
  if (terminalEvent) {
    if (decision === "retry" && response) {
      return { outcome: "retry-http", response, ...(isErrorTerminal(terminalEvent) ? { error: terminalEvent } : {}) };
    }
    if (decision === "forward") {
      return {
        outcome: "forwarded",
        response,
        terminalEvent,
        contextOverflow,
        started: forwardedAny,
        ...heldPending(),
        ...(isErrorTerminal(terminalEvent) ? { error: terminalEvent } : {}),
      };
    }
    if (isErrorTerminal(terminalEvent)) {
      return deps.config.retryNetworkErrors
        ? { outcome: "retry-network", response, error: terminalEvent }
        : {
            outcome: "forwarded",
            response,
            error: terminalEvent,
            terminalEvent,
            started: forwardedAny,
            ...heldPending(),
          };
    }
  }

  if (options?.signal?.aborted) return { outcome: "aborted", response, started: forwardedAny, ...heldPartial() };

  const error = new Error("Provider stream ended without a terminal event");
  discardTentativeSuccess();
  if (decision === "forward" || forwardedAny || !deps.config.retryNetworkErrors) {
    return { outcome: "forwarded", response, error, started: forwardedAny, ...heldPartial(), ...heldPending() };
  }
  return { outcome: "retry-network", response, error };
}

function configuredTargetApi(config: RotatorConfig, provider: string): string | undefined {
  const configuredTargets = config.targets?.length
    ? config.targets
    : [{ provider: config.provider, api: config.api }];
  return configuredTargets.find((target) => target.provider === provider)?.api;
}

export function createRotatingStream(deps: RotatingStreamDependencies): StreamSimpleLike {
  return (model, context, options) => {
    const output = deps.createEventStream();
    const errorConfig = requestRedactionConfig(deps.config, options);
    let lastVisiblePartial: AssistantMessageLike | undefined;

    const expectedApi = configuredTargetApi(deps.config, model.provider);
    if (expectedApi === undefined || model.api !== expectedApi) {
      emitSyntheticError(
        output,
        model,
        expectedApi === undefined
          ? `Provider "${model.provider}" is not managed by this credential pool.`
          : `Provider "${model.provider}" is configured for API "${expectedApi}", not "${model.api}".`,
        "error",
        errorConfig,
      );
      return output;
    }

    void (async () => {
      const excludedKeyIds = new Set<string>();
      let lastFailure = "no attempt was made";
      let lastDiagnostic: string | undefined;

      for (let attempt = 1; attempt <= deps.config.maxAttemptsPerRequest; attempt += 1) {
        if (options?.signal?.aborted) {
          emitSyntheticError(
            output,
            model,
            "The provider request was aborted before a credential could be selected.",
            "aborted",
            errorConfig,
          );
          return;
        }

        const selection = await deps.pool.selectWithSnapshot(excludedKeyIds, options?.signal, model.provider);
        const selected = selection.selected;
        if (options?.signal?.aborted) {
          emitSyntheticError(output, model, "The provider request was aborted.", "aborted", errorConfig);
          return;
        }
        if (!selected) {
          if (excludedKeyIds.size > 0) break;
          const unavailable = describeUnavailable(selection.snapshot, model.provider);
          emitSyntheticError(
            output,
            model,
            `No rotation entry is currently available (${unavailable}).`,
            "error",
            errorConfig,
          );
          return;
        }
        excludedKeyIds.add(selected.id);
        notifyStateChange(deps, selection.snapshot);

        const result = await runAttempt(deps, output, model, context, options, errorConfig, selected);
        lastVisiblePartial = result.partialMessage;
        if (result.terminalEvent?.type === "error" && isRecord(result.terminalEvent.error)) {
          lastVisiblePartial = result.terminalEvent.error as unknown as AssistantMessageLike;
        } else if (result.terminalEvent?.type === "done" && isRecord(result.terminalEvent.message)) {
          lastVisiblePartial = result.terminalEvent.message as unknown as AssistantMessageLike;
        }

        if (result.outcome === "callback-error") {
          // A caller hook failed, not the credential or provider transport. The
          // selected attempt remains visible but the key is not quarantined.
          return;
        }

        if (result.outcome === "forwarded") {
          let snapshot: PoolSnapshot;
          if (result.response && result.response.status >= 200 && result.response.status < 400 && !result.error) {
            snapshot = await deps.pool.recordSuccess(
              selected.id,
              result.response.status,
              selected.epoch,
              selected.targetId,
              selected.attemptNumber,
              selected.credentialFingerprint,
            );
          } else if (result.response) {
            snapshot = await deps.pool.recordFailure(
              selected.id,
              result.response,
              selected.epoch,
              selected.targetId,
              selected.attemptNumber,
              selected.credentialFingerprint,
            );
          } else if (result.error) {
            snapshot = await deps.pool.recordNetworkFailure(
              selected.id,
              selected.epoch,
              selected.targetId,
              selected.attemptNumber,
              selected.credentialFingerprint,
            );
          } else {
            snapshot = await deps.pool.recordSuccess(
              selected.id,
              0,
              selected.epoch,
              selected.targetId,
              selected.attemptNumber,
              selected.credentialFingerprint,
            );
          }
          notifyStateChange(deps, snapshot);
          for (const pending of result.pendingEvents ?? []) {
            forwardEvent(output, pending, errorConfig);
          }
          if (result.terminalEvent) {
            forwardFinalTerminal(
              output, model, result.terminalEvent, result.response, errorConfig, result.contextOverflow,
            );
          } else {
            emitSyntheticError(
              output,
              model,
              result.started
                ? "The provider stream failed after output began. Automatic retry was stopped to avoid duplicate output."
                : "The provider stream failed before producing a terminal event.",
              "error",
              errorConfig,
              result.error ? safeErrorText(result.error, errorConfig) : "Provider stream ended unexpectedly.",
              lastVisiblePartial,
            );
          }
          return;
        }

        if (result.outcome === "aborted") {
          notifyStateChange(deps, selection.snapshot);
          emitSyntheticError(
            output,
            model,
            "The provider request was aborted.",
            "aborted",
            errorConfig,
            undefined,
            lastVisiblePartial,
          );
          return;
        }

        let snapshot: PoolSnapshot;
        if (result.outcome === "retry-http" && result.response) {
          snapshot = await deps.pool.recordFailure(
              selected.id,
              result.response,
              selected.epoch,
              selected.targetId,
              selected.attemptNumber,
              selected.credentialFingerprint,
            );
          lastFailure = "the provider returned a retryable response";
          lastDiagnostic = result.error ? safeErrorText(result.error, errorConfig) : undefined;
        } else {
          snapshot = await deps.pool.recordNetworkFailure(
              selected.id,
              selected.epoch,
              selected.targetId,
              selected.attemptNumber,
              selected.credentialFingerprint,
            );
          lastFailure = "the provider failed before a usable response";
          lastDiagnostic = result.error ? safeErrorText(result.error, errorConfig) : undefined;
        }
        notifyStateChange(deps, snapshot);
      }

      emitSyntheticError(
        output,
        model,
        `Credential failover exhausted ${excludedKeyIds.size} attempt(s); last failure: ${lastFailure}.`,
        "error",
        errorConfig,
        lastDiagnostic,
      );
    })().catch((error: unknown) => {
      if (options?.signal?.aborted) {
        emitSyntheticError(output, model, "The provider request was aborted.", "aborted", errorConfig);
        return;
      }
      emitSyntheticError(
        output,
        model,
        "The key rotator failed internally before it could finalize the request.",
        "error",
        errorConfig,
        safeErrorText(error, errorConfig),
        lastVisiblePartial,
      );
    });

    return output;
  };
}
