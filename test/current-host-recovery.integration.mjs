import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// Use the actual installed host, not the package's pinned development copies.
const hostRoot = process.env.PI_ROTATOR_HOST_ROOT;
assert.ok(hostRoot, "Set PI_ROTATOR_HOST_ROOT to the installed pi-coding-agent package directory");
const hostManifest = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
const aiRoot = join(hostRoot, "node_modules", "@earendil-works", "pi-ai");
const aiManifest = JSON.parse(await readFile(join(aiRoot, "package.json"), "utf8"));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } = await import(
  pathToFileURL(join(hostRoot, hostManifest.exports["."].import)).href
);
const { isContextOverflow, isRetryableAssistantError } = await import(
  pathToFileURL(join(aiRoot, aiManifest.exports["./compat"].import)).href
);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = "local-rotator-contract";
const fakeKeys = ["local-fake-key-one", "local-fake-key-two"];

function successSse() {
  const chunk = (delta, finish_reason = null) => ({
    id: "local-result", object: "chat.completion.chunk", created: 1, model: "local-model",
    choices: [{ index: 0, delta, finish_reason }],
  });
  return `data: ${JSON.stringify(chunk({ role: "assistant", content: "ok" }))}\n\n` +
    `data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`;
}

async function fixture(t, responder, { mismatch = false, factories = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-rotator-current-host-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { mode: 0o700 });
  await mkdir(cwd);
  const requests = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the local fixture request */ }
    requests.push({ authorization: request.headers.authorization });
    await responder(requests.length, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const json = (name, data) => writeFile(join(agentDir, name), JSON.stringify(data), { mode: 0o600 });
  const stateFile = join(agentDir, "test.state.json");
  await json("key-rotator.json", {
    poolId: "local-pool", provider, api: "openai-completions", stateFile,
    keys: fakeKeys.map((value, index) => ({ id: `k${index}`, value })),
    maxAttemptsPerRequest: 2,
  });
  await json("auth.json", { [provider]: { type: "api_key", key: "local-stored-key" } });
  await json("models.json", { providers: { [provider]: {
    api: "openai-completions", baseUrl: url,
    models: [{ id: "local-model", name: "Local fixture", api: mismatch ? "anthropic-messages" : "openai-completions",
      contextWindow: 16384, maxTokens: 1024, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } });
  await json("settings.json", {
    compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 0 },
    retry: { enabled: true, maxRetries: 10, baseDelayMs: 1, provider: { maxRetries: 0 } },
  });
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_KEY_ROTATOR_CONFIG", "PI_OFFLINE"].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_KEY_ROTATOR_CONFIG;
  process.env.PI_OFFLINE = "1";
  let session;
  try {
    const loader = new DefaultResourceLoader({
      cwd, agentDir, additionalExtensionPaths: [packageRoot], extensionFactories: factories,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const manager = SessionManager.inMemory(cwd);
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel(provider, "local-model"), sessionManager: manager, noTools: "all",
    }));
    const errors = [];
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
        errors.push(event.message);
      }
    });
    await session.bindExtensions({});
    t.after(async () => {
      session.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    return { session, requests, manager, errors, stateFile };
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

function respond(response, status, data) {
  response.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
  response.end(status === 200 ? successSse() : JSON.stringify(data));
}

function reports(manager) {
  return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-key-rotator-error");
}

test("current host really is Pi 0.99.1", async () => {
  assert.equal(JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8")).version, "0.99.1");
});

test("current host loads the entry and recovers a rejected credential with the next key", async (t) => {
  const h = await fixture(t, (attempt, response) => respond(response, attempt === 1 ? 401 : 200,
    { error: { message: "invalid local fixture key" } }));
  await h.session.prompt("Say ok.");
  assert.deepEqual(h.requests.map((r) => r.authorization), fakeKeys.map((key) => `Bearer ${key}`));
  assert.equal(h.session.getLastAssistantText(), "ok");
  assert.equal(reports(h.manager).length, 0);
});

test("HTTP 200 body disconnect before any content can recover on the running host", async (t) => {
  const h = await fixture(t, (attempt, response) => {
    if (attempt > 1) return respond(response, 200);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    response.write(": empty keepalive\n\n");
    setTimeout(() => response.destroy(), 30);
  });
  await h.session.prompt("Say ok.");
  assert.equal(h.requests.length, 2);
  assert.equal(h.session.getLastAssistantText(), "ok");
  const state = JSON.parse(await readFile(h.stateFile, "utf8"));
  assert.equal(state.keys.k0.failures, 1);
  assert.equal(state.keys.k0.lastStatus, null);
});

test("context overflow reaches the host recognizer and a sanitized durable report", async (t) => {
  const h = await fixture(t, (_attempt, response) => respond(response, 400,
    { error: { message: "Your input exceeds the context window of this model" } }));
  await h.session.prompt("Probe context recovery recognition.");
  assert.equal(h.requests.length, 1);
  assert.equal(isContextOverflow(h.errors.at(-1)), true);
  assert.equal(isRetryableAssistantError(h.errors.at(-1)), false);
  assert.match(reports(h.manager)[0]?.data.summary ?? "", /exceeds the context window/);
});

test("overflow performs one real compact-and-retry recovery on Pi 0.99.1", async (t) => {
  const compactions = [];
  const h = await fixture(t, (attempt, response) => respond(response, attempt === 1 ? 400 : 200,
    { error: { message: "Your input exceeds the context window of this model" } }), {
    factories: [(pi) => {
      pi.on("session_before_compact", (event) => {
        compactions.push({ reason: event.reason, willRetry: event.willRetry });
        return { compaction: {
          summary: "Local fixture summary: return ok.",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } };
      });
    }],
  });
  h.session.setAutoCompactionEnabled(true);
  await h.session.prompt("Return ok after the local overflow fixture is compacted.");
  assert.equal(h.requests.length, 2);
  assert.equal(h.session.getLastAssistantText(), "ok");
  assert.deepEqual(compactions, [{ reason: "overflow", willRetry: true }]);
  assert.equal(h.manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
});

test("bounded final errors do not trigger the user's separate ten-retry host loop", async (t) => {
  const h = await fixture(t, (_attempt, response) => respond(response, 503,
    { error: { message: "Service unavailable, local fixture only" } }));
  await h.session.prompt("Probe exhausted rotation budget.");
  assert.equal(h.requests.length, 2);
  assert.equal(isRetryableAssistantError(h.errors.at(-1)), false);
  const saved = reports(h.manager);
  assert.equal(saved.length, 1);
  assert.match(saved[0].data.summary, /exhausted 2 attempt/);
  assert.match(saved[0].data.detail, /Service unavailable/);
  assert.doesNotMatch(JSON.stringify(saved), /local-fake-key|local-stored-key/);
  await h.session.prompt("/key-rotator errors local-pool");
  assert.equal(h.requests.length, 2);
});

test("API mismatch still makes zero physical requests on the current host", async (t) => {
  const h = await fixture(t, (_attempt, response) => respond(response, 200), { mismatch: true });
  await h.session.prompt("Must not dispatch.").catch(() => {});
  assert.equal(h.requests.length, 0);
});
