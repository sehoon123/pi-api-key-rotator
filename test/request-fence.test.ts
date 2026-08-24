import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockedRequestReason,
  installManagedRequestFence,
  registrationEvidence,
  suppressAuthenticationHeaders,
} from "../src/request-fence.ts";
import type {
  ManagedRequestTarget,
  RequestFenceContextLike,
  RequestFenceEventApiLike,
  RequestFenceHostContextLike,
} from "../src/request-fence.ts";
import type { ModelLike, StreamSimpleLike } from "../src/types.ts";
import { TestEventStream } from "./helpers.ts";

const stream: StreamSimpleLike = () => new TestEventStream();
const target: ManagedRequestTarget = {
  provider: "managed-provider",
  api: "openai-completions",
  apiKey: "rotator-managed-key",
  poolId: "managed-pool",
  streamSimple: stream,
};
const model: ModelLike = {
  provider: target.provider,
  api: target.api,
  id: "managed-model",
};

function context(
  config: { api?: unknown; apiKey?: unknown; streamSimple?: unknown; [key: string]: unknown } | undefined,
): RequestFenceContextLike {
  const effective =
    config === undefined || Object.hasOwn(config, "apiKey")
      ? config
      : { ...config, apiKey: target.apiKey };
  return {
    model,
    modelRegistry: {
      getRegisteredProviderConfig() {
        return effective;
      },
      getRegisteredNativeProvider() {
        return undefined;
      },
    },
  };
}

test("post-bind registration evidence requires the configured API and exact stream", () => {
  assert.deepEqual(registrationEvidence(target, context({ api: target.api, streamSimple: stream })), {
    status: "verified",
    api: target.api,
  });
  assert.equal(registrationEvidence(target, context(undefined)).status, "missing");
  assert.deepEqual(
    registrationEvidence(
      target,
      context({ api: target.api, streamSimple: () => new TestEventStream() }),
    ),
    { status: "overwritten", api: target.api },
  );
  assert.equal(
    registrationEvidence(target, context({ api: "openai-responses", streamSimple: stream })).status,
    "overwritten",
  );
  assert.equal(
    registrationEvidence(
      target,
      context({ api: target.api, apiKey: "wrong-placeholder", streamSimple: stream }),
    ).status,
    "overwritten",
  );
  assert.equal(
    registrationEvidence(
      target,
      context({ api: target.api, streamSimple: stream, extra: undefined }),
    ).status,
    "overwritten",
  );
  assert.equal(
    registrationEvidence(target, {
      modelRegistry: {
        getRegisteredProviderConfig: () => ({
          api: target.api,
          apiKey: target.apiKey,
          streamSimple: stream,
        }),
        getRegisteredNativeProvider: () => ({ streamSimple: stream }),
      },
    }).status,
    "overwritten",
  );
  assert.equal(
    registrationEvidence(target, {
      modelRegistry: {
        getRegisteredProviderConfig: () => {
          throw new Error("lookup failed");
        },
        getRegisteredNativeProvider: () => undefined,
      },
    }).status,
    "lookup-error",
  );
  assert.equal(registrationEvidence(target, {}).status, "unverified");
  assert.equal(
    registrationEvidence(
      {
        provider: target.provider,
        api: target.api,
        apiKey: target.apiKey,
        poolId: target.poolId,
        disabledReason: "corrupt state",
      },
      context(undefined),
    ).status,
    "disabled",
  );
});

test("managed API mismatch and competing registration both produce a blocking reason", () => {
  assert.match(
    blockedRequestReason(target, { ...model, api: "openai-responses" }, context({ api: target.api, streamSimple: stream })) ?? "",
    /only with API.*selected model uses/,
  );
  assert.match(
    blockedRequestReason(target, model, context({ api: target.api, streamSimple: () => new TestEventStream() })) ?? "",
    /Another registration replaced/,
  );
  assert.equal(
    blockedRequestReason(target, model, context({ api: target.api, streamSimple: stream })),
    undefined,
  );
});

test("blocked request headers suppress existing and adapter-generated authentication", () => {
  const headers: Record<string, string | null> = {
    Authorization: "Bearer stored-secret",
    "X-Custom-Credential": "stored-secret",
    "content-type": "application/json",
  };
  suppressAuthenticationHeaders(headers);

  assert.equal(headers.Authorization, null);
  assert.equal(headers["X-Custom-Credential"], null);
  assert.equal(headers.authorization, null);
  assert.equal(headers["x-api-key"], null);
  assert.equal(headers.cookie, null);
  assert.equal(headers["content-type"], "application/json");
  assert.doesNotMatch(JSON.stringify(headers), /stored-secret/);
});


test("installed host hooks refuse mismatches and overwritten registrations before dispatch", async () => {
  const handlers = new Map<
    string,
    (event: unknown, ctx: RequestFenceHostContextLike) => unknown | Promise<unknown>
  >();
  const api: RequestFenceEventApiLike = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  installManagedRequestFence(api, new Map([[target.provider, target]]));
  assert.deepEqual(
    [...handlers.keys()],
    [
      "session_start",
      "input",
      "turn_start",
      "before_provider_headers",
      "before_provider_request",
      "session_before_compact",
      "session_before_tree",
    ],
  );

  const notifications: string[] = [];
  let aborts = 0;
  const matchingConfig = { api: target.api, apiKey: target.apiKey, streamSimple: stream };
  const ctx: RequestFenceHostContextLike = {
    model,
    modelRegistry: {
      getRegisteredProviderConfig: () => matchingConfig,
      getRegisteredNativeProvider: () => undefined,
    },
    abort() {
      aborts += 1;
    },
    ui: {
      notify(message) {
        notifications.push(message);
      },
    },
  };
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(await handlers.get("input")?.({}, ctx), undefined);

  ctx.model = { ...model, api: "openai-responses" };
  assert.deepEqual(await handlers.get("input")?.({}, ctx), { action: "handled" });
  assert.match(notifications.at(-1) ?? "", /request was refused before dispatch/);
  await handlers.get("turn_start")?.({}, ctx);
  assert.equal(aborts, 1);

  const headers: Record<string, string | null> = {
    Authorization: "Bearer stored-secret",
    "x-api-key": "stored-secret",
  };
  await handlers.get("before_provider_headers")?.({ headers }, ctx);
  assert.equal(aborts, 2);
  assert.equal(headers.Authorization, null);
  assert.equal(headers["x-api-key"], null);
  await handlers.get("before_provider_request")?.({ payload: {} }, ctx);
  assert.equal(aborts, 3);

  ctx.model = model;
  ctx.modelRegistry = {
    // Exact values and stream identity are insufficient after Pi replaces the
    // captured registration object.
    getRegisteredProviderConfig: () => ({ ...matchingConfig }),
    getRegisteredNativeProvider: () => undefined,
  };
  assert.deepEqual(await handlers.get("input")?.({}, ctx), { action: "handled" });
  // A later apparent restoration cannot clear the sticky violation.
  ctx.modelRegistry = {
    getRegisteredProviderConfig: () => matchingConfig,
    getRegisteredNativeProvider: () => undefined,
  };
  assert.deepEqual(await handlers.get("input")?.({}, ctx), { action: "handled" });
  assert.deepEqual(await handlers.get("session_before_compact")?.({}, ctx), { cancel: true });
  assert.equal(
    await handlers.get("session_before_tree")?.(
      { preparation: { userWantsSummary: false } },
      ctx,
    ),
    undefined,
  );
  assert.equal(
    await handlers.get("session_before_tree")?.(
      { preparation: { userWantsSummary: true, entriesToSummarize: [] } },
      ctx,
    ),
    undefined,
  );
  assert.deepEqual(
    await handlers.get("session_before_tree")?.(
      { preparation: { userWantsSummary: true, entriesToSummarize: [{}] } },
      ctx,
    ),
    { cancel: true },
  );
});


test("doctor registration inspection never captures or latches request state", async () => {
  const handlers = new Map<
    string,
    (event: unknown, ctx: RequestFenceHostContextLike) => unknown | Promise<unknown>
  >();
  const api: RequestFenceEventApiLike = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  const fence = installManagedRequestFence(api, new Map([[target.provider, target]]));
  const expected = { api: target.api, apiKey: target.apiKey, streamSimple: stream };
  let retained: typeof expected = expected;
  const ctx: RequestFenceHostContextLike = {
    model,
    modelRegistry: {
      getRegisteredProviderConfig: () => retained,
      getRegisteredNativeProvider: () => undefined,
    },
    abort() {},
    ui: { notify() {} },
  };

  await handlers.get("session_start")?.({}, ctx);
  retained = { ...expected, streamSimple: () => new TestEventStream() };
  assert.equal(fence.registrations(ctx).get(target.provider)?.status, "overwritten");
  retained = expected;
  assert.equal(await handlers.get("input")?.({}, ctx), undefined);

  // A diagnostic read also must not establish the initial object identity.
  const freshHandlers = new Map<
    string,
    (event: unknown, ctx: RequestFenceHostContextLike) => unknown | Promise<unknown>
  >();
  const freshFence = installManagedRequestFence(
    { on: (event, handler) => freshHandlers.set(event, handler) },
    new Map([[target.provider, target]]),
  );
  assert.equal(freshFence.registrations(ctx).get(target.provider)?.status, "verified");
  retained = { ...expected };
  assert.equal(freshFence.registrations(ctx).get(target.provider)?.status, "verified");
});
