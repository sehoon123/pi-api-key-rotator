# Changelog

All notable release-facing changes are documented here.

## [Unreleased]

### Changed

- The status-bar footer now uses the shared glyph language (● healthy, ◐ cooldown,
  ✗ disabled/fault) with semantic colors, and modern compact text: `key-1 3/50`,
  `key-1 · cooldown 45s`, `key-1 · disabled`; multi-pool footers read
  `pool · key n/m`. The footer is hidden entirely for the ordinary
  not-my-job states (no model selected, unmanaged provider) instead of
  advertising `rotation inactive: ...`; actionable config faults render red
  (`api mismatch · selected X ≠ configured Y`, `pool <id> · disabled (state
  preflight)`, `✗ rotation disabled` in disabled mode). Full detail stays in
  `/key-rotator status` and doctor output, which remain the verbose homes.

### Added

- `retryTransientAtAgentLevel` (default `false`) lets safe pre-output transient failures enter Pi's
  configured bounded outer retry instead of turning every exhausted wrapper error into a terminal
  stop. Auth/permission failures, explicit budget exhaustion, the host's quota/billing veto,
  cancellation, local state errors, and visible output remain terminal.
- `maxCooldownWaitMs` (default `0`; range 0-900,000 ms) provides a cumulative, abortable cooldown
  wait budget per wrapper invocation. It requires the outer-retry opt-in and waits only before the
  first credential selection, without a provider request, state reset, or state lock held asleep.
- Targeted Pi 1.4.0 loopback integration tests cover transient recovery, cooldown waiting, bounded
  retry exhaustion, cancellation, partial-output safety, and API fencing; a test-only peer resolver
  supports using an installed host without vendoring Pi core. See `docs/UNATTENDED_RECOVERY.md`.
- `budgetCooldownMs` (default 3,600,000 ms; range 0-86,400,000; 0 disables the extra minimum).
  Explicit HTTP 429 `budget_exceeded` / `insufficient_quota` errors now use this longer minimum
  instead of retrying an exhausted budget every minute. Classification uses bounded SDK error JSON
  or supported structured diagnostics, not keyword guesses. The existing durable cooldown and
  `rateLimitScope` are preserved; under key scope even free models on that key wait. Other eligible
  keys can fail over immediately. No raw error body or new state-schema field is persisted.

### Fixed

- Anthropic HTTP-200 in-band `api_error` / `internal_server_error` envelopes are classified as HTTP
  500 rather than tentative success or an unknown network failure. A real non-2xx HTTP response
  remains authoritative.
- A transient HTTP `Retry-After`, including on 503, opens the target circuit immediately instead of
  trying another credential before the backend's requested delay. The existing parsing cap applies.
- Recoverable final failures are reported as warnings while their sanitized cause remains available
  through `/key-rotator errors`.
- A same-request failover after a transport failure with no provider response now waits before the next
  credential attempt (1 s, 3 s, 6 s, then 10 s for later attempts) instead of retrying instantly.
  Networks that briefly refuse new TCP connections used to spend the whole attempt budget inside the
  same refusal window, ending in `Credential failover exhausted ... Connection error` or
  `The credential rotator stopped this request`. The delay is abort-aware, so cancellation still
  returns immediately and no state-schema or config change is required.
- Google Generative AI and Vertex adapters no longer receive an injected `fetch`, which both Pi
  0.84.2 and 1.3.0 reject before making a request. Explicit caller custom transports are refused
  before any pool attempt instead of being silently discarded. JSON-only Google errors use the
  bounded `error.code` field for HTTP classification, so a 429 can fail over to another key.
- **A request no longer fails while a usable key sits parked as `disabled`.** A `401/402/403` used to
  disable a credential until `/key-rotator reset` or a secret change, even if the key was re-issued,
  unblocked or topped up later. When the only enabled key was then exhausted (for example `429
  budget_exceeded`), the wrapper reported `Credential failover exhausted 1 attempt(s)` or `No rotation
  entry is currently available` without ever trying the disabled keys, although they worked.
  When no healthy credential can serve the request, the pool now re-checks the disabled credential whose
  last attempt is oldest, at most once per `cooldownMs` per credential, counted against
  `maxAttemptsPerRequest`. Success re-enables the key. Healthy keys are still always preferred, a key in its
  own `429` cooldown is skipped, and no state-schema or config change is required.
- `No rotation entry is currently available (...)` now names when a disabled credential may be
  re-checked (`disabled: ...; next re-check <time>`).

## [0.4.0] - 2026-08-24

### Compatibility and packaging

- Targets Pi `0.84.2`, its matching `@earendil-works/pi-ai`, and Node.js `>=22.19.0`.
- Adds `PI_CODING_AGENT_DIR` support for default config and state paths. The package entry uses
  `PI_KEY_ROTATOR_CONFIG` for the config when set; otherwise it uses
  `<PI_CODING_AGENT_DIR>/key-rotator.json` or `~/.pi/agent/key-rotator.json`. The config override does
  not move default state files.
- Keeps Pi core modules as wildcard peers, as required by Pi package loading, while pinning exact
  `0.84.2` development and contract-test copies in a tracked lockfile.
- Adds Ubuntu/Windows × Node 22.19/24 CI, coverage thresholds, packed-install smoke, and a pinned real
  Pi host contract job.
- Moves root config examples into `examples/key-rotator.*.example.json` and the pool guide into
  `docs/MULTI_POOL.md`; old root example paths are not part of the v0.4 package.
- Install the reviewed tag:

  ```bash
  pi install git:github.com/sehoon123/pi-api-key-rotator@v0.4.0
  ```

### Breaking and behavior changes

- **Default request budget:** omitted `maxAttemptsPerRequest` now resolves to
  `min(keys.length, 3)`, not all configured keys. Set it explicitly to retain a larger budget.
- **Transient health scope:** retryable transient HTTP statuses and network failures update a provider
  target circuit. They no longer apply key-specific `transientCooldownMs`. The selected key's failure
  counter still increases.
- **Circuit cutoff:** `targetFailureThreshold` defaults to `2`. A circuit can stop one wrapper
  invocation before its configured key-attempt budget is exhausted.
- **Strict state refusal:** malformed JSON/UTF-8, wrong-version/magic/pool, oversized, non-regular,
  symlinked, wrong-owner, or group/other-writable state fails closed and is not replaced with fresh
  state.
- **Hard-link requirement:** state mutation requires atomic hard-link support for lock publication and
  stale-lock claims. Unsupported filesystems fail rather than using a weaker lock.
- **Dynamic state limit:** `maxStateFileBytes` defaults to 1 MiB and allows 1 KiB-16 MiB, but must also
  meet a computed pool-specific minimum.
- **Command budget:** the whole config is limited to 64 command-backed keys and 600,000 ms of summed
  configured command timeout. Secret limits cover UTF-8 bytes and UTF-16 code units.
- **Attempt meaning:** counters represent selected rotator attempts. Nested SDK retries and Pi's
  separate agent-level retry can produce more physical network calls.
- **Host support claim:** v0.4.0 targets Pi 0.84.2. Provider composition, adapter diagnostics, and Pi
  error retry are version-specific contracts, not an automatic “or later” promise.

### Added

- `configVersion: 1` at the document root and strict unknown-field rejection.
- `rateLimitScope: "key" | "target" | "pool"`, default `"key"`, for `cooldownStatuses`.
- `targetFailureThreshold`, default `2`, with per-target consecutive-failure, cooldown, status,
  timestamp, and ordered-outcome state.
- `/key-rotator doctor`, which sends no provider request and reports config/state/lock safety plus
  public Pi post-bind registration evidence. Exact retained evidence is `OK`; unavailable inspection
  is `WARN`; disabled, missing, changed, native, lookup-error, or replacement evidence is `FAIL`.
- `maxStateFileBytes` dynamic minimum sized for a worst-case state v2 object and rolling-config
  overlap.
- Physical path collision detection across config, state, `.lock`, `.lock.reclaim`, and `.bak`,
  including symlinked ancestors and existing inode/hard-link aliases. It runs before key commands.
- Command-backed keys with cancellation, enforced deadlines, bounded stdout, and best-effort process-
  tree termination.
- An inert `rotator-managed-key` provider fallback so real env, literal, and command-backed pool
  secrets are not registered as Pi provider config values.
- English and Korean READMEs, security policy, secret-handling guide, Pi host-internals guide, JSON
  Schema, versioned examples, and recovery runbook.

### Config and secret loading

- Config is capped at 1,048,576 bytes and must be valid UTF-8.
- On POSIX, config must be a regular non-symlink file owned by the effective user and not writable by
  group or other users. Group/world readability warns; Windows ACL policy is not inspected.
- There can be at most 128 pools, 128 targets per pool, and 256 keys per pool. Provider/api strings,
  paths, status arrays, and all numeric fields have explicit bounds.
- Key definitions accept exactly one of `env`, `value`, or `command`. Resolved values must be unique,
  well-formed Unicode, at most 65,536 UTF-16 code units, and at most 131,072 UTF-8 bytes.
- Command resolution runs sequentially once per load, discards stderr, bounds stdout, observes caller
  cancellation, and has an aggregate 600,000 ms startup deadline.

### State integrity and rolling config

- State becomes version `2` with Pi-specific magic `pi-api-key-rotator-state`, exact `poolId`, and
  positive `generation`. Valid Pi v1 state migrates on the next mutation.
- Per-key state stores lowercase SHA-256 `credentialFingerprint` and a monotonic local
  `configRevision`. It never stores the raw secret.
- A selection captures generation as its epoch and captures credential identity. Outcomes with an old
  epoch or identity are ignored.
- Replacing a secret under an existing key id resets that identity's key-specific health. Older
  workers cannot select or mutate the replacement identity.
- Valid temporarily unconfigured records are preserved during rolling-config overlap, bounded to one
  maximum prior set (256 keys and 128 targets).
- Newer success outcomes fence older late key, target, and pool-health failures.
- Pool cooldown and target circuit state are durable and visible in status.

### Stream finalization and Pi host boundary

- Empty `start` and block-structure events are buffered until text, thinking, tool-call content, or an
  unknown semantic event appears. A pre-semantic in-band retryable failure can discard structure and
  fail over.
- Semantic incremental events remain low-latency. Once visible, failover stops to avoid duplicate
  output or tool calls.
- A provider `done`/`error` terminal is not exposed until its outcome transaction commits. A rejected
  commit suppresses that terminal and emits one internal error.
- Error diagnostics are recursively bounded and sanitize configured/caller/auth-header secrets,
  bounded prefixes, URI/JSON-escaped forms, base64/base64url forms, cycles, and prototype-shaped data.
  Already-streamed assistant content is preserved.
- Provider status classification uses supported structured data and narrowly anchored api-specific
  fallbacks. Arbitrary numeric error text is not parsed as status.
- Pi 0.84.2 agent-level retry is a separate budget. This package assumes no private host lifecycle marker. Set Pi `retry.enabled` to `false` when a strict whole-turn ceiling is required.
- Provider registration remains Pi provider-scoped. The managed request fence checks API match and
  public registration evidence at `input`, every `turn_start`, and both provider-request hooks. It
  synchronously aborts blocked requests before dispatch and cancels compaction/tree summaries.
- Pi 0.84.2 may merge a later registration for the same provider instead of rejecting it. The fence
  requires the exact API, inert key, guarded stream function, safe field set, no native provider, and
  captured registration-object identity. A request-boundary violation latches until reload; doctor
  reads evidence without changing the latch. Disabled pools keep their
  targets fenced even though registration is omitted.
- The real-host contract covers API mismatch and competing-registration paths with stored `auth.json`
  credentials; both make zero physical requests and consume zero pool attempts. Header deletion is
  defense in depth because query-string authentication requires aborting before dispatch.
- These guarantees cover Pi's `AgentSession` lifecycle pipeline. Direct
  `ctx.modelRegistry.complete()`/`fetch` calls, ignored cancellation, and malicious trusted code that
  bypasses Pi hooks are out of scope.

### Lock, backup, and crash behavior

- A complete, synced lock candidate is atomically published with a hard link. The fixed lock path is
  never intentionally exposed empty or partially written.
- Stale-lock removal uses a creator-owned `.lock.reclaim` hard-link claim. Pre-existing claims are
  never deleted automatically. New owners wait for claim absence and revalidate ownership before
  mutation; claimant crashes fail closed and require recovery.
- A lock is reclaimed only when old enough, structurally valid, and owned by a proven-dead process.
  Malformed metadata fails closed. Linux process-start ticks help detect PID reuse.
- State candidates are written and synced before replacement. The previous immutable state inode is
  hard-linked to a temporary backup and published as `.bak` before the new atomic rename.
- The backup is normally the previous complete version and is not restored automatically. If safe
  replacement is refused, the older known-good backup is retained and can lag further.
- Windows sharing violations are retried without rerunning the state mutator. Lock publication,
  observation, replacement, cleanup, deadlines, and cancellation retain ownership checks.

### Known upstream limits

- Pi adapters do not report every failure uniformly. Some paths omit `onResponse`, status, structured
  diagnostics, or `Retry-After`; an unclassified failure cannot receive status-specific policy.
- pi-ai or a vendor SDK can log sensitive material before an event reaches wrapper redaction.
- `maxRetries: 0` does not prove every nested SDK disabled retry.
- Pi can restart a final provider-like assistant error through agent-level retry after this wrapper
  exhausts its own budget.

### Migration from v0.1-v0.3

1. Stop all old Pi sessions and processes that can write the state files.
2. Back up each main state and every existing sidecar to a private directory.
3. Remove any duplicate vendored/local extension copy.
4. Install `@v0.4.0` and run `/reload`.
5. Run `/key-rotator doctor` and `/key-rotator status` for every pool.
6. If more than three key attempts are intentional, set `maxAttemptsPerRequest` explicitly.
7. Choose `rateLimitScope`. Omission preserves key-scoped `429` behavior.
8. Confirm each `stateFile` is on a private local hard-link-capable filesystem.
9. If `maxStateFileBytes` is custom, use at least the exact minimum reported by the loader.
10. Review Pi `retry.enabled`; it is separate from the wrapper attempt budget.

Do not keep a v0.1-v0.3 writer alive during the first v0.4 mutation. Old writers do not preserve v2
fields or the final reclaim protocol.

### Recovery runbook

The implementation deliberately does not auto-repair untrusted state. `/key-rotator reset` cannot
repair a file that fails validation because reset must read it first.

#### 1. Stop and preserve

Stop every possible writer. Copy the main state, `.bak`, `.lock`, and `.lock.reclaim` files to a
mode-`0700` recovery directory. Preserve the exact error. Never delete a lock based only on mtime.

#### 2. Fix by failure class

| Failure | Safe action |
|---|---|
| unsafe owner/mode | restore the effective user's ownership and mode `0600`; ensure the private parent is writable/searchable |
| config/state physical collision | give each pool a distinct real state path; do not unlink the config or another pool's state |
| wrong pool id | point config back to that state's pool, or archive it and start the intended pool separately |
| oversized/corrupt/invalid state | prefer a verified same-pool `.bak`; do not raise the cap merely to parse attacker-sized data |
| dynamic size minimum | raise the configured limit within 16 MiB or reduce keys/targets/id lengths |
| hard links unsupported | move state and all sidecars to a local hard-link-capable filesystem |
| lock timeout | wait for a live owner; after all writers stop, archive stale `.lock` and `.lock.reclaim` together |

#### 3. Restore a verified backup

`.bak` is one complete version behind and can lose the latest transaction. Confirm its JSON has
`magic: "pi-api-key-rotator-state"`, supported version, and exact pool id. Then, in the state
directory:

```bash
state="$HOME/.pi/agent/key-rotator-POOL_ID.state.json"
cp "$state" "$state.failed.$(date +%s)"
cp "$state.bak" "$state.recovered.tmp"
chmod 600 "$state.recovered.tmp"
mv "$state.recovered.tmp" "$state"
```

If `PI_CODING_AGENT_DIR` or a custom `stateFile` is used, substitute that path.

#### 4. Destructive fresh state

If there is no valid same-pool backup, first revoke or fix any credential that must not be re-enabled.
After all writers stop, archive the main state and every sidecar. Reload and let the package create
fresh state. This intentionally loses counters, circuits, cooldowns, and disabled flags.

#### 5. Verify

Run `/reload`, `/key-rotator doctor`, and `/key-rotator status`. On Pi 0.84.2 doctor checks public
post-bind provider evidence but does not call a provider or sandbox trusted extensions. Inspect Pi
startup diagnostics, remove duplicate registrations, and make one controlled provider request only
after doctor no longer reports a state/path/registration failure.

## [0.3.0] - 2026-08-19

- Added several fully independent endpoint pools in one config document.
- Added pool-targeted `list`, `status`, `next`, and `reset` command behavior.

## [0.2.0] - 2026-08-18

- Added one shared credential pool across several Pi provider targets.
- Kept the legacy single-provider config form compatible.

## [0.1.0] - 2026-08-17

- Initial Pi extension with environment-backed key rotation, per-key counters, failover, file state,
  and status/reset commands.
- Literal key support was completed after the initial tag and is documented as part of the historical
  pre-v0.2 development line.
