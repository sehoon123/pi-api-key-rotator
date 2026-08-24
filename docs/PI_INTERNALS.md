# How v0.4.0 hooks into Pi 0.84.2

This document records the Pi host contract that must be rechecked before claiming support for another
Pi release.

## 1. Verified call chain

1. Pi discovers `src/index.ts` through `package.json` → `pi.extensions`.
2. The default package entry loads `PI_KEY_ROTATOR_CONFIG` when set; otherwise it loads
   `<agent dir>/key-rotator.json`. `<agent dir>` is `$PI_CODING_AGENT_DIR` when set, otherwise
   `~/.pi/agent`. Programmatic config-loader options are not Pi package-install settings.
3. Each configured pool creates one `KeyPool` and one state store.
4. Each target calls `ExtensionAPI.registerProvider(providerId, config)`. During extension loading, Pi
   queues this call; it binds and composes provider registrations later.
5. Pi composes that extension provider with the provider from `models.json` and stored authentication.
6. For a selected model whose `model.api` equals the registered extension `api`, Pi invokes the
   rotator's provider-scoped `streamSimple`.
7. The wrapper selects a credential, calls Pi's generic compatibility `streamSimple`, classifies the
   result, commits the outcome, and then exposes the final terminal event.

The pinned real-host test must exercise this chain from the installed package entry, not only import
lower-level rotator modules.

## 2. Provider-scoped composition, not a global api dispatcher

Pi 0.84.2 composes `streamSimple` for each provider registration. The extension stream is used only
when both the provider id and registered `api` match the selected model. Several independent pools
can therefore use the same api type without a shared global dispatcher.

No global one-dispatcher-per-api layer, builtin stream capture, or private lifecycle diagnostic is
part of this Pi package.

A provider/api mismatch is security-relevant. Pi can fall through to a base or generic stream when
`model.api !== registered api`, bypassing rotation. Keep the `api` value in `key-rotator.json` equal
to the provider's `api` in `<agent dir>/models.json`. The model-selection warning and `doctor` output
are local diagnostics, not a request fence or proof of the final host composition.

Pi 0.84.2 also merges a later registration for the same provider over fields from an earlier one. It
does not definitively reject duplicate provider registrations. Load order can therefore replace the
rotator's stream. The real-host suite must cover both an API mismatch and a later competing
registration with stored `auth.json` credentials; a safe result makes no authenticated physical
request and consumes no pool attempt.

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

`/key-rotator doctor` is read-only and sends no provider request. Its target check compares config
with the provider/api pairs captured immediately after this extension made its own local registration
calls. It does not query Pi's final composed provider, confirm that queued registration later bound,
or detect a later/duplicate winner. It also cannot validate credentials, quota, Windows ACLs, every
adapter's diagnostic behavior, hard-link mutation without writing, or Pi's future retry
classification.

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
3. Recheck provider/api match and fallback authentication resolution.
4. Drive real OpenAI-compatible non-2xx and Anthropic in-band errors against local servers.
5. Verify `onResponse`, `Retry-After`, abort, callback, and terminal event shapes.
6. Verify the semantic boundary and that a durable-state failure suppresses the provider terminal.
7. Measure Pi agent-level and provider-level retry behavior; derive it from Pi directly.
8. Run the Windows and POSIX process-lock suites.
9. Review upstream logging before claiming a redaction boundary.
10. Update README, SECURITY, CHANGELOG, and the release compatibility table only after all checks pass.
