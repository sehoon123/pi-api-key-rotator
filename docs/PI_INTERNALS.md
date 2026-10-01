# How v0.4.0 hooks into Pi 0.84.2

This document records the Pi host contract that must be rechecked before claiming support for another
Pi release.

## 1. Verified call chain

1. Pi discovers `src/index.ts` through `package.json` → `pi.extensions`.
2. The default package entry loads `PI_KEY_ROTATOR_CONFIG` when set; otherwise it loads
   `<agent dir>/key-rotator.json`. `<agent dir>` is `$PI_CODING_AGENT_DIR` when set, otherwise
   `~/.pi/agent`. Programmatic config-loader options are not Pi package-install settings.
3. Each configured pool creates one `KeyPool` and one state store. A read-only `snapshot()` preflight
   disables only a pool whose state cannot be validated and preserves that state as evidence.
4. Each healthy target calls `ExtensionAPI.registerProvider(providerId, config)` with the inert key and
   its exact guarded stream. During extension loading, Pi queues this call; it binds and composes
   provider registrations later. Disabled targets are not registered but remain managed by the fence.
5. Pi composes each healthy extension provider with `models.json` and stored authentication.
6. At `session_start`, the fence captures Pi's public retained registration object. Every cancellable
   request boundary rechecks its identity, exact fields, stream function, API, inert key, and absence
   of a native provider.
7. For a selected model whose `model.api` equals the retained extension `api`, Pi invokes the
   rotator's provider-scoped `streamSimple`.
8. The wrapper selects a credential, calls Pi's generic compatibility `streamSimple`, classifies the
   result, commits the outcome, and then exposes the final terminal event.

The pinned real-host test must exercise this chain from the installed package entry, not only import
lower-level rotator modules.

## 2. Provider-scoped composition, not a global api dispatcher

Pi 0.84.2 composes `streamSimple` for each provider registration. The extension stream is used only
when both the provider id and registered `api` match the selected model. Several independent pools
can therefore use the same api type without a shared global dispatcher.

No global one-dispatcher-per-api layer, builtin stream capture, or private lifecycle diagnostic is
part of this Pi package.

A provider/API mismatch is security-relevant. Pi can fall through to a base or generic stream when
`model.api !== registered api`, bypassing rotation. Keep the `api` value in `key-rotator.json` equal
to the provider's `api` in `<agent dir>/models.json`. v0.4.0 also checks the selected API at `input`,
every `turn_start`, `before_provider_headers`, and `before_provider_request`. It synchronously calls
`ctx.abort()` before provider dispatch. Header deletion is defense in depth, not the primary fence,
because authentication can also be carried in a query string.

Pi 0.84.2 merges a later registration for the same provider over fields from an earlier one; it does
not definitively reject duplicate provider registrations. The fence therefore uses
`getRegisteredProviderConfig()` and `getRegisteredNativeProvider()` to require exactly `api`,
`apiKey`, and `streamSimple`, their expected values/function identity, no native registration, and
the same registration object captured post-bind. Missing, changed, lookup-error, native, or
replacement evidence at a request boundary latches until extension reload. Compaction and tree summary generation are
cancelled while the managed target is blocked.

The real-host suite covers both an API mismatch and a later competing registration with stored
`auth.json` credentials; a safe result makes no physical request and consumes no pool attempt. This fence applies to Pi's verified `AgentSession` lifecycle pipeline. A trusted extension
can bypass it by calling `ctx.modelRegistry.complete()` or `fetch` directly. It also cannot contain a
malicious trusted extension or provider that mutates registry/request data, ignores `AbortSignal`, or
otherwise bypasses Pi's request hooks.

## 3. Base stream

The wrapper delegates each selected attempt to `streamSimple` from
`@earendil-works/pi-ai/compat`. The selected model keeps its real api type, so Pi resolves the
corresponding adapter. Each attempt sets `maxRetries: 0`; this asks the selected adapter not to run
its normal SDK retry policy.

`maxRetries: 0` is not proof that every nested vendor SDK or adapter loop is disabled. A nested retry
can make more physical calls than the rotator's selected-attempt counter. Codex and future adapters
need separate review.

## 4. Authentication and the inert fallback

Pi requires a provider registration to have an authentication method before it can compose the
provider. Pi configuration values also interpret a leading `!` as a command and `$NAME` as
environment interpolation.

The registration therefore uses the inert, non-empty value `rotator-managed-key`. It never places a
configured env, literal, or command-backed pool secret in the provider registry. Stored Pi
credentials can still win host authentication resolution; the wrapper treats the caller's resolved
`apiKey` as sensitive and replaces it with the selected pool key for the physical attempt. Matching
auth-like header values are rotated too.

This fallback behavior must remain covered by the real Pi loader/auth test. If a future host rejects
the inert value, fail registration rather than falling back to a real configured pool secret.

## 5. Adapter response and diagnostic limits

Pi adapters do not report failures uniformly:

- some HTTP adapters call `onResponse` with status and headers;
- some OpenAI-compatible failures surface only as terminal error text;
- Anthropic can report an error inside an HTTP-200 event stream;
- Google and WebSocket paths can omit `onResponse`;
- diagnostic type names are Pi-specific and can change between releases.

The wrapper may use structured response/diagnostic data and narrowly anchored api-specific fallbacks.
It must not parse arbitrary numbers from error text as HTTP status. If no reliable status exists, it
uses the network/unknown failure path; `Retry-After` is unavailable and `cooldownMs` is used where a
rate limit was otherwise identified.

The pinned host suite must cover real OpenAI-compatible and Anthropic transports. A typecheck against
a new `pi-ai` version is not sufficient.

## 6. Semantic stream boundary

The wrapper can discard and retry only before semantic output is visible. Empty `start` and block
structure events can be buffered. Text, thinking, tool-call content, and unknown extension events are
semantic. After the first semantic event, output stays low-latency and automatic failover stops to
avoid duplicate text or tool execution.

A final provider `done` or `error` is held until the selected outcome commits to state. If that commit
fails, the provider terminal is suppressed and one rotator-owned error is returned. The whole
response is not buffered: semantic incremental events may already be visible.

## 7. Pi agent-level retry is a separate budget

Pi 0.84.2 can classify final assistant error text and restart the whole agent turn. That happens
after this wrapper's `maxAttemptsPerRequest` budget and is not represented in the rotator's counters.
No private lifecycle diagnostic is assumed by this Pi contract.

Do not interpret `maxAttemptsPerRequest` as a strict whole-turn or physical-call ceiling. If that
ceiling is required, set Pi `retry.enabled` to `false` in settings until a pinned Pi release exposes
and the integration suite proves a safe final-error mechanism. Keep
`retry.provider.maxRetries: 0` as well.

### Development recovery policy

The package entry now injects Pi's public `isContextOverflow` and `isRetryableAssistantError`
classifiers into the host-free wrapper. An HTTP 200 handshake does not make a pre-semantic body
failure successful. A recognized transient terminal, iterator failure, or missing terminal can
follow network failover without overriding a reliable HTTP failure or replaying visible output.

Recognized input overflow before output, with no conflicting auth/transient status, receives the
canonical `context_length_exceeded` marker. Pi may compact and retry the changed input through its
bounded recovery policy. Other finalized errors remain retry-neutral. Minimal sanitized failure
metadata is stored in non-context custom entries and exposed through `/key-rotator errors`.

`test/current-host-recovery.integration.mjs` additionally exercises these paths through an installed
Pi 0.99.1 loader and real loopback HTTP adapters. This is a targeted recovery check, not a substitute
for the full host-upgrade checklist below.

## 8. State and cross-process ownership

State v2 uses Pi-specific magic `pi-api-key-rotator-state`, the exact pool id, generation epochs,
credential fingerprints, config revisions, ordered key/target/pool outcomes, and target circuits.
Valid Pi v1 state migrates on the next mutation. State from another product variant is not compatible and must never be placed under the Pi path.

Mutation requires a hard-link-capable filesystem. Lock publication, reclaim claims, atomic state
replacement, previous-version backup, and recovery semantics are described in the README. Every old
Pi writer must stop before a v0.4 writer first updates a state file.

## 9. Command-backed secrets

A command source is resolved by this extension once during config loading. It is not a Pi `!value`
provider configuration. Only trimmed, bounded stdout becomes the in-memory secret; the provider
registration still receives the inert fallback. Cancellation and timeout make a best-effort request
to terminate the process tree, but detached descendants can survive.

## 10. Doctor boundary

`/key-rotator doctor` is read-only and sends no provider request. On Pi 0.84.2 its target check reads
the same public post-bind registration evidence as the request fence. Exact retained evidence is
`OK`; disabled, missing, overwritten, native, replacement, or lookup-error evidence is `FAIL`. Doctor
reads current and already-latched evidence but does not capture identity or latch a new violation. A
violation observed by a request-enforcement boundary remains latched until reload. If a
wildcard-compatible Pi version does not
expose both lookup methods, doctor reports `WARN` rather than treating a local registration call as
host acceptance.

Doctor does not call a provider or validate credentials, quota, Windows ACLs, every adapter's
diagnostic behavior, hard-link mutation without writing, or Pi's future retry classification. Public
registry evidence is not a sandbox or proof against trusted code that bypasses the Pi pipeline.

## 11. Package and module resolution

The package declares Pi core packages as wildcard peers because Pi supplies those modules to package
extensions. Exact `0.84.2` copies are development and contract-test inputs only. Runtime code must not
bundle another Pi core or depend on development dependencies being present after
`npm install --omit=dev`.

The supported package entry is the default factory at `src/index.ts`. Deep imports from `src/*` are
implementation details, not a versioned library API.

## 12. Host-upgrade checklist

Before documenting support for another Pi version:

1. Pin that exact Pi and pi-ai version in a contract-test job.
2. Load the packed package through the real extension loader.
3. Recheck provider/API match, fallback authentication resolution, both public registry lookups, and
   every cancellable fence hook.
4. Re-run stored-`auth.json` mismatch and later competing-registration cases and require zero
   authenticated physical calls and zero pool attempts.
5. Drive real OpenAI-compatible non-2xx and Anthropic in-band errors against local servers.
6. Verify `onResponse`, `Retry-After`, abort, callback, and terminal event shapes.
7. Verify the semantic boundary and that a durable-state failure suppresses the provider terminal.
8. Measure Pi agent-level and provider-level retry behavior; derive it from Pi directly.
9. Run the Windows and POSIX process-lock suites.
10. Review upstream logging before claiming a redaction boundary.
11. Update README, SECURITY, CHANGELOG, and the release compatibility table only after all checks pass.
