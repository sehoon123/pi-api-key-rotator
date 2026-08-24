# pi-api-key-rotator

한국어 문서: [README.ko.md](README.ko.md)

A [Pi](https://github.com/earendil-works/pi) extension that owns one or more pools of
interchangeable API credentials. It selects a key for each **rotator-controlled provider attempt**,
can fail over before semantic output starts, and keeps shared state across sessions and processes.

The extension does not persist a raw secret. State v2 stores a SHA-256 credential identity so stale
workers cannot apply an outcome to a replacement secret. Error data that reaches the wrapper is
bounded and redacted. Upstream adapters, SDK logs, and Pi's separate agent-level retry are outside
that boundary; see [Known upstream limits](#12-known-upstream-limits).

```text
footer:  pi-api-key-rotator   ibm-ica-shared: ica-key-3 7/20
```

## 1. What v0.4.0 does

- Rotates after `requestsPerKey` selected attempts.
- Tries at most `maxAttemptsPerRequest` distinct keys for one logical wrapper request. The default is
  `min(keys.length, 3)`.
- Disables a credential on `401/402/403` by default when a supported adapter exposes that status.
- Applies a classified `429` cooldown at `key`, `target`, or `pool` scope.
- Treats retryable transient HTTP and network failures as target health failures. A target circuit
  opens after `targetFailureThreshold` consecutive failures.
- Buffers only non-semantic stream structure. It never fails over after text, thinking, or tool-call
  content becomes visible.
- Holds the final provider terminal until the outcome state transaction commits.
- Uses state v2 generation and credential-identity fences to ignore stale reset and rolling-config
  completions.
- Uses atomic replacement, a previous-version backup, and cross-process hard-link locks.
- Refuses corrupt, wrong-pool, oversized, or unsafe state instead of silently resetting it.
- Adds command-backed secret sources and `/key-rotator doctor` for read-only local checks.

## 2. Requirements and compatibility

- **Pi `0.84.2`** and its matching `@earendil-works/pi-ai`. This is the verified host contract for
  v0.4.0.
- **Node.js `>=22.19.0`**.
- At least two independently usable API keys per pool.
- Each provider must already exist in `<agent dir>/models.json`. Its `api` must exactly match this
  config; Pi can bypass the extension stream on an api mismatch.
- The state directory must be on a filesystem that supports atomic hard links.

Pi's provider composition, adapter events, and retry classification are version-specific. Review
[docs/PI_INTERNALS.md](docs/PI_INTERNALS.md) before using another Pi version.

Pi also has an agent-level retry budget outside this extension. `maxAttemptsPerRequest` limits one
wrapper invocation, not the whole agent turn. Set `retry.enabled` to `false` in Pi settings if a
strict whole-turn ceiling is required. Keep `retry.provider.maxRetries` at `0`.

> **More keys do not necessarily add quota.** Keys from one account, project, or organization often
> share one quota bucket. Check the provider policy first.

## 3. Install, update, and remove

Pin the reviewed release:

```bash
pi install git:github.com/sehoon123/pi-api-key-rotator@v0.4.0
```

After creating the config in [Quick start](#5-quick-start), run inside a session:

```text
/reload
/key-rotator doctor
/key-rotator status
```

A pinned source does not move to a new tag when `pi update --extensions` runs. To adopt a later
reviewed release, install that new ref explicitly:

```bash
pi install git:github.com/sehoon123/pi-api-key-rotator@vNEXT
```

`pi update --extensions` can reconcile the already selected ref. Remove the package with `pi remove`
using the source shown in Pi settings.

An unpinned install tracks future code that can read credentials. Re-review every update. Never keep
a real config, state file, or local edit inside Pi's installed package clone. Git-package
reconciliation can reset and clean that clone.

## 4. Upgrade from v0.1-v0.3

This is a quiescent state upgrade:

1. Stop every Pi session and process that can write these state files.
2. Copy each state file and any existing sidecars to a private backup directory.
3. Remove any duplicate vendored/local copy of the extension.
4. Install the v0.4.0 tag and run `/reload`.
5. Run `/key-rotator doctor`, then `/key-rotator status` for every pool.

Valid Pi v1 state is normalized in memory and written as Pi state v2 on the next mutation. The
filename stays `key-rotator-<poolId>.state.json`. Do not leave a v0.1-v0.3 process writing after
v0.4 starts; old writers do not preserve generation, credential identity, target health, or the new
lock protocol.

Review these behavior changes before rollout:

- An omitted `maxAttemptsPerRequest` no longer means every configured key. It means at most three.
- Transient and network health is target-scoped, rather than a key-specific cooldown.
- State and lock validation is stricter and fails closed.
- Mutations require hard-link support.
- A custom `maxStateFileBytes` must meet a new pool-specific minimum.
- Packaged examples moved from root `config*.example.json` names to `examples/key-rotator.*.example.json`.
- Pi agent-level retry remains a separate budget unless disabled in Pi settings.

See [CHANGELOG.md](CHANGELOG.md) for all behavior changes and recovery details.

## 5. Quick start

The install command does not put the examples in your current working directory. Download the pinned
example instead. Use absolute values if `PI_CODING_AGENT_DIR` or `PI_KEY_ROTATOR_CONFIG` is set.

```bash
umask 077
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
config_file="${PI_KEY_ROTATOR_CONFIG:-$agent_dir/key-rotator.json}"
mkdir -p "$(dirname "$config_file")"
curl --fail --location \
  https://raw.githubusercontent.com/sehoon123/pi-api-key-rotator/v0.4.0/examples/key-rotator.literal.example.json \
  --output "$config_file"
chmod 600 "$config_file"
# In "$config_file", match provider/api to <agent dir>/models.json and
# replace every sk-REPLACE-ME-* placeholder with a real key.
```

The package entry reads `PI_KEY_ROTATOR_CONFIG` when it is set. Otherwise it reads
`<agent dir>/key-rotator.json`, where `<agent dir>` is `$PI_CODING_AGENT_DIR` when set and
`~/.pi/agent` otherwise. A relative override is resolved from the Pi process working directory, so
use an absolute path. `PI_KEY_ROTATOR_CONFIG` changes only the config path. It does not change the Pi
agent directory or the default state-file directory.

The example provider ids and `api` values are placeholders. They do not create a provider or model.
Match them exactly to an existing entry in `<agent dir>/models.json` before `/reload`. For an `env`
example, export every named variable in the environment that starts the Pi process. A variable set in
another terminal is not imported by `/reload`.

Other examples:

| File | Shape |
|---|---|
| [`examples/key-rotator.env.example.json`](examples/key-rotator.env.example.json) | one pool, environment sources |
| [`examples/key-rotator.literal.example.json`](examples/key-rotator.literal.example.json) | one pool, placeholder literal sources |
| [`examples/key-rotator.command.example.json`](examples/key-rotator.command.example.json) | one pool, vault/keychain commands |
| [`examples/key-rotator.multi-pool.example.json`](examples/key-rotator.multi-pool.example.json) | two independent pools |
| [`examples/key-rotator.ibm-ica.example.json`](examples/key-rotator.ibm-ica.example.json) | one shared pool with two Pi provider targets |

The editor schema is [`docs/key-rotator.schema.json`](docs/key-rotator.schema.json). Configure that
path in the editor. Do **not** add a `$schema` property to `key-rotator.json`; runtime validation
rejects unknown fields. Runtime validation is authoritative, including cross-field, physical-path,
and dynamic-size checks that JSON Schema cannot express.

## 6. Configuration reference

A document is either one pool object or `{ "pools": [<pool>, ...] }`. There can be at most 128 pools.
`configVersion` is optional; when present it must be the integer `1` and appears only at the document
root. Top-level `pools` cannot be combined with pool fields.

| Field | Default | Runtime rules |
|---|---|---|
| `poolId` | sanitized first provider id | 1-64 chars matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; stable pool and state identity |
| `targets[]` | multi-target form | 1-128 `{ provider, api }` objects; provider ids must be unique |
| `provider` + `api` | legacy single-target form | use both together and never with `targets` |
| `keys[]` | required | 2-256 entries; each has `id` and exactly one of `env`, `value`, or `command` |
| `requestsPerKey` | `20` | 1-1,000,000 selected rotator attempts, summed across a shared pool |
| `maxAttemptsPerRequest` | `min(keys.length, 3)` | 1-`keys.length`; distinct keys considered for one wrapper invocation |
| `cooldownMs` | `60000` | 0-86,400,000 ms; fallback when `Retry-After` is missing or invalid |
| `transientCooldownMs` | `5000` | 0-3,600,000 ms; target-circuit duration for transient/network failure |
| `maxRetryAfterMs` | `900000` | 0-86,400,000 ms; `0` removes the configured cap, subject to safe-integer limits |
| `retryStatuses` | `401,402,403,408,409,425,429,500,502,503,504` | non-empty; every status is 100-599 |
| `disableStatuses` | `401,402,403` | may be empty; subset of `retryStatuses` |
| `cooldownStatuses` | `429` | may be empty; subset of `retryStatuses` and disjoint from `disableStatuses` |
| `rateLimitScope` | `"key"` | `"key"`, `"target"`, or `"pool"`; applies to `cooldownStatuses` |
| `targetFailureThreshold` | `2` | 1-100 consecutive transient/network failures before a target circuit opens |
| `retryNetworkErrors` | `true` | controls same-request failover; target health still updates when false |
| `stateFile` | `<agent dir>/key-rotator-<poolId>.state.json` | absolute, `~`-relative, or relative to the config directory; must not collide with another artifact |
| `lockTimeoutMs` | `5000` | 100-60,000 ms |
| `staleLockMs` | `30000` | 1,000-600,000 ms; a live owner is not reclaimed merely because it is old |
| `maxStateFileBytes` | `1048576` | 1,024-16,777,216 bytes and at least the dynamic minimum below |

Unknown fields are rejected. Pool ids are unique case-insensitively. A provider can belong to only
one independent pool. `stateFile`, `.lock`, `.lock.reclaim`, and `.bak` locations must all be unique.
Provider and api strings allow at most 256 characters; a state path allows at most 4,096.

### Dynamic `maxStateFileBytes` minimum

The loader computes a minimum from the UTF-8 serialized worst-case v2 record for the configured pool
id, key ids, and target ids. It reserves room for current records plus a bounded maximum prior
rolling-config generation (up to 256 unconfigured keys and 128 unconfigured targets), then adds 1,024
bytes. The nominal 1,024-byte range minimum is therefore not enough for a real pool. If the configured
value is too small, loading reports the exact required byte count. The configured limit is enforced
before state is read or written.

### Key sources and command limits

| Source | Example | Notes |
|---|---|---|
| `env` | `{ "id": "k1", "env": "MY_KEY_1" }` | read from the Pi process environment; GUI launches may not inherit a shell profile |
| `value` | `{ "id": "k1", "value": "sk-REPLACE-ME-1" }` | plaintext in config; keep the file private |
| `command` | `{ "id": "k1", "command": "op read op://Private/ai/k1", "commandTimeoutMs": 10000 }` | runs once, sequentially, during load; trimmed stdout becomes the in-memory secret |

Secret values must be well-formed Unicode and allow at most 65,536 UTF-16 code units and 131,072
UTF-8 bytes. A command string allows 4,096 characters. `commandTimeoutMs` defaults to 10,000 and
allows 100-120,000 ms. Across the document, at most 64 command-backed keys and 600,000 ms of configured
timeout budget are allowed. Resolution also has a 600,000 ms aggregate startup deadline. Stdout is
capped at 132,096 bytes; stderr is ignored. Output and rejection details are not copied into extension
errors.

Timeout or cancellation closes stdout and requests process-tree termination. On POSIX this sends
`SIGKILL` to a detached process group. On Windows it tries `taskkill /T /F`, then direct termination.
This is best effort: a command can create a detached child that survives. Configure only trusted,
bounded commands. See [docs/SECRETS.md](docs/SECRETS.md).

## 7. Shared pools, rate-limit scope, and target circuits

A shared pool has several `targets`. Keys, selection counters, disabled credentials, and the current
key are shared. Target circuit state is separate for each provider target.

An independent `pools[]` entry has its own keys, policy, and state file. Two independent pools can use
the same `api` type, but a provider id can belong to only one pool. See
[docs/MULTI_POOL.md](docs/MULTI_POOL.md).

`rateLimitScope` controls the blast radius of a status in `cooldownStatuses`:

| Scope | On classified `429` by default | Availability |
|---|---|---|
| `key` | cool the selected credential for parsed `Retry-After` or `cooldownMs` | that credential stops on every shared target; other keys can continue |
| `target` | open that provider target circuit immediately for the delay | other targets in the shared pool can continue |
| `pool` | cool the entire pool immediately for the delay | no target or key in that pool can continue |

For another classified retryable transient status, or a network failure, the selected key's failure
counter is updated but the key is not cooled or disabled. The target's consecutive-failure count
increases. At `targetFailureThreshold`, its circuit opens for `transientCooldownMs`. A newer success
clears health for its key and target and clears an older pool cooldown. Attempt ordering prevents an
older late failure from re-disabling that key or reopening the cleared scope.

With the default threshold `2`, two consecutive target failures can stop a wrapper invocation before
a third key is consumed. A target- or pool-scoped rate limit opens its scope immediately, so another
key cannot continue against that unavailable scope in the same invocation.

## 8. Stream and failure policy

The actions below apply when the Pi adapter exposes a reliable HTTP status or supported structured
failure. See [Known upstream limits](#12-known-upstream-limits) for adapters that do not.

| Outcome before semantic output | Durable action | Same-wrapper failover |
|---|---|---|
| normal `2xx`/`3xx` terminal | success | no |
| `disableStatuses` | disable selected credential | yes, if another key and scope are available |
| `cooldownStatuses` | apply `rateLimitScope` delay | only if the selected scope remains available |
| other `retryStatuses` | update target circuit | yes, until circuit/attempt budget stops it |
| non-retry status such as `400` | record failure and forward final error | no |
| network/stream failure without a response | update target circuit | when `retryNetworkErrors` is true |
| caller callback failure | selected attempt remains counted; no health penalty | no |
| caller abort | no disable/cooldown health penalty | no |

Each selected attempt passes `maxRetries: 0` to the adapter. The extension's counters represent
selected rotator attempts, not guaranteed physical network calls. Nested SDK behavior and Pi's outer
agent-level retry can make more calls.

### Semantic-event buffering

Empty `start`, block structure, and other non-semantic events are buffered until real text, thinking,
or tool-call content appears. An in-band retryable failure can discard only that pre-semantic
structure. Unknown extension events are treated as semantic for compatibility.

Once semantic content is forwarded, events use low-latency streaming and automatic failover stops. If
the source then fails, the wrapper emits one terminal for that invocation instead of replaying the
request and risking duplicate text or tool calls.

### Durable terminal gate

The final `done` or `error` event is held until the success/failure transaction commits to state. If
that commit fails, the provider terminal is suppressed and an internal key-rotator error is sent. This
does not buffer the whole response; semantic incremental events can already be visible.

Pi 0.84.2 can independently retry a final provider-like error at the agent level. This package does not assume a private host lifecycle diagnostic. Disable Pi `retry.enabled` when a strict total
attempt limit is required.

## 9. Commands and doctor

| Command | Effect |
|---|---|
| `/key-rotator` | same as `status` |
| `/key-rotator status [poolId]` | full status of all pools, or one pool |
| `/key-rotator list` | one compact line per pool |
| `/key-rotator doctor` | read-only local config, state, and provider/api checks; sends no request |
| `/key-rotator next <poolId\|all>` | advance the current key |
| `/key-rotator reset <poolId\|all>` | clear health/counters and increment the state generation |

With several pools, a bare `next` or `reset` uses the pool for the selected model when one can be
inferred. Otherwise it refuses and asks for a pool id or `all`.

`doctor` checks config metadata, state size/ownership/mode/readability, parent writability, strict
read-only state parsing, and the provider/api pairs that this extension locally submitted for
registration. It reports `OK`, `WARN`, or `FAIL`. It does not inspect Pi's final composed provider,
detect a later or duplicate registration, or prove that the host will call the rotator stream. It
also does not call a provider, validate credentials or quota, inspect Windows ACLs, prove every
adapter's failure shape, or prove hard-link support without a mutation. If config loading failed, the
disabled `/key-rotator` command shows that load error; the full doctor is not available yet.

## 10. State v2, locks, and fail-closed behavior

Pi state v2 contains:

- `magic: "pi-api-key-rotator-state"`, `version`, `poolId`, and positive `generation`;
- current-key and attempt counters, timestamps, pool cooldown, and its success-ordering fence;
- per-key counters/health, outcome ordering, `credentialFingerprint`, and `configRevision`;
- per-target failure, ordering, and circuit fields.

`credentialFingerprint` is lowercase SHA-256 of the resolved secret. The raw secret is never written
to state. The hash is identity metadata, not encryption; low-entropy secrets can be guessed offline.
Status snapshots omit both the hash and config revision.

A selection captures state generation as its epoch and captures the credential fingerprint. `reset`
increments generation, so an older in-flight completion cannot re-disable a reset pool. When a newer
config replaces the value under the same key id, key-specific health resets for the new identity.
Old workers and in-flight outcomes cannot update that replacement. Temporarily unconfigured, valid
records are preserved during rolling config overlap, bounded to 256 keys and 128 targets.

For each committed write, the extension:

1. writes and `fsync`s a unique mode-`0600` candidate;
2. hard-links the previous immutable state version and moves that link to `<stateFile>.bak`;
3. atomically renames the candidate over the state file;
4. syncs the parent directory where the platform supports it.

The `.bak` file is normally the **previous** complete state and is not restored automatically. If the
platform refuses safe backup replacement, the older known-good backup is kept and can lag by more
than one transaction. The first state write has no prior backup.

Cross-process mutation publishes a complete, synced lock candidate at `<stateFile>.lock` through a
hard link. The creator-owned `<stateFile>.lock.reclaim` hard link serializes compare-and-unlink stale
recovery. A pre-existing reclaim claim is never deleted automatically because Node has no portable
pathname compare-and-delete operation. A claimant crash fails closed and requires recovery. A time
stamp alone never steals a live owner's lock. Linux also records a process-start marker to detect PID
reuse. Malformed lock metadata and unsupported hard-link filesystems fail closed.

The extension does not overwrite evidence when state has malformed JSON/UTF-8 or invalid known
fields, an unknown version/magic, the wrong `poolId`, unsafe type/ownership/write mode, a symlink or
repeated identity race, or exceeds `maxStateFileBytes`. A missing state file alone starts fresh.

The loader rejects lexical and physical path collisions **before command-backed secrets run**. It
resolves symlinked ancestors and existing inode/hard-link aliases for config, state, lock, reclaim,
and backup paths across all pools. Keep them in a private local directory. This point-in-time check is
not a sandbox against a hostile process running as the same OS user.

## 11. Recovery

Do not use `/key-rotator reset` to repair corrupt, wrong-pool, oversized, or unsafe state. Reset first
has to read and validate the existing file.

1. Stop every Pi process that can use the pool.
2. Preserve the state, `.bak`, `.lock`, and `.lock.reclaim` files for diagnosis.
3. Fix the cause:
   - unsafe mode/owner: restore the correct owner and use `chmod 600`;
   - wrong pool/path collision: point the pool to its own state file;
   - dynamic size error: raise `maxStateFileBytes` within 16 MiB or reduce ids/keys/targets;
   - unsupported hard links: move state to a local hard-link-capable filesystem;
   - lock timeout: confirm every owner is stopped, preserve both sidecars, then archive stale `.lock`
     and `.lock.reclaim` together. Never remove only one while a writer can run.
4. If the main state is bad and `<stateFile>.bak` is known-good state for the same pool, copy the
   backup to a new mode-`0600` file in the same directory, then atomically rename it over the main
   state. Keep the failed original. Expect to lose the latest committed transaction.
5. If no valid backup exists, revoke or fix any credential that must remain disabled, archive every
   state artifact, and let the extension create fresh state. This loses counters and health.
6. Run `/reload`, `/key-rotator doctor`, and `/key-rotator status`.

A same-directory restore, after all writers are stopped:

```bash
state="$HOME/.pi/agent/key-rotator-POOL_ID.state.json"
cp "$state" "$state.failed.$(date +%s)"
cp "$state.bak" "$state.recovered.tmp"
chmod 600 "$state.recovered.tmp"
mv "$state.recovered.tmp" "$state"
```

Validate the backup's `magic`, `version`, and `poolId` before using it. Never delete a lock based only
on age.

## 12. Known upstream limits

These boundaries are in Pi 0.84.2, pi-ai, or vendor SDKs:

- Adapter failure reporting is not uniform. Some OpenAI-compatible non-2xx responses, Anthropic
  HTTP-200 in-band errors, Google paths, and WebSocket paths can omit `onResponse`, status, or
  `Retry-After`. An unclassified failure cannot receive status-specific disable/cooldown behavior.
- Pi can classify final error text for agent-level retry after this wrapper exhausts its own budget.
  Disable `retry.enabled` for a strict whole-turn ceiling.
- A pi-ai adapter or SDK can log an error, response, header, or request **before** the wrapper sees and
  redacts its terminal event. This extension cannot scrub an already-written upstream log.
- Assistant `content` already exposed by incremental events is preserved in a later terminal. Model
  output is not retroactively rewritten or truncated.
- `maxRetries: 0` does not prove every nested SDK disabled retry. A nested loop can reuse a
  credential, so `totalAttempts` and `requestsPerKey` count selected attempts, not every call.
- Narrow text fallbacks are api-specific. Arbitrary numeric error text is not treated as HTTP status.
  A new adapter or Pi release needs a real-host test before its failure behavior is claimed.

Secure upstream logs. Keep provider debug logging off around credentials. Keep Pi provider retries at
zero and review the separate agent-level retry setting.

## 13. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| footer says `keys: disabled` | local config or startup failed; run `/key-rotator` for the captured load error |
| duplicate extension/provider registration | Pi 0.84.2 may merge a later registration instead of rejecting it; remove duplicate copies and do not treat `doctor` as proof of the winning stream |
| managed provider sends an unrotated fallback | the selected model api does not match the target api, or another registration won; stop and fix the provider/api contract |
| `No rotation entry is currently available (...)` | key, target, or pool scope is unavailable; inspect status |
| `Credential failover exhausted N attempt(s)` | wrapper budget ended or a target/pool circuit stopped selection; Pi may still have an outer retry |
| state corruption/security/size error | state failed closed; use recovery, not reset |
| state lock timeout | a live or ambiguous writer owns the lock, or contention exceeded `lockTimeoutMs`; confirm processes before cleanup |
| filesystem does not support atomic hard-link locks | move `stateFile` to a local hard-link-capable filesystem |
| `maxStateFileBytes must be at least N` | use at least the reported dynamic minimum |
| command source timed out/exceeded stdout/could not start | fix the trusted command; output is intentionally omitted from the error |
| a 401/429 was recorded as network/unknown | that adapter did not expose a supported status shape; check the pinned host limitations and integration tests |

## 14. How it hooks into Pi

Pi 0.84.2 composes an extension `streamSimple` per registered provider and calls it only when the
selected model's api equals the registration api. The package registers each configured target with
an inert fallback `rotator-managed-key`, then injects the selected real key into each attempt. It does not install a global per-api dispatcher.

The base attempt stream is `@earendil-works/pi-ai/compat` `streamSimple`. Matching raw,
URL-encoded, base64, and base64url credential forms in auth-like headers are rotated. Failure event
and outer retry details are host-specific; see [docs/PI_INTERNALS.md](docs/PI_INTERNALS.md).

| Pi | pi-ai | v0.4.0 status |
|---|---|---|
| `0.84.2` | `0.84.2` | verified target |

## 15. Development and release checks

```bash
npm ci --include=dev
npm run check
npm run test:coverage
npm run test:package
npm run test:host
```

The two Pi core packages are wildcard peers because Pi supplies them to installed extensions. The
lockfile pins exact development and contract-test copies to 0.84.2. CI also runs Ubuntu and Windows
on Node 22.19 and 24.

MIT licensed. See [LICENSE](LICENSE).
