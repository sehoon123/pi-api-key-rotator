import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const hostRoot = process.env.PI_ROTATOR_HOST_ROOT;
assert.ok(hostRoot, "Set PI_ROTATOR_HOST_ROOT to the installed Pi package directory");
const manifest = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
const aiRoot = join(dirname(hostRoot), "pi-ai");
const aiManifest = JSON.parse(await readFile(join(aiRoot, "package.json"), "utf8"));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } = await import(
  pathToFileURL(join(hostRoot, manifest.exports["."].import)).href
);
const { isRetryableAssistantError } = await import(pathToFileURL(join(aiRoot, aiManifest.exports["./compat"].import)).href);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = "local-reliability-fixture";
const fakeKeys = ["fixture-fake-key-one", "fixture-fake-key-two"];
const sse = (data, event) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

function openAiChunk(content, finish_reason = null) {
  return { id: "local-result", object: "chat.completion.chunk", created: 1, model: "local-model",
    choices: [{ index: 0, delta: content === undefined ? {} : { role: "assistant", content }, finish_reason }] };
}
function successBody(api) {
  if (api === "anthropic-messages") return [
    sse({ type: "message_start", message: { id: "msg_local", type: "message", role: "assistant", model: "local-model",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }, "message_start"),
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
    sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, "content_block_delta"),
    sse({ type: "content_block_stop", index: 0 }, "content_block_stop"),
    sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, "message_delta"),
    sse({ type: "message_stop" }, "message_stop"),
  ].join("");
  return sse(openAiChunk("ok")) + sse(openAiChunk(undefined, "stop")) + "data: [DONE]\n\n";
}
function success(response, api = "openai-completions") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(successBody(api));
}
function failure(response, status, detail, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ error: typeof detail === "string" ? { message: detail } : detail }));
}

async function fixture(t, responder, { api = "openai-completions", config = {}, retries = 3, mismatch = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-local-reliability-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { mode: 0o700 });
  await mkdir(cwd);
  const requests = [];
  const server = createServer(async (request, response) => {
    // Reject any unexpected path; no production auth, prompts or endpoints are used.
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    assert.ok(pathname === "/v1/chat/completions" || pathname === "/v1/messages", `Unexpected loopback path: ${pathname}`);
    for await (const _chunk of request) { /* drain fixture input */ }
    requests.push({ authorization: request.headers.authorization ?? request.headers["x-api-key"], at: performance.now() });
    await responder(requests.length, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = (name, data) => writeFile(join(agentDir, name), JSON.stringify(data), { mode: 0o600 });
  const stateFile = join(agentDir, "local.state.json");
  await json("key-rotator.json", {
    poolId: "local-pool", provider, api, stateFile,
    keys: fakeKeys.map((value, index) => ({ id: `k${index}`, value })),
    maxAttemptsPerRequest: 1, targetFailureThreshold: 1, transientCooldownMs: 30,
    retryTransientAtAgentLevel: true, maxCooldownWaitMs: 2000, ...config,
  });
  await json("auth.json", { [provider]: { type: "api_key", key: "fixture-stored-not-dispatched" } });
  await json("models.json", { providers: { [provider]: {
    api, baseUrl: api === "anthropic-messages" ? origin : `${origin}/v1`,
    models: [{ id: "local-model", name: "Local loopback fixture", api: mismatch ? "anthropic-messages" : api,
      contextWindow: 16_384, maxTokens: 1024, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } });
  await json("settings.json", { compaction: { enabled: false },
    retry: { enabled: true, maxRetries: retries, baseDelayMs: 5, maxAgentDelayMs: 20, provider: { maxRetries: 0 } } });
  const names = ["PI_CODING_AGENT_DIR", "PI_KEY_ROTATOR_CONFIG", "PI_OFFLINE"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_KEY_ROTATOR_CONFIG;
  process.env.PI_OFFLINE = "1";
  let session;
  try {
    const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [packageRoot],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false });
    const manager = SessionManager.inMemory(cwd);
    ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel(provider, "local-model"), sessionManager: manager, noTools: "all" }));
    const events = [];
    session.subscribe((event) => events.push(event));
    await session.bindExtensions({});
    t.after(async () => {
      session.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    return { session, requests, manager, events, stateFile };
  } catch (error) {
    session?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

function lastError(h) {
  return h.events.filter((event) => event.type === "message_end" && event.message.role === "assistant" &&
    event.message.stopReason === "error").at(-1)?.message;
}
function retryStarts(h) { return h.events.filter((event) => event.type === "auto_retry_start"); }
function reports(h) { return h.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-key-rotator-error"); }

test("the targeted integration uses the real Pi 1.4.0 host", () => assert.equal(manifest.version, "1.4.0"));

test("503 -> 503 -> success recovers with one final settlement and bounded outer retries", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t, (attempt, response) => attempt <= 2 ? failure(response, 503, "Service unavailable") : success(response));
  await h.session.prompt("Return ok from the local fixture.");
  assert.equal(h.requests.length, 3);
  assert.equal(h.session.getLastAssistantText(), "ok");
  assert.equal(retryStarts(h).length, 2);
  assert.equal(h.events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(h.events.some((event) => event.type === "auto_retry_end" && event.success === true), true);
  assert.equal(isRetryableAssistantError(lastError(h)), true);
  assert.doesNotMatch(JSON.stringify(reports(h)), /fixture-fake-key|fixture-stored/);
});

test("the user's exact Anthropic HTTP-200 api_error recovers on the next outer retry", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t, (attempt, response) => {
    if (attempt > 1) return success(response, "anthropic-messages");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse({ type: "error", error: { details: null, type: "api_error", message: "Internal server error" },
      request_id: "req_local_fixture_only" }, "error"));
  }, { api: "anthropic-messages" });
  await h.session.prompt("Return ok from the local fixture.");
  assert.equal(h.requests.length, 2);
  assert.equal(h.session.getLastAssistantText(), "ok");
  assert.equal(retryStarts(h).length, 1);
  assert.match(JSON.stringify(reports(h)), /api_error|Internal server error/);
});

test("all keys throttled -> wait -> success does not call again before the first key's Retry-After", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t, (attempt, response) => attempt <= 2 ?
    failure(response, 429, "Rate limit reached", { "Retry-After": "1" }) : success(response));
  await h.session.prompt("Return ok after the local throttle.");
  assert.equal(h.requests.length, 3);
  assert.equal(h.session.getLastAssistantText(), "ok");
  assert.ok(h.requests[2].at - h.requests[0].at >= 950);
  assert.notEqual(h.requests[0].authorization, h.requests[1].authorization);
});

test("503 Retry-After gates the whole target before trying any other key", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t, (attempt, response) => attempt === 1 ?
    failure(response, 503, "Service unavailable", { "Retry-After": "1" }) : success(response),
  { config: { targetFailureThreshold: 4 } });
  await h.session.prompt("Return ok after the local service recovers.");
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1].at - h.requests[0].at >= 950);
  assert.equal(h.session.getLastAssistantText(), "ok");
});

for (const [status, detail] of [[401, { message: "invalid local fixture key" }],
  [429, { type: "insufficient_quota", message: "local fixture budget empty" }]]) {
  test(`HTTP ${status} permanent/auth/quota failure stops without an outer retry`, { timeout: 15_000 }, async (t) => {
    const h = await fixture(t, (_attempt, response) => failure(response, status, detail));
    await h.session.prompt("Probe a local permanent failure.");
    assert.equal(h.requests.length, 1);
    assert.equal(retryStarts(h).length, 0);
    assert.equal(isRetryableAssistantError(lastError(h)), false);
    const state = JSON.parse(await readFile(h.stateFile, "utf8"));
    if (status === 401) assert.equal(state.keys.k0.disabled, true);
    else assert.ok(state.keys.k0.cooldownUntil - Date.now() > 3_500_000);
  });
}

test("a persistent outage stops exactly at the configured outer retry budget", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t, (_attempt, response) => failure(response, 503, "Service unavailable"), { retries: 2 });
  await h.session.prompt("Probe a local persistent outage.");
  assert.equal(h.requests.length, 3, "one initial attempt plus two outer retries");
  assert.equal(retryStarts(h).length, 2);
  assert.equal(h.events.some((event) => event.type === "auto_retry_end" && event.success === false), true);
});

test("a disconnected stream after visible text is not replayed", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t, (_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse(openAiChunk("visible partial output")));
    setTimeout(() => response.destroy(), 40);
  });
  await h.session.prompt("Probe partial-output safety using the local fixture.");
  assert.equal(h.requests.length, 1);
  assert.equal(retryStarts(h).length, 0);
  assert.equal(isRetryableAssistantError(lastError(h)), false);
  assert.match(JSON.stringify(lastError(h).content), /visible partial output/);
  assert.equal(h.events.filter((event) => event.type === "tool_execution_start").length, 0);
});

test("caller abort interrupts a long cooldown promptly without another request", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t, (_attempt, response) => failure(response, 503, "Service unavailable", { "Retry-After": "30" }),
    { config: { maxCooldownWaitMs: 900_000 } });
  const run = h.session.prompt("Probe cancellation of a local cooldown.");
  while (retryStarts(h).length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const at = performance.now();
  await h.session.abort();
  await run;
  assert.ok(performance.now() - at < 1000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.events.filter((event) => event.type === "agent_settled").at(-1)?.aborted, true);
});

test("API mismatch still makes zero physical requests", { timeout: 15_000 }, async (t) => {
  const h = await fixture(t, (_attempt, response) => success(response), { mismatch: true });
  await h.session.prompt("This fixture must not dispatch.").catch(() => {});
  assert.equal(h.requests.length, 0);
});
