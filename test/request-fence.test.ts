import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockedRequestReason,
  registrationEvidence,
  suppressAuthenticationHeaders,
} from "../src/request-fence.ts";
import type { ManagedRequestTarget, RequestFenceContextLike } from "../src/request-fence.ts";
import type { ModelLike, StreamSimpleLike } from "../src/types.ts";
import { TestEventStream } from "./helpers.ts";

const stream: StreamSimpleLike = () => new TestEventStream();
const target: ManagedRequestTarget = {
  provider: "managed-provider",
  api: "openai-completions",
  poolId: "managed-pool",
  streamSimple: stream,
};
const model: ModelLike = {
  provider: target.provider,
  api: target.api,
  id: "managed-model",
};

function context(config: { api?: unknown; streamSimple?: unknown } | undefined): RequestFenceContextLike {
  return {
    model,
    modelRegistry: {
      getRegisteredProviderConfig() {
        return config;
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
  assert.equal(
    registrationEvidence(target, context({ api: target.api, streamSimple: () => new TestEventStream() })).status,
    "overwritten",
  );
  assert.equal(
    registrationEvidence(target, context({ api: "openai-responses", streamSimple: stream })).status,
    "overwritten",
  );
  assert.equal(registrationEvidence(target, {}).status, "unverified");
  assert.equal(
    registrationEvidence(
      {
        provider: target.provider,
        api: target.api,
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
