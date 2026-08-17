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
  RotatorConfig,
  StreamOptionsLike,
  StreamSimpleLike,
} from "./types.ts";

export interface RotatingStreamDependencies {
  config: RotatorConfig;
  pool: KeyPool;
  baseStreamSimple: StreamSimpleLike;
  createEventStream: EventStreamFactory;
  onStateChange?: (snapshot: PoolSnapshot) => void | Promise<void>;
}

interface AttemptResult {
  outcome: "forwarded" | "retry-http" | "retry-network" | "aborted";
  response?: ProviderResponseLike | undefined;
  error?: unknown;
}

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

function emitSyntheticError(
  output: AssistantEventStreamLike,
  model: ModelLike,
  message: string,
  reason: "error" | "aborted" = "error",
): void {
  const error = syntheticMessage(model, reason, message);
  output.push({ type: "error", reason, error });
}

function isTerminal(event: AssistantEventLike): boolean {
  return event.type === "done" || event.type === "error";
}

function isErrorTerminal(event: AssistantEventLike | undefined): boolean {
  return event?.type === "error";
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
    return error.error.errorMessage.trim() || "provider error";
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error);
}

function safeErrorText(error: unknown, config: RotatorConfig): string {
  let text = errorText(error);
  for (const key of config.keys) {
    if (key.value.length > 0) text = text.split(key.value).join("[REDACTED]");
  }
  return text;
}

function flush(buffer: AssistantEventLike[], output: AssistantEventStreamLike): void {
  for (const event of buffer) output.push(event);
  buffer.length = 0;
}

function rotateEmbeddedAuthHeaders(
  headers: StreamOptionsLike["headers"],
  previousApiKey: string | undefined,
  selectedApiKey: string,
): StreamOptionsLike["headers"] {
  if (!headers) return undefined;
  if (!previousApiKey || previousApiKey === selectedApiKey) return { ...headers };

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      typeof value === "string" ? value.split(previousApiKey).join(selectedApiKey) : value,
    ]),
  );
}

async function notifyStateChange(deps: RotatingStreamDependencies): Promise<void> {
  if (!deps.onStateChange) return;
  try {
    await deps.onStateChange(await deps.pool.snapshot());
  } catch {
    // UI/status updates must never break provider requests.
  }
}

async function describeUnavailable(pool: KeyPool): Promise<string> {
  const snapshot = await pool.snapshot();
  const now = Date.now();
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
  selectedKey: { id: string; value: string },
): Promise<AttemptResult> {
  let response: ProviderResponseLike | undefined;
  let decision: "forward" | "retry" | undefined;
  let terminalEvent: AssistantEventLike | undefined;
  let forwardedAny = false;
  const buffer: AssistantEventLike[] = [];

  const originalOnResponse = options?.onResponse;
  const rotatedHeaders = rotateEmbeddedAuthHeaders(options?.headers, options?.apiKey, selectedKey.value);
  const attemptOptions: StreamOptionsLike = {
    ...options,
    ...(rotatedHeaders ? { headers: rotatedHeaders } : {}),
    apiKey: selectedKey.value,
    maxRetries: 0,
    onResponse: async (received, receivedModel) => {
      response = {
        status: received.status,
        headers: { ...received.headers },
      };
      decision = deps.config.retryStatuses.has(received.status) ? "retry" : "forward";
      await originalOnResponse?.(received, receivedModel);
      if (decision === "forward" && buffer.length > 0) {
        flush(buffer, output);
        forwardedAny = true;
      }
    },
  };

  let source: AssistantEventStreamLike;
  try {
    source = deps.baseStreamSimple(model, context, attemptOptions);
  } catch (error) {
    return options?.signal?.aborted
      ? { outcome: "aborted", error }
      : { outcome: "retry-network", error };
  }

  try {
    for await (const event of source) {
      if (isTerminal(event)) terminalEvent = event;
      if (decision === "forward") {
        output.push(event);
        forwardedAny = true;
      } else {
        buffer.push(event);
      }
    }
  } catch (error) {
    if (options?.signal?.aborted) {
      if (!forwardedAny) buffer.length = 0;
      return { outcome: "aborted", response, error };
    }
    if (decision === "forward" || forwardedAny) {
      flush(buffer, output);
      emitSyntheticError(output, model, `Provider stream failed after it started: ${safeErrorText(error, deps.config)}`);
      return { outcome: "forwarded", response, error };
    }
    return { outcome: "retry-network", response, error };
  }

  if (options?.signal?.aborted) {
    if (!forwardedAny) buffer.length = 0;
    return { outcome: "aborted", response };
  }

  if (decision === "retry" && response) {
    return { outcome: "retry-http", response };
  }

  if (decision === "forward") {
    if (buffer.length > 0) flush(buffer, output);
    if (!terminalEvent) {
      emitSyntheticError(output, model, "Provider stream ended without a terminal event.");
      return { outcome: "forwarded", response, error: new Error("Provider stream ended without a terminal event") };
    }
    return {
      outcome: "forwarded",
      response,
      ...(isErrorTerminal(terminalEvent) ? { error: terminalEvent } : {}),
    };
  }

  // Providers are expected to call onResponse for HTTP transports. If they did
  // not, a successful terminal event is still safe to forward. An error without
  // a response is treated as a network/client failure and can fail over.
  if (terminalEvent && !isErrorTerminal(terminalEvent)) {
    flush(buffer, output);
    return { outcome: "forwarded", response };
  }

  if (terminalEvent && isErrorTerminal(terminalEvent) && !deps.config.retryNetworkErrors) {
    flush(buffer, output);
    return { outcome: "forwarded", response };
  }

  return { outcome: "retry-network", response, error: terminalEvent };
}

export function createRotatingStream(deps: RotatingStreamDependencies): StreamSimpleLike {
  return (model, context, options) => {
    const output = deps.createEventStream();

    void (async () => {
      const excludedKeyIds = new Set<string>();
      let lastFailure = "no attempt was made";

      for (let attempt = 1; attempt <= deps.config.maxAttemptsPerRequest; attempt += 1) {
        if (options?.signal?.aborted) {
          emitSyntheticError(output, model, "The provider request was aborted before an API key could be selected.", "aborted");
          return;
        }

        const selected = await deps.pool.select(excludedKeyIds);
        if (!selected) {
          const unavailable = await describeUnavailable(deps.pool);
          emitSyntheticError(output, model, `No API key is currently available (${unavailable}).`);
          return;
        }
        excludedKeyIds.add(selected.id);
        await notifyStateChange(deps);

        const result = await runAttempt(deps, output, model, context, options, selected);

        if (result.outcome === "forwarded") {
          if (result.response && result.response.status >= 200 && result.response.status < 400 && !result.error) {
            await deps.pool.recordSuccess(selected.id, result.response.status);
          } else if (result.response) {
            await deps.pool.recordFailure(selected.id, result.response);
          } else if (result.error) {
            await deps.pool.recordNetworkFailure(selected.id);
          } else {
            await deps.pool.recordSuccess(selected.id, 0);
          }
          await notifyStateChange(deps);
          return;
        }

        if (result.outcome === "aborted") {
          await notifyStateChange(deps);
          emitSyntheticError(output, model, "The provider request was aborted.", "aborted");
          return;
        }

        if (result.outcome === "retry-http" && result.response) {
          await deps.pool.recordFailure(selected.id, result.response);
          lastFailure = `${selected.id} returned HTTP ${result.response.status}`;
        } else {
          await deps.pool.recordNetworkFailure(selected.id);
          lastFailure = `${selected.id} failed before an HTTP response${result.error ? `: ${safeErrorText(result.error, deps.config)}` : ""}`;
        }
        await notifyStateChange(deps);
      }

      emitSyntheticError(
        output,
        model,
        `API key failover exhausted ${deps.config.maxAttemptsPerRequest} attempt(s); last failure: ${lastFailure}.`,
      );
    })().catch((error: unknown) => {
      emitSyntheticError(output, model, `API key rotator failed internally: ${safeErrorText(error, deps.config)}`);
    });

    return output;
  };
}
