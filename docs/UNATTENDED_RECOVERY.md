# Unattended recovery

Long-running sessions can encounter a transient server failure after the rotator's
same-request credential budget has ended. By default the rotator finalizes that
failure with a retry-neutral message. This protects the wrapper's attempt boundary,
but also prevents Pi's separate agent-level retry from recovering the request.

## Opt in explicitly

Add these fields to the relevant pool in `key-rotator.json`:

```json
{
  "retryTransientAtAgentLevel": true,
  "maxCooldownWaitMs": 900000
}
```

- `retryTransientAtAgentLevel` defaults to `false`. With it enabled, a transient
  failure before semantic output receives a fixed, sanitized retryable marker.
  Pi applies its own configured retry budget and backoff. The raw provider cause
  stays in bounded, redacted diagnostics rather than the retry marker.
- `maxCooldownWaitMs` defaults to `0`; its range is 0-900,000 ms. A positive value
  requires `retryTransientAtAgentLevel: true`. It is the **cumulative wait budget
  for one wrapper invocation**, not a timeout for the entire goal or session.

A fresh wrapper can wait for healthy-key, target, or pool cooldowns before selecting
its first credential. It sends no provider request, consumes no credential attempt,
and holds no state lock while asleep. It re-reads shared state after waking because
another session may have extended the cooldown. Keys already attempted within that
wrapper are not recycled, and a delay that exceeds the remaining wait budget stops
safely instead of retrying early.

Existing disabled credentials and budget cooldowns are not reset. If every
credential is disabled, the new waiting policy does not wait for or revive them;
the existing bounded last-resort recheck policy is unchanged.

## Configure Pi's outer retry too

For the targeted Pi **1.4.0** host, a settings example is:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 10,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000,
    "provider": {
      "maxRetries": 0
    }
  }
}
```

Check the supported setting names before using an older host. Keep provider-level
retries at zero so hidden SDK retries do not delay the rotator's decisions.

The nominal delay sequence above is 2, 4, 8, 16, 32, 60, 60, 60, 60, and 60 seconds:
362 seconds of backoff, **excluding provider calls and rotator waits**. A very small
base delay burns through retry opportunities quickly; the delay sum alone does not
prove that a classifier actually selected retry, nor does it bound total runtime.

This is not an infinite retry policy or a strict physical-call ceiling. Each of
Pi's initial call and outer retries can consume the wrapper's credential budget.
Concurrent sessions have independent outer budgets but share durable circuits.
For a strict whole-turn ceiling, disable Pi's outer retry instead. See the
[host contract](PI_INTERNALS.md#7-pi-agent-level-retry-is-a-separate-budget).

## Classification and Retry-After

Bounded Anthropic HTTP-200 in-band `api_error` and `internal_server_error` envelopes
are classified as HTTP 500, rather than an HTTP-200 success or an unknown network
failure. An observed non-2xx HTTP response remains authoritative.

A transient HTTP response with `Retry-After`, including HTTP 503, opens its target
circuit immediately instead of sending another credential into the same unavailable
backend. The existing `maxRetryAfterMs` parsing cap still applies. Other transient
failures continue to use `targetFailureThreshold` and `transientCooldownMs`.

## Safety boundaries

The outer retry opt-in does not make these failures retryable:

- authentication/permission failures (401/402/403), deterministic bad requests,
  explicit budget exhaustion, or the running host's quota/billing veto;
- user cancellation or errors in caller payload/response callbacks;
- local state, lock, security, API mismatch, or registration-fence failures;
- errors after visible text, thinking, tool-call content, or an unknown semantic
  stream event. Content present only in an error terminal is checked too.

Visible output is never replayed. Permanent outages, exhausted budgets, overly
long cooldowns, or spent retry budgets can still end a run. Provider access controls,
quotas, budgets, and model/billing routes are not bypassed or relaxed.

Recoverable final failures are reported as warnings. Use `/key-rotator errors` for
the sanitized cause, and `/key-rotator doctor` / `status` for read-only local checks.
Reload existing sessions after configuration or extension changes.

## Verification

The targeted suite uses an installed Pi **1.4.0** host:

```sh
export PI_ROTATOR_HOST_ROOT=/absolute/path/to/pi-coding-agent
npm run test:local
npm run test:reliability
```

`test:local` uses a test-only peer resolver; it does not install or bundle another
Pi core. The integration suite loads the real package entry through Pi's extension
loader using temporary agent directories, fake credentials, and a 127.0.0.1 HTTP
server. It covers transient 503 and Anthropic in-band recovery, throttled-key and
target cooldowns, bounded retry exhaustion, cancellation, partial-output safety,
auth/quota termination, redaction, and zero dispatch on API mismatch.

These are targeted recovery checks, not a replacement for the full pinned-host
compatibility contract or its upgrade checklist.
