import type {
  AssistantEventLike,
  AssistantEventStreamLike,
  AssistantMessageLike,
  RotatorConfig,
} from "../src/types.ts";

export class TestEventStream implements AssistantEventStreamLike {
  private readonly queue: AssistantEventLike[] = [];
  private readonly waiters: Array<(result: IteratorResult<AssistantEventLike>) => void> = [];
  private done = false;
  private finalResult: Promise<AssistantMessageLike>;
  private resolveResult!: (message: AssistantMessageLike) => void;

  constructor() {
    this.finalResult = new Promise((resolvePromise) => {
      this.resolveResult = resolvePromise;
    });
  }

  push(event: AssistantEventLike): void {
    if (this.done) return;
    if (event.type === "done" && "message" in event) {
      this.done = true;
      this.resolveResult(event.message as AssistantMessageLike);
    } else if (event.type === "error" && "error" in event) {
      this.done = true;
      this.resolveResult(event.error as AssistantMessageLike);
    }

    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantEventLike> {
    while (true) {
      if (this.queue.length > 0) {
        const event = this.queue.shift();
        if (event) yield event;
      } else if (this.done) {
        return;
      } else {
        const next = await new Promise<IteratorResult<AssistantEventLike>>((resolvePromise) => {
          this.waiters.push(resolvePromise);
        });
        if (next.done) return;
        yield next.value;
      }
    }
  }

  result(): Promise<AssistantMessageLike> {
    return this.finalResult;
  }
}

export function assistantMessage(
  stopReason: AssistantMessageLike["stopReason"] = "stop",
  overrides: Partial<AssistantMessageLike> = {},
): AssistantMessageLike {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

export async function collect(stream: AssistantEventStreamLike): Promise<AssistantEventLike[]> {
  const events: AssistantEventLike[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export function makeConfig(overrides: Partial<RotatorConfig> = {}): RotatorConfig {
  return {
    provider: "test-provider",
    api: "openai-completions",
    keys: [
      { id: "key-1", env: "TEST_KEY_1", value: "secret-one" },
      { id: "key-2", env: "TEST_KEY_2", value: "secret-two" },
      { id: "key-3", env: "TEST_KEY_3", value: "secret-three" },
    ],
    requestsPerKey: 2,
    maxAttemptsPerRequest: 3,
    cooldownMs: 60_000,
    transientCooldownMs: 5_000,
    maxRetryAfterMs: 900_000,
    retryStatuses: new Set([401, 402, 403, 408, 409, 425, 429, 500, 502, 503, 504]),
    disableStatuses: new Set([401, 402, 403]),
    cooldownStatuses: new Set([429]),
    retryNetworkErrors: true,
    stateFile: "/tmp/pi-key-rotator-test-state.json",
    lockTimeoutMs: 5_000,
    staleLockMs: 30_000,
    configFile: "/tmp/pi-key-rotator-test-config.json",
    ...overrides,
  };
}

export function mutableClock(initial: number) {
  let current = initial;
  return {
    clock: { now: () => current },
    set(value: number) {
      current = value;
    },
    advance(milliseconds: number) {
      current += milliseconds;
    },
  };
}
