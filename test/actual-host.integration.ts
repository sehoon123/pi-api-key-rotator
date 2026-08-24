import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import type { TestContext } from "node:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { streamSimple as piAnthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as piOpenAIStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as piCompatStreamSimple } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createInitialPoolState, KeyPool } from "../src/key-pool.ts";
import { createRotatingStream } from "../src/rotating-stream.ts";
import { InMemoryStateStore } from "../src/state-store.ts";
import type { AssistantEventLike, ModelLike, StreamSimpleLike } from "../src/types.ts";
import { assistantMessage, collect, makeConfig, mutableClock, TestEventStream } from "./helpers.ts";

const PACKAGE_NAME = "pi-api-key-rotator";
const HOST_PROVIDER = "host-key-rotator";
const MATCHING_API = "openai-completions";
const MISMATCHED_API = "anthropic-messages";
const MANAGED_FALLBACK = "rotator-managed-key";
const STORED_HOST_CREDENTIAL = "stored-host-credential";
const POOL_KEYS = ["host-pool-key-one", "host-pool-key-two"] as const;
const root = process.cwd();

let suiteDirectory = "";
let packedProject = "";
let installedPackageRoot = "";
let caseNumber = 0;

function run(command: string, args: string[], options: { cwd: string }): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

// Do not use a shell on Windows. Patched Node releases reject direct .cmd
// spawning, so invoke npm's bundled JavaScript entry through Node instead.
const npmInvocation =
  process.platform === "win32"
    ? {
        command: process.execPath,
        prefixArgs: [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")],
      }
    : { command: "npm", prefixArgs: [] as string[] };

function runNpm(args: string[], cwd: string): Promise<string> {
  return run(npmInvocation.command, [...npmInvocation.prefixArgs, ...args], { cwd });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function withPiEnvironment<T>(agentDir: string, callback: () => Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousConfig = process.env.PI_KEY_ROTATOR_CONFIG;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_KEY_ROTATOR_CONFIG;
  process.env.PI_OFFLINE = "1";
  try {
    return await callback();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousConfig === undefined) delete process.env.PI_KEY_ROTATOR_CONFIG;
    else process.env.PI_KEY_ROTATOR_CONFIG = previousConfig;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
}

async function writeRotatorConfig(agentDir: string): Promise<string> {
  const stateFile = join(agentDir, "host-pool.state.json");
  await writePrivateJson(join(agentDir, "key-rotator.json"), {
    configVersion: 1,
    poolId: "host-pool",
    provider: HOST_PROVIDER,
    api: MATCHING_API,
    keys: [
      { id: "host-key-one", value: POOL_KEYS[0] },
      { id: "host-key-two", value: POOL_KEYS[1] },
    ],
    requestsPerKey: 20,
    maxAttemptsPerRequest: 2,
    stateFile,
  });
  return stateFile;
}

function configuredModels(baseUrl: string): unknown {
  return {
    providers: {
      [HOST_PROVIDER]: {
        baseUrl,
        api: MATCHING_API,
        models: [
          {
            id: "matching-model",
            name: "Matching model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_384,
            maxTokens: 1_024,
          },
          {
            id: "api-mismatch-model",
            name: "API mismatch model",
            api: MISMATCHED_API,
            baseUrl: new URL(baseUrl).origin,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_384,
            maxTokens: 1_024,
          },
        ],
      },
    },
  };
}

interface CapturedRequest {
  path: string;
  authHeaderNames: string[];
  authorization: string | undefined;
  xApiKey: string | undefined;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

function capturedRequest(path: string, headers: IncomingHttpHeaders): CapturedRequest {
  const authHeaderNames = ["authorization", "x-api-key", "api-key"].filter((name) => {
    const value = headerValue(headers, name)?.trim();
    return value !== undefined && value.length > 0 && !/^Bearer\s*$/iu.test(value);
  });
  return {
    path,
    authHeaderNames,
    authorization: headerValue(headers, "authorization"),
    xApiKey: headerValue(headers, "x-api-key"),
  };
}

async function poolAttempts(stateFile: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as { totalAttempts?: unknown };
    if (typeof parsed.totalAttempts !== "number") throw new Error("Host state has no numeric totalAttempts");
    return parsed.totalAttempts;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return 0;
    }
    throw error;
  }
}

async function createHostHarness(
  t: TestContext,
  options: { selectedModel: "matching-model" | "api-mismatch-model"; competingRegistration?: boolean },
) {
  caseNumber += 1;
  const caseRoot = join(suiteDirectory, `host-case-${caseNumber}`);
  const agentDir = join(caseRoot, "agent");
  const cwd = join(caseRoot, "project");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true });

  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request so the real SDK can finish its physical call.
    }
    requests.push(capturedRequest(request.url ?? "", request.headers));
    if ((request.url ?? "").endsWith("/messages")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "host contract probe" },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(successfulSse(options.selectedModel));
  });
  const baseUrl = await listen(server);

  const stateFile = await writeRotatorConfig(agentDir);
  await writePrivateJson(join(agentDir, "auth.json"), {
    [HOST_PROVIDER]: { type: "api_key", key: STORED_HOST_CREDENTIAL },
  });
  await writePrivateJson(join(agentDir, "models.json"), configuredModels(baseUrl));
  await writePrivateJson(join(agentDir, "settings.json"), {
    retry: { enabled: false, provider: { maxRetries: 0 } },
  });

  let sessionResult!: Awaited<ReturnType<typeof createAgentSession>>;
  let runtime!: ModelRuntime;
  let registrationsBeforeBind!: Array<{
    name: string;
    config: { api?: string; apiKey?: string; streamSimple?: unknown };
    extensionPath: string;
  }>;
  let installedEntry = "";

  await withPiEnvironment(agentDir, async () => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [installedPackageRoot],
      extensionFactories: options.competingRegistration
        ? [
            {
              name: "competing-provider-registration",
              factory: (pi) => {
                // Pi 0.84.2 merges a later registration over the rotator's
                // registration. The stored auth.json credential then reaches
                // this real compatibility stream unless the rotator's request
                // fence survives provider composition.
                pi.registerProvider(HOST_PROVIDER, {
                  api: MATCHING_API,
                  streamSimple: piCompatStreamSimple,
                });
              },
            },
          ]
        : [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const packageExtension = loaded.extensions.find((extension) =>
      extension.resolvedPath.startsWith(installedPackageRoot),
    );
    assert.ok(packageExtension, "DefaultResourceLoader did not load the packed package entry");
    installedEntry = packageExtension.resolvedPath;
    assert.ok(packageExtension.commands.has("key-rotator"));
    registrationsBeforeBind = loaded.runtime.pendingProviderRegistrations.map((registration) => ({
      name: registration.name,
      config: registration.config,
      extensionPath: registration.extensionPath,
    }));

    runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const selectedModel = runtime.getModel(HOST_PROVIDER, options.selectedModel);
    assert.ok(selectedModel, `models.json did not define ${options.selectedModel}`);
    sessionResult = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      modelRuntime: runtime,
      model: selectedModel,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    assert.equal(loaded.runtime.pendingProviderRegistrations.length, 0, "ExtensionRunner did not bind the queue");
  });

  t.after(async () => {
    sessionResult.session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  return {
    agentDir,
    stateFile,
    requests,
    session: sessionResult.session,
    extensionsResult: sessionResult.extensionsResult,
    runtime,
    registrationsBeforeBind,
    installedEntry,
  };
}

before(async () => {
  suiteDirectory = await mkdtemp(join(tmpdir(), "pi-key-rotator-host-"));
  const packDirectory = join(suiteDirectory, "pack");
  packedProject = join(suiteDirectory, "packed-project");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(packedProject, { recursive: true });
  await writeFile(join(packedProject, "package.json"), '{"private":true,"type":"module"}\n');

  const packed = JSON.parse(
    await runNpm(["pack", "--json", "--pack-destination", packDirectory], root),
  ) as Array<{ filename?: unknown }>;
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a tarball filename");
  await runNpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      "--cache",
      join(suiteDirectory, "npm-cache"),
      join(packDirectory, filename),
    ],
    packedProject,
  );
  installedPackageRoot = join(packedProject, "node_modules", PACKAGE_NAME);
});

after(async () => {
  if (suiteDirectory) await rm(suiteDirectory, { recursive: true, force: true });
});

test("the installed host packages are exactly Pi 0.84.2 and the packed entry is discoverable", async () => {
  for (const packageName of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
    const manifest = JSON.parse(
      await readFile(join(root, "node_modules", ...packageName.split("/"), "package.json"), "utf8"),
    ) as { version?: unknown };
    assert.equal(manifest.version, "0.84.2", `${packageName} must be installed at exactly 0.84.2`);
  }

  const installedManifest = JSON.parse(
    await readFile(join(installedPackageRoot, "package.json"), "utf8"),
  ) as { version?: unknown; pi?: { extensions?: unknown } };
  assert.equal(installedManifest.version, "0.4.0");
  assert.deepEqual(installedManifest.pi?.extensions, ["./src/index.ts"]);

  const agentDir = join(suiteDirectory, "direct-discovery-agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeRotatorConfig(agentDir);
  const discovered = await withPiEnvironment(agentDir, () =>
    discoverAndLoadExtensions([installedPackageRoot], packedProject, agentDir),
  );
  assert.deepEqual(discovered.errors, []);
  assert.equal(discovered.extensions.length, 1);
  assert.equal(discovered.extensions[0]?.resolvedPath, join(installedPackageRoot, "src", "index.ts"));
  assert.ok(discovered.extensions[0]?.commands.has("key-rotator"));
  assert.deepEqual(
    discovered.runtime.pendingProviderRegistrations.map(({ name, config }) => ({
      name,
      api: config.api,
      apiKey: config.apiKey,
      hasStream: typeof config.streamSimple === "function",
    })),
    [{ name: HOST_PROVIDER, api: MATCHING_API, apiKey: MANAGED_FALLBACK, hasStream: true }],
  );
});

test("DefaultResourceLoader binds the packed rotator and matching API requests use a pool key", async (t) => {
  const harness = await createHostHarness(t, { selectedModel: "matching-model" });
  assert.equal(harness.installedEntry, join(installedPackageRoot, "src", "index.ts"));
  assert.deepEqual(
    harness.registrationsBeforeBind.map(({ name, config }) => ({
      name,
      api: config.api,
      apiKey: config.apiKey,
      hasStream: typeof config.streamSimple === "function",
    })),
    [{ name: HOST_PROVIDER, api: MATCHING_API, apiKey: MANAGED_FALLBACK, hasStream: true }],
  );
  assert.ok(harness.extensionsResult.extensions.some((extension) => extension.commands.has("key-rotator")));
  assert.ok(harness.runtime.getRegisteredProviderIds().includes(HOST_PROVIDER));
  const registered = harness.runtime.getRegisteredProviderConfig(HOST_PROVIDER);
  assert.equal(registered?.api, MATCHING_API);
  assert.equal(registered?.apiKey, MANAGED_FALLBACK);
  assert.equal(typeof registered?.streamSimple, "function");

  const model = harness.runtime.getModel(HOST_PROVIDER, "matching-model");
  assert.ok(model);
  assert.equal((await harness.runtime.getAuth(model))?.auth.apiKey, STORED_HOST_CREDENTIAL);
  await harness.session.prompt("Return the word ok.");

  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0]?.authHeaderNames, ["authorization"]);
  assert.equal(harness.requests[0]?.authorization, `Bearer ${POOL_KEYS[0]}`);
  assert.notEqual(harness.requests[0]?.authorization, `Bearer ${STORED_HOST_CREDENTIAL}`);
  assert.notEqual(harness.requests[0]?.authorization, `Bearer ${MANAGED_FALLBACK}`);
  assert.equal(await poolAttempts(harness.stateFile), 1);
});

test("an API mismatch cannot send stored auth and consumes zero pool attempts", async (t) => {
  const harness = await createHostHarness(t, { selectedModel: "api-mismatch-model" });
  const model = harness.runtime.getModel(HOST_PROVIDER, "api-mismatch-model");
  assert.ok(model);
  assert.notEqual(model.api, harness.runtime.getRegisteredProviderConfig(HOST_PROVIDER)?.api);
  assert.equal((await harness.runtime.getAuth(model))?.auth.apiKey, STORED_HOST_CREDENTIAL);

  // A safe fence may refuse before transport or may let an unauthenticated
  // request reach the local server. Either outcome is acceptable. A stored
  // credential on any physical request is not.
  await harness.session.prompt("This mismatched request must fail closed.").catch(() => undefined);
  const observed = {
    authenticatedPhysicalRequests: harness.requests.filter((request) => request.authHeaderNames.length > 0).length,
    poolAttempts: await poolAttempts(harness.stateFile),
  };
  assert.deepEqual(observed, { authenticatedPhysicalRequests: 0, poolAttempts: 0 });
});

test("a later competing provider registration cannot send stored auth or enter the key pool", async (t) => {
  const harness = await createHostHarness(t, {
    selectedModel: "matching-model",
    competingRegistration: true,
  });
  assert.deepEqual(
    harness.registrationsBeforeBind.map(({ name }) => name),
    [HOST_PROVIDER, HOST_PROVIDER],
    "the test must bind the rotator first and a competing registration second",
  );
  const registered = harness.runtime.getRegisteredProviderConfig(HOST_PROVIDER);
  assert.equal(registered?.streamSimple, piCompatStreamSimple, "Pi did not compose the later registration");
  const model = harness.runtime.getModel(HOST_PROVIDER, "matching-model");
  assert.ok(model);
  assert.equal((await harness.runtime.getAuth(model))?.auth.apiKey, STORED_HOST_CREDENTIAL);

  await harness.session.prompt("This competing stream must fail closed.").catch(() => undefined);
  const observed = {
    authenticatedPhysicalRequests: harness.requests.filter((request) => request.authHeaderNames.length > 0).length,
    poolAttempts: await poolAttempts(harness.stateFile),
  };
  assert.deepEqual(observed, { authenticatedPhysicalRequests: 0, poolAttempts: 0 });
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

function successfulSse(model: string): string {
  const first = {
    id: "chatcmpl-local",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
  };
  const last = {
    id: "chatcmpl-local",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
}

function actualModel(baseUrl: string): ModelLike {
  return {
    api: "openai-completions",
    provider: "test-provider",
    id: "local-model",
    name: "Local model",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  } as ModelLike;
}

function terminalError(event: AssistantEventLike | undefined): Record<PropertyKey, unknown> {
  assert.equal(event?.type, "error");
  return (event as Extract<AssistantEventLike, { type: "error" }>).error as unknown as Record<PropertyKey, unknown>;
}

test("Pi 0.84.x OpenAI adapter stays within maxAttempts and emits a retry-neutral terminal", async (t) => {
  const authorization: string[] = [];
  let returnSuccess = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before replying so the real adapter completes normally.
    }
    authorization.push(String(request.headers.authorization ?? ""));
    if (!returnSuccess || authorization.length % 2 === 1) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
      response.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(successfulSse("local-model"));
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const baseUrl = await listen(server);

  const base = makeConfig();
  const config = makeConfig({ keys: base.keys.slice(0, 2), maxAttemptsPerRequest: 2 });
  const time = mutableClock(1_000);
  const store = new InMemoryStateStore(createInitialPoolState(config, time.clock.now()));
  const pool = new KeyPool(config, store, time.clock);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: piOpenAIStreamSimple as unknown as StreamSimpleLike,
    createEventStream: () => new TestEventStream(),
  });

  // Pi would retry both of these raw messages. The rotator must never expose
  // either phrase after it has consumed its own attempt budget.
  for (const errorMessage of ["429 rate limited", "rate_limit_error"]) {
    const raw = assistantMessage("error", { errorMessage });
    assert.equal(isRetryableAssistantError(raw as never), true);
  }

  let hostInvocations = 0;
  let events: AssistantEventLike[] = [];
  do {
    hostInvocations += 1;
    events = await collect(rotating(actualModel(baseUrl), { messages: [] }));
  } while (
    events.at(-1)?.type === "error" &&
    isRetryableAssistantError(terminalError(events.at(-1)) as never) &&
    hostInvocations < 4
  );

  assert.equal(hostInvocations, 1);
  assert.equal(authorization.length, config.maxAttemptsPerRequest);
  assert.deepEqual(authorization, ["Bearer secret-one", "Bearer secret-two"]);
  const finalized = terminalError(events.at(-1));
  assert.equal(isRetryableAssistantError(finalized as never), false);
  assert.match(JSON.stringify(finalized.diagnostics), /slow down/);
  assert.doesNotMatch(JSON.stringify(finalized), /secret-one|secret-two/);
  assert.deepEqual((await pool.snapshot()).keys.map((key) => key.cooldownUntil), [121_000, 121_000]);

  // A separate logical request may succeed after one in-wrapper failover. It
  // still makes exactly two physical calls and produces one semantic stream.
  returnSuccess = true;
  authorization.length = 0;
  time.advance(121_000);
  const successEvents = await collect(rotating(actualModel(baseUrl), { messages: [] }));
  assert.equal(authorization.length, 2);
  assert.equal(successEvents.at(-1)?.type, "done");
  assert.equal(successEvents.filter((event) => event.type === "text_delta").length, 1);
});


test("Pi 0.84.x Anthropic HTTP-200 SSE failures fail over without leaking structural output", async (t) => {
  const apiKeys: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain request body.
    }
    apiKeys.push(String(request.headers["x-api-key"] ?? ""));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n',
    );
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const openAiBaseUrl = await listen(server);
  const baseUrl = new URL(openAiBaseUrl).origin;

  const base = makeConfig();
  const config = makeConfig({
    provider: "anthropic-target",
    api: "anthropic-messages",
    keys: base.keys.slice(0, 2),
    maxAttemptsPerRequest: 2,
  });
  const time = mutableClock(1_000);
  const pool = new KeyPool(config, new InMemoryStateStore(createInitialPoolState(config, time.clock.now())), time.clock);
  const rotating = createRotatingStream({
    config,
    pool,
    baseStreamSimple: piAnthropicStreamSimple as unknown as StreamSimpleLike,
    createEventStream: () => new TestEventStream(),
  });
  const anthropicModel = {
    api: "anthropic-messages",
    provider: "anthropic-target",
    id: "local-claude",
    name: "Local Claude",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  } as ModelLike;

  const events = await collect(rotating(anthropicModel, { messages: [] }));
  assert.deepEqual(apiKeys, ["secret-one", "secret-two"]);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const finalized = terminalError(events[0]);
  assert.equal(isRetryableAssistantError(finalized as never), false);
  assert.match(JSON.stringify(finalized.diagnostics), /rate_limit_error/);
  const snapshot = await pool.snapshot();
  assert.deepEqual(snapshot.keys.map((key) => key.lastStatus), [429, 429]);
});
