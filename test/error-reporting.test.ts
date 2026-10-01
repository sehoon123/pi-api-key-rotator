import assert from "node:assert/strict";
import { test } from "node:test";
import { ERROR_ENTRY_TYPE, installRotatorErrorReporting } from "../src/error-reporting.ts";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { registerMultiPoolKeyRotatorExtension } from "../src/multi-pool-extension.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type { ExtensionApiLike, ExtensionContextLike } from "../src/types.ts";
import { assistantMessage, makeConfig, TestEventStream } from "./helpers.ts";

function mockPi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContextLike) => unknown>>();
  const commands = new Map<string, Parameters<ExtensionApiLike["registerCommand"]>[1]>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const pi: ExtensionApiLike = {
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    registerProvider() {},
    registerCommand(name, options) { commands.set(name, options); },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  };
  return {
    pi, entries, commands,
    async emit(event: string, value: unknown, ctx: ExtensionContextLike) {
      for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
    },
  };
}

function context(entries: unknown[] = []) {
  const notifications: string[] = [];
  const ctx: ExtensionContextLike = {
    model: { provider: "test-provider", api: "openai-completions", id: "test-model" },
    sessionManager: { getEntries: () => entries },
    ui: { notify: (text) => { notifications.push(text); }, setStatus() {} },
  };
  return { ctx, notifications };
}

function failure(summary = "Credential failover exhausted 2 attempts.", detail = "Connection error.") {
  return { message: assistantMessage("error", {
    content: [],
    errorMessage: "The credential rotator stopped this request. Review diagnostics for details.",
    diagnostics: [
      { type: "provider_transport_failure", error: { stack: "raw stack secret-one" }, headers: "secret-two" },
      { type: "pi_key_rotator_final", error: { message: summary }, details: {
        source: "pi-api-key-rotator", reason: "rotator_terminal_error", detail,
      } },
    ],
  }) };
}

test("failure reports show the cause, re-redact it, and persist metadata only", async () => {
  const mock = mockPi();
  const { ctx, notifications } = context();
  const reporter = installRotatorErrorReporting(mock.pi, [makeConfig()]);
  reporter.restore(ctx);
  await mock.emit("message_end", failure("Failed with secret-one", "Connection error. secret-two"), ctx);
  assert.equal(mock.entries.length, 1);
  assert.equal(mock.entries[0]?.customType, ERROR_ENTRY_TYPE);
  const persisted = JSON.stringify(mock.entries);
  assert.match(persisted, /\[REDACTED\]/);
  assert.doesNotMatch(persisted, /secret-one|secret-two|raw stack|headers|diagnostics|content/);
  assert.match(notifications[0] ?? "", /Connection error/);
  assert.match(notifications[0] ?? "", /\/key-rotator errors/);
  reporter.show(ctx);
  assert.match(notifications.at(-1) ?? "", /Failed with \[REDACTED\]/);
});

test("unmanaged, unrelated, successful, and aborted messages are not reported", async () => {
  const mock = mockPi();
  const { ctx, notifications } = context();
  installRotatorErrorReporting(mock.pi, [makeConfig()]);
  for (const message of [
    assistantMessage("stop"),
    assistantMessage("aborted"),
    assistantMessage("error", { diagnostics: [{ type: "provider_transport_failure" }] }),
    { ...failure().message, provider: "unmanaged" },
  ]) await mock.emit("message_end", { message }, ctx);
  assert.equal(mock.entries.length, 0);
  assert.deepEqual(notifications, []);
});

test("only ten latest failure reports are retained and restored across reload", async () => {
  const mock = mockPi();
  const { ctx, notifications } = context(mock.entries);
  const reporter = installRotatorErrorReporting(mock.pi, [makeConfig()]);
  for (let index = 0; index < 15; index++) await mock.emit("message_end", failure(`failure-${index}.`), ctx);
  reporter.show(ctx);
  const beforeReload = notifications.at(-1)!;
  assert.doesNotMatch(beforeReload, /failure-[0-4]\./);
  assert.match(beforeReload, /failure-5\./);
  assert.match(beforeReload, /failure-14\./);
  assert.equal(beforeReload.match(/failure-/g)?.length, 10);
  const reloaded = installRotatorErrorReporting(mockPi().pi, [makeConfig()]);
  reloaded.restore(ctx);
  reloaded.show(ctx);
  assert.equal(notifications.at(-1), beforeReload);
});

test("corrupt saved metadata and unavailable storage/UI cannot break requests", async () => {
  const mock = mockPi();
  mock.pi.appendEntry = () => { throw new Error("storage unavailable"); };
  const { ctx } = context([{ type: "custom", customType: ERROR_ENTRY_TYPE, data: { provider: "test-provider" } }]);
  const reporter = installRotatorErrorReporting(mock.pi, [makeConfig()]);
  reporter.restore(ctx);
  ctx.ui.notify = () => { throw new Error("UI unavailable"); };
  await assert.doesNotReject(mock.emit("message_end", failure(), ctx));
  ctx.sessionManager = { getEntries: () => { throw new Error("history unavailable"); } };
  assert.doesNotThrow(() => reporter.restore(ctx));
});

test("the errors command is available in the multi-pool entry and does not mutate pool state", async () => {
  const mock = mockPi();
  const config = makeConfig({ poolId: "test-pool" });
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, Date.now())));
  const { ctx, notifications } = context();
  await registerMultiPoolKeyRotatorExtension(mock.pi, {
    pools: [{ config, pool }],
    baseStreamSimple: () => { throw new Error("no HTTP is allowed for the errors command"); },
    createEventStream: () => new TestEventStream(),
  });
  await mock.emit("session_start", {}, ctx);
  await mock.emit("message_end", failure(), ctx);
  const before = await pool.snapshot();
  await mock.commands.get("key-rotator")!.handler("errors test-pool", ctx);
  assert.match(notifications.at(-1) ?? "", /Credential failover exhausted/);
  assert.deepEqual(await pool.snapshot(), before);
});
