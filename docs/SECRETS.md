# Secret handling

This document defines where credentials can exist in v0.4.0 and where the extension's redaction
boundary ends.

`<agent dir>` is `$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.

## 1. Source choices

| Source | Config entry | Benefits | Costs and limits |
|---|---|---|---|
| literal `value` | `{ "id": "k1", "value": "sk-REPLACE-ME-1" }` | simplest; reliable for GUI/daemon launches | plaintext at rest; easy to copy, back up, sync, or commit |
| `env` | `{ "id": "k1", "env": "MY_KEY_1" }` | config has only an environment name | process must inherit it; environment and shell files are still readable to the same user |
| external `command` | `{ "id": "k1", "command": "op read op://Private/ai/k1" }` | no raw secret in rotator config; can use an unlock policy | trusted shell execution and one process spawn per key at load |
| Pi `auth.json` | one value per provider | existing Pi credential store | cannot express this rotation pool; Pi can resolve it before stream composition, so mismatch/competing-registration paths must be fenced |

Recommended order is a trusted vault/keychain `command`, then `env`, then a literal `value`. All
resolved values stay in process memory for the extension lifetime. Packaged samples are linked from
the [README quick start](../README.md#5-quick-start), including the
[environment](../examples/key-rotator.env.example.json) and
[command](../examples/key-rotator.command.example.json) forms.

The provider registry never receives a configured pool secret. Every healthy registered target gets
the inert non-empty fallback `rotator-managed-key`; a target whose state preflight failed is not
registered and remains blocked by the managed request fence. The rotating stream replaces the
attempt `apiKey`. In headers, it also replaces raw, URI-encoded, base64, and base64url forms of the
previous or any configured pool credential with the same form of the selected credential.

For a model API mismatch or lost/changed registration, the Pi 0.84.2 fence synchronously aborts before
provider dispatch. Deleting auth-like headers is only defense in depth because credentials can appear
in a query string. This protects Pi-compliant pipelines, not trusted code that calls the network or
registry directly or ignores cancellation.

## 2. Command contract

```json
{
  "keys": [
    { "id": "key-1", "command": "op read op://Private/my-company-ai/key-1", "commandTimeoutMs": 10000 },
    { "id": "key-2", "command": "op read op://Private/my-company-ai/key-2" }
  ]
}
```

- Commands run once, sequentially, during load. `/reload` runs them again.
- Trimmed stdout is the secret. Exit code `0` is required. stderr is ignored.
- A command string is limited to 4,096 characters.
- `commandTimeoutMs` defaults to 10,000 and allows 100-120,000 ms.
- Across all pools, there can be at most 64 command keys and 600,000 ms of configured timeouts.
- Resolution has an aggregate 600,000 ms startup deadline even if an injected runner ignores its
  timeout.
- Captured stdout is capped at 132,096 UTF-8 bytes. The trimmed result must be well-formed Unicode and
  then has the normal cap: 65,536 UTF-16 code units and 131,072 UTF-8 bytes.
- Missing/empty output, duplicate resolved values, timeout, output overflow, nonzero exit, and spawn
  failure disable config loading without copying stdout, stderr, or rejection detail into the error.
- Public load APIs accept an `AbortSignal`. Cancellation fails loading without penalizing a key.

The string runs through a shell (`/bin/sh -c` on POSIX and the platform shell on Windows). Never
build it from untrusted data.

Timeout/cancellation closes stdout and requests process-tree termination. POSIX uses a detached
process group and negative-PID `SIGKILL`. Windows tries `taskkill /T /F`, then direct `SIGKILL`-style
termination through Node. This is best effort. A command can start a separately detached descendant
that survives. Secret tools can also write their own audit/debug logs outside this extension.

## 3. Config security checks

The config is capped at 1,048,576 bytes. On POSIX it must be a regular non-symlink file owned by the
effective user and must not be writable by group or other users. Metadata and open-file identity are
checked twice. Group/world readability emits a warning; use mode `0600`. Windows regular-file and
identity checks run, but ACL policy is not inspected.

Before a command starts, all config/state/lock/reclaim/backup paths are checked for lexical and
physical collisions. Symlinked ancestors and existing inode/hard-link aliases are resolved. A
collision fails loading before a vault command can expose a secret.

## 4. Redaction guarantees and boundary

For error terminal data that reaches the rotating wrapper:

- configured raw values and their first up-to-eight-character prefix are replaced with `[REDACTED]`;
- URI-encoded, JSON-escaped, base64, and base64url token forms are also replaced;
- strings at any cloned diagnostic depth are sanitized;
- cloning is capped by depth, object count, and per-container entry count, and cycles become
  `[Circular]`;
- displayed strings are capped, so an attacker-sized diagnostic cannot force unbounded work;

Other extension-owned protections:

- JSON parse errors retain only location information, not Node source excerpts.
- duplicate-secret errors name key ids, not values.
- missing environment errors name variables, not values.
- command errors name the key and safe category/exit code, not output.
- footer, status, list, and doctor never print resolved values or fingerprints.
- state never contains a raw secret, prompt, provider payload, or response body.

The boundary is important. A pi-ai adapter or vendor SDK can log a request, auth header, response, or
exception before emitting a stream terminal. This extension cannot redact a log that was already
written. A configured command and its secret tool can also log independently. Treat session/provider
logs as sensitive and keep debug logging off around credentials.

Pi 0.84.2 classifies some terminal error text for agent-level retry after the wrapper returns. That
classification is outside the redaction boundary and can start another logical request. If a strict
whole-turn attempt ceiling is required, set Pi `retry.enabled` to `false` until the pinned host
contract test proves a safe Pi-specific final-error mechanism.

## 5. State identity is not a raw secret

State v2 stores `credentialFingerprint`, the lowercase SHA-256 digest of each resolved credential,
and a rolling `configRevision`. These fields fence stale workers when a config replaces a secret
under the same key id. A selected attempt also carries that fingerprint in memory, and an outcome is
ignored if it no longer matches.

SHA-256 is deterministic. It can reveal that two observed states used the same credential, and a
low-entropy credential can be guessed offline. Protect state and `.bak` even though neither contains
the raw value. Public snapshots deliberately remove fingerprint and revision fields.

## 6. What is stored where

| Place | Content | Protection |
|---|---|---|
| `<agent dir>/key-rotator.json` | pool policy; literal values or env/command references | user-owned regular file; `0600` recommended |
| `<stateFile>` | v2 counters, health, target circuits, SHA-256 identity, config revision | strict read checks; mode `0600` on package writes |
| `<stateFile>.bak` | previous complete state inode/version | not automatic recovery; protect like state |
| `<stateFile>.lock` | JSON owner nonce, PID, acquisition time, optional Linux start marker | small regular safe-mode file; hard-link publication |
| `<stateFile>.lock.reclaim` | temporary hard-link stale-removal claim | compared by inode; fail-closed ambiguity |
| unique `.tmp` / `.candidate` files | synced state or lock candidates | mode `0600`; lock candidates cleaned only after valid owner metadata proves creator death |
| provider registry | only `rotator-managed-key` fallback | process memory |
| selected attempt | current raw credential | process memory and provider request |
| footer/status/doctor | ids, counters, health, local path/capability details | no raw value or fingerprint |
| upstream SDK/provider logs | outside wrapper control | may contain sensitive data; secure separately |

## 7. Leak response

1. Revoke the credential at the provider. File deletion is not revocation.
2. Stop processes that can still hold the old value.
3. Replace the vault/env/config value and `/reload`.
4. Run `/key-rotator doctor`, then reset the affected pool if needed.
5. Protect or remove logs, shell history, backups, and git history.

See [../SECURITY.md](../SECURITY.md) and the [README recovery runbook](../README.md#11-recovery).
