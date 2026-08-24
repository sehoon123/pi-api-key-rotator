# Independent pools, shared pools, and target health

`<agent dir>/key-rotator.json` accepts one pool object or a top-level `pools[]` document. This guide
explains sharing boundaries in v0.4.0.
`<agent dir>` is `$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. Ready-to-copy
placeholders are the [shared IBM ICA example](../examples/key-rotator.ibm-ica.example.json) and the
[independent multi-pool example](../examples/key-rotator.multi-pool.example.json). Their provider ids
must already exist with matching `api` values in `<agent dir>/models.json`.

## 1. One pool with several targets

```json
{
  "configVersion": 1,
  "poolId": "ibm-ica-shared",
  "targets": [
    { "provider": "ibm-ica-claude", "api": "anthropic-messages" },
    { "provider": "ibm-ica", "api": "openai-completions" }
  ],
  "keys": [
    { "id": "ica-key-1", "value": "sk-REPLACE-ME-ICA-1" },
    { "id": "ica-key-2", "value": "sk-REPLACE-ME-ICA-2" }
  ],
  "requestsPerKey": 20,
  "rateLimitScope": "key",
  "targetFailureThreshold": 2
}
```

Shared across all targets:

- the key definitions and selected current key;
- `requestsPerKey` and total rotator-attempt counters;
- per-key attempts, success/failure counts, disabled flag, and key-scoped cooldown;
- pool-scoped cooldown and the state generation.

Separate for each provider target:

- total and consecutive transient/network failures;
- last ordered outcome and status/timestamps;
- target-circuit cooldown.

A `401/402/403` disables the selected credential for every target because authentication health is a
credential property. A transient `503` or network failure affects the target circuit, not key
availability. A `429` uses `rateLimitScope`.

Use a shared pool only when every credential is valid on every target and key/counter sharing is
intended.

## 2. Several independent pools

```json
{
  "configVersion": 1,
  "pools": [
    {
      "poolId": "ibm-ica-primary",
      "targets": [
        { "provider": "ibm-ica-claude", "api": "anthropic-messages" },
        { "provider": "ibm-ica", "api": "openai-completions" }
      ],
      "keys": [
        { "id": "primary-key-1", "value": "sk-REPLACE-ME-PRIMARY-1" },
        { "id": "primary-key-2", "value": "sk-REPLACE-ME-PRIMARY-2" }
      ],
      "rateLimitScope": "target"
    },
    {
      "poolId": "services-essentials",
      "provider": "services-openai",
      "api": "openai-completions",
      "keys": [
        { "id": "secondary-key-1", "value": "sk-REPLACE-ME-SECONDARY-1" },
        { "id": "secondary-key-2", "value": "sk-REPLACE-ME-SECONDARY-2" }
      ],
      "requestsPerKey": 10,
      "rateLimitScope": "key"
    }
  ]
}
```

Each entry has its own key set, policies, generation, target health, and state file. Nothing is
shared. Two pools may use the same `api` type because Pi composes a stream wrapper for each registered
provider. One provider id cannot belong to two pools.

## 3. Choosing a shape

| Question | Shared targets in one pool | Independent `pools[]` |
|---|---|---|
| Same credential valid everywhere? | required | not required |
| Share selection counter/current key? | yes | no |
| Share credential disable on `401`? | yes | no |
| Keep transient health per endpoint? | yes, target state is separate | yes, state is fully separate |
| Different `requestsPerKey` or key lists? | no | yes |
| State files | one | one per pool |

A document can mix a multi-target shared pool with single-target independent pools.

## 4. Rate-limit scope

Statuses in `cooldownStatuses` use one configured blast radius:

- `"key"` (default): cool the selected credential across every shared target. Other keys can
  continue on the same target.
- `"target"`: immediately open only the provider target circuit. Other targets in the shared pool
  can continue with the shared keys.
- `"pool"`: immediately cool every target and key selection in the pool.

The delay comes from a valid `Retry-After`, capped by `maxRetryAfterMs`; otherwise it is
`cooldownMs`. A target- or pool-scoped rate limit makes that scope unavailable immediately. The
current logical request therefore cannot bypass that provider/account limit merely by selecting
another key.

Some pi-ai adapters omit `onResponse`, status, or `Retry-After`. In that case status-specific scope
may be unavailable, and only `cooldownMs` is available when a rate limit was otherwise classified.

## 5. Target circuits

A retryable status that is neither a disable nor cooldown status, and every network failure, updates
the target health record. The selected key's failure counter also increases, but the credential is
not cooled or disabled.

- `targetFailureThreshold` defaults to `2` and allows 1-100.
- Before the threshold, same-request failover can select another distinct key.
- At the threshold, the target circuit opens for `transientCooldownMs`.
- Selection for that target stops while the circuit is open. Other targets in the pool remain usable.
- A newer success clears consecutive failures and closes the circuit.
- `lastOutcomeAttempt` prevents an older late failure from reopening a circuit after a newer success.
- `retryNetworkErrors: false` stops same-request network failover, but the forwarded network failure
  still updates target health.

This prevents a broken endpoint from consuming every credential as though it were a key problem.
With the defaults, two consecutive `503` responses can stop before the default three-attempt budget
uses a third key.

## 6. Loader rules

Validation completes before registration and, for physical path checks, before command-backed keys
run.

- `configVersion`, when present, is root-only and must be `1`.
- Top-level `pools` cannot coexist with any pool field.
- There are at most 128 pools, 128 targets per pool, and 256 keys per pool.
- Pool ids are unique case-insensitively.
- Provider ids are unique inside this rotator config, both within one pool and across independent
  pools. The loader cannot reject another Pi extension's later registration, so the runtime fence
  checks Pi's retained registration and latches a conflict until reload.
- Every pool needs at least two keys, with unique ids and resolved values.
- The config and every state, lock, reclaim, and backup artifact must have a unique lexical and
  physical location.
- Physical checks resolve symlinked ancestors and reliable existing inode/hard-link aliases. An inode
  value of `0` is treated as unavailable and falls back to canonical-path comparison.
- A custom `maxStateFileBytes` must meet the dynamic minimum for that pool.
- Across the document there can be at most 64 command keys and 600,000 ms of configured command
  timeout budget.

The JSON editor schema is [`key-rotator.schema.json`](key-rotator.schema.json). Runtime validation is
authoritative; do not put `$schema` in the config document.

## 7. State files and pool identity

The default is `<agent dir>/key-rotator-<poolId>.state.json`. `<agent dir>` is
`$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. Use a stable `poolId`. State v2 also
stores `poolId` and rejects a file belonging to another pool, even if a path is accidentally changed.
Renaming a pool changes the default path and state identity.

Each state directory must support hard links. The state sidecars are:

- `.lock`: atomically published owner record;
- `.lock.reclaim`: hard-link stale-removal claim;
- `.bak`: previous complete state version.

The backup is not an automatic rollback. See the [recovery runbook](../README.md#11-recovery).

## 8. Commands with several pools

```text
/key-rotator list
/key-rotator status
/key-rotator status ibm-ica-primary
/key-rotator doctor
/key-rotator next ibm-ica-primary
/key-rotator next all
/key-rotator reset all
```

Active-pool inference:

1. With one pool, it is active.
2. On `session_start` or `model_select`, the pool owning `model.provider` becomes active.
3. `status <poolId>`, `next <poolId>`, and `reset <poolId>` make that pool active.
4. A bare `next` or `reset` uses the active pool. If none can be inferred, it refuses rather than
   mutating an arbitrary pool.

The footer shows the active pool. Without one, it shows `N independent key pools`. `doctor` always
checks all pools and accepts no selector. It reads state and fixed lock evidence without creating a
lock or changing mtime, checks public Pi post-bind registration evidence, and sends no provider
request.
