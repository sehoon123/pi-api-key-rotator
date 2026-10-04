import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MANAGED_KEY_PLACEHOLDER } from "../src/extension.ts";
import { startKeyRotator } from "../src/start.ts";
import type {
  ExtensionApiLike,
  ExtensionContextLike,
  StreamSimpleLike,
} from "../src/types.ts";
import { TestEventStream } from "./helpers.ts";

class MockPi implements ExtensionApiLike {
  readonly providers = new Map<string, Parameters<ExtensionApiLike["registerProvider"]>[1]>();
  readonly commands = new Map<string, Parameters<ExtensionApiLike["registerCommand"]>[1]>();
  readonly handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContextLike) => Promise<void> | void>>();

  registerProvider(name: string, config: Parameters<ExtensionApiLike["registerProvider"]>[1]): void {
    this.providers.set(name, config);
  }
  registerCommand(name: string, options: Parameters<ExtensionApiLike["registerCommand"]>[1]): void {
    this.commands.set(name, options);
  }
  on(
    event: "session_start" | "model_select" | "session_shutdown",
    handler: (event: unknown, ctx: ExtensionContextLike) => Promise<void> | void,
  ): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
  async emit(event: "session_start" | "model_select" | "session_shutdown", payload: unknown, ctx: ExtensionContextLike) {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
}

function makeUi() {
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx: ExtensionContextLike = {
    ui: {
      notify(message, type) {
        notifications.push(type === undefined ? { message } : { message, type });
      },
      setStatus(key, text) {
        statuses.push({ key, text });
      },
    },
  };
  return { notifications, statuses, ctx };
}

const baseStreamSimple: StreamSimpleLike = () => new TestEventStream();
const hostOptions = {
  baseStreamSimple,
  createEventStream: () => new TestEventStream(),
};

test("a missing configuration uses Pi's host-resolved agent directory", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "pi-key-rotator-missing-"));
  const agentDir = join(homeDir, "host-agent");
  try {
    const pi = new MockPi();
    const warnings: string[] = [];
    const result = await startKeyRotator(pi, {
      ...hostOptions,
      agentDir,
      env: {},
      homeDir,
      warn: (message) => warnings.push(message),
    });

    assert.equal(result, "disabled");
    assert.equal(pi.providers.size, 0);
    const command = pi.commands.get("key-rotator");
    assert.ok(command);

    const ui = makeUi();
    await command.handler("status", ui.ctx);
    assert.equal(ui.notifications.at(-1)?.type, "error");
    const message = ui.notifications.at(-1)?.message ?? "";
    assert.match(message, /Configuration is missing at/);
    assert.ok(message.includes(join(agentDir, "key-rotator.json")));
    assert.ok(!message.includes(join(homeDir, ".pi", "agent", "key-rotator.json")));
    assert.match(message, /PI_CODING_AGENT_DIR or PI_KEY_ROTATOR_CONFIG/);
    assert.match(message, /run \/reload/);

    await pi.emit("session_start", {}, ui.ctx);
    assert.deepEqual(ui.statuses.at(-1), { key: "pi-api-key-rotator", text: "keys: disabled" });
    await pi.emit("session_shutdown", {}, ui.ctx);
    assert.deepEqual(ui.statuses.at(-1), { key: "pi-api-key-rotator", text: undefined });
    assert.equal(warnings.length, 1);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("an invalid configuration disables the extension without leaking a literal key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-invalid-"));
  const configFile = join(directory, "key-rotator.json");
  try {
    // Only one key: the loader requires at least two.
    await writeFile(
      configFile,
      JSON.stringify({
        provider: "p",
        api: "openai-completions",
        keys: [{ id: "only", value: "never-print-this-secret" }],
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const pi = new MockPi();
    const warnings: string[] = [];
    const result = await startKeyRotator(pi, {
      ...hostOptions,
      env: { PI_KEY_ROTATOR_CONFIG: configFile },
      homeDir: directory,
      warn: (message) => warnings.push(message),
    });

    assert.equal(result, "disabled");
    const ui = makeUi();
    await pi.commands.get("key-rotator")!.handler("", ui.ctx);
    const rendered = JSON.stringify({ warnings, notifications: ui.notifications });
    assert.match(rendered, /at least two key definitions/);
    assert.doesNotMatch(rendered, /never-print-this-secret/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed JSON document reports only a location, never the source text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-broken-"));
  const configFile = join(directory, "key-rotator.json");
  try {
    await writeFile(
      configFile,
      '{ "keys": [ { "id": "a", "value": "leaked-secret-value" } ',
      { encoding: "utf8", mode: 0o600 },
    );
    const pi = new MockPi();
    const warnings: string[] = [];
    const result = await startKeyRotator(pi, {
      ...hostOptions,
      env: { PI_KEY_ROTATOR_CONFIG: configFile },
      homeDir: directory,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result, "disabled");
    assert.match(warnings.join("\n"), /JSON parsing failed/);
    assert.doesNotMatch(warnings.join("\n"), /leaked-secret-value/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active startup injects Pi streams, registers inert auth, and exposes local doctor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-active-"));
  const configFile = join(directory, "key-rotator.json");
  const stateFile = join(directory, "state.json");
  try {
    await writeFile(
      configFile,
      JSON.stringify({
        configVersion: 1,
        poolId: "startup",
        provider: "startup-provider",
        api: "openai-completions",
        keys: [
          { id: "one", value: "startup-secret-one" },
          { id: "two", value: "startup-secret-two" },
        ],
        stateFile,
        maxStateFileBytes: 524_288,
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    let providerCalls = 0;
    const pi = new MockPi();
    const result = await startKeyRotator(pi, {
      baseStreamSimple: () => {
        providerCalls += 1;
        return new TestEventStream();
      },
      createEventStream: () => new TestEventStream(),
      env: { PI_KEY_ROTATOR_CONFIG: configFile },
      homeDir: directory,
      warn: () => {},
    });

    assert.equal(result, "active");
    assert.equal(pi.providers.get("startup-provider")?.apiKey, MANAGED_KEY_PLACEHOLDER);
    const ui = makeUi();
    await pi.commands.get("key-rotator")!.handler("doctor", ui.ctx);
    assert.equal(ui.notifications.at(-1)?.type, "warning");
    assert.match(
      ui.notifications.at(-1)?.message ?? "",
      /local submission uses openai-completions, but this Pi version exposes no post-bind acknowledgement/,
    );
    assert.match(ui.notifications.at(-1)?.message ?? "", /no provider requests sent/);
    assert.equal(providerCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("startup contains one corrupt pool while registering healthy pools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-key-rotator-partial-state-"));
  const configFile = join(directory, "key-rotator.json");
  const primaryState = join(directory, "primary.state.json");
  const secondaryState = join(directory, "secondary.state.json");
  const corruptEvidence = '{"malformed-state":';
  try {
    await writeFile(
      configFile,
      JSON.stringify({
        pools: [
          {
            poolId: "primary",
            provider: "primary-provider",
            api: "openai-completions",
            keys: [
              { id: "one", value: "primary-secret-one" },
              { id: "two", value: "primary-secret-two" },
            ],
            stateFile: primaryState,
          },
          {
            poolId: "secondary",
            provider: "secondary-provider",
            api: "openai-completions",
            keys: [
              { id: "one", value: "secondary-secret-one" },
              { id: "two", value: "secondary-secret-two" },
            ],
            stateFile: secondaryState,
          },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(secondaryState, corruptEvidence, { encoding: "utf8", mode: 0o600 });

    const pi = new MockPi();
    const result = await startKeyRotator(pi, {
      ...hostOptions,
      env: { PI_KEY_ROTATOR_CONFIG: configFile },
      homeDir: directory,
      warn: () => {},
    });

    assert.equal(result, "active");
    assert.ok(pi.providers.has("primary-provider"));
    assert.equal(pi.providers.has("secondary-provider"), false);
    assert.equal(await readFile(secondaryState, "utf8"), corruptEvidence);

    const ui = makeUi();
    ui.ctx.model = {
      provider: "secondary-provider",
      api: "openai-completions",
      id: "secondary-model",
    };
    await pi.emit("session_start", {}, ui.ctx);
    assert.match(ui.statuses.at(-1)?.text ?? "", /rotation inactive.*secondary.*disabled/i);
    await pi.commands.get("key-rotator")!.handler("status secondary", ui.ctx);
    assert.match(ui.notifications.at(-1)?.message ?? "", /evidence is preserved/i);
    assert.equal(await readFile(secondaryState, "utf8"), corruptEvidence);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
