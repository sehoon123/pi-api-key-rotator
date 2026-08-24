# Security policy

## Supported versions

| Version | Supported host | Status |
|---|---|---|
| `0.4.x` | Pi `0.84.2`, Node.js `>=22.19.0` | supported |
| `0.1.x`-`0.3.x` | earlier behavior | upgrade required |

The Pi `0.84.2` qualifier matters. v0.4.x depends on provider composition, stream events, adapter
callbacks, and error classification in that host. A later Pi version is not automatically covered.

## Reporting a vulnerability

Report privately with a GitHub security advisory:
<https://github.com/sehoon123/pi-api-key-rotator/security/advisories/new>. You can also contact the
repository owner directly. Do not open a public issue for a vulnerability.

Never paste a real key, config, state file, command output, or provider log into a report. Use values
such as `sk-REPLACE-ME-1`. Include the package, Pi, pi-ai, Node, and operating-system
versions; the config shape without values; the filesystem type used for state; and sanitized error
text.

## Threat model

This extension holds credentials for the current OS user. It is not a process sandbox or secret
isolation boundary.

- A malicious process running as the same user can normally read process memory, environment values,
  literal config, or vault command output and can replace files in user-writable directories.
- A malicious configured `command`, provider, SDK, extension, or Pi build is out of scope.
- Provider quota correctness and account-level isolation are out of scope.
- Windows ACL validation is not available through the checks implemented here.

The package reduces accidental disclosure and unsafe state reuse. It does not promise to hide a key
from software that must use that key.

## Config and path hardening

The default `<agent dir>` is `$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. An explicit
loader path and `PI_KEY_ROTATOR_CONFIG` take precedence for config selection.

On POSIX, config loading refuses:

- a symlink, directory, or special file;
- a file not owned by the effective user;
- a file writable by group or other users;
- a file over 1,048,576 bytes or one that is not valid UTF-8;
- a file whose identity, owner, or mode changes between metadata inspection and open.

A group/world-readable config is allowed with a warning so existing read-only deployments can be
fixed, but `chmod 600` is strongly recommended. Windows checks regular-file identity and size but
cannot inspect ACL policy.

Before any command-backed key runs, the loader compares the config and every pool's state, `.lock`,
`.lock.reclaim`, and `.bak` path. It checks both strict lexical paths and physical paths after
resolving symlinked ancestors and existing reliable inode/hard-link aliases. Filesystems that report
inode `0` use canonical paths only, avoiding false collisions while losing hard-link alias detection.
A collision disables loading. This prevents a configured state sidecar from targeting the config or another pool through a path
alias.

Use a private local directory owned by the same user. The physical collision check is a point-in-time
validation, not protection from a same-user attacker changing directory entries later.

## State identity and confidentiality

State v2 never stores a raw key. It stores per-key `credentialFingerprint = SHA-256(secret)` and a
rolling config revision. The fingerprint lets a newer config fence an older worker or in-flight
outcome when a secret changes under the same key id. Reset increments state `generation`; each
selection captures that generation as its epoch, so pre-reset completions are ignored.

SHA-256 here is an identity check, not encryption or a password hash. A low-entropy secret can be
subject to offline guessing. State and backups should still be private. Public status snapshots omit
the fingerprint and config revision.

The wrapper redacts configured secrets, caller API keys, and values from auth-like request headers.
It detects bounded raw prefixes, URI/JSON-escaped forms, base64, and base64url forms in outgoing
error terminal data. After any match, it discards the rest of that string leaf so a credential suffix
cannot survive prefix redaction; this can intentionally remove trailing provider diagnostic text.
Assistant `content` and protocol identity/usage fields are preserved verbatim because the same content
may already have been streamed. They are not treated as error details or retroactively redacted. It bounds recursive diagnostic
cloning. This guarantee starts only when data reaches the wrapper. A pi-ai adapter or vendor SDK can
log requests, headers, or errors before then. Secure upstream logs and avoid provider debug logging
around credentials.

## State, lock, and backup safety

State reads fail closed on malformed JSON or UTF-8, invalid fields, wrong magic/version/pool, oversize,
unsafe file type/owner/write mode, symlinks, or repeated identity races. Read-only snapshots retry one
identity change caused by a concurrent atomic replacement; mutations under the lock do not retry. Such a file is not replaced with initial
state. Only `ENOENT` creates a fresh in-memory state.

State commits use a mode-`0600`, synced candidate and atomic rename. Before replacement, the previous
complete state inode is hard-linked and published as `<stateFile>.bak`. The backup is normally one
version behind and is not restored automatically. If safe replacement is refused, the older
known-good backup is retained and can lag further.

Mutations use a synced lock candidate published atomically through a hard link. The fixed lock
contains nonce, PID, timestamp, and a Linux process-start marker when available. Stale removal uses a
creator-owned hard-link claim at `.lock.reclaim`. Correct processes never delete a pre-existing claim:
Node exposes no portable pathname compare-and-delete primitive, and deleting a reused claim path can
let two reapers delete a newer live lock. New owners wait for claim absence and revalidate their lock
before mutation. A claimant crash therefore fails closed and needs manual recovery. A lock is not
stolen from a live PID based on age alone. If hard links are unsupported, mutation fails instead of
using a weaker lock. Malformed lock metadata also fails closed; only valid metadata with a proven-dead
owner is eligible for automatic stale recovery. Pre-publication lock candidates use the same liveness
rule for cleanup: an old mtime alone never permits deleting a candidate whose creator may still link it.

Never delete `.lock` or `.lock.reclaim` merely because it looks old. Stop all possible writers,
confirm owner death, preserve both paths, and archive stale sidecars together. See
[README recovery](README.md#11-recovery) and [CHANGELOG.md](CHANGELOG.md#recovery-runbook). The
creator-only claim invariant requires cooperating peers on this final protocol; stop every older
writer before upgrading instead of mixing lock implementations.

## Command-backed key safety

A command source executes trusted shell text once at load and keeps trimmed stdout in memory.

- Shell text is limited to 4,096 characters.
- Each timeout is 100-120,000 ms; default 10,000 ms.
- At most 64 command keys and 600,000 ms of configured timeout budget are allowed per document.
- Resolution has a separate aggregate 600,000 ms startup deadline.
- Captured stdout is limited to 132,096 bytes and then must satisfy the 131,072-byte secret limit.
- stderr and rejected-command details are discarded by the extension.
- Timeout/cancellation tries to kill the POSIX process group or Windows process tree, but detached
  descendants can escape. Process-tree cleanup is best effort.

Do not build a command from prompt text, repository content, file names supplied by another user, or
model output. The command itself and the secret tool can write their own logs; this package cannot
prevent that.

## Hardening checklist

- Pin `@v0.4.0` and review every update.
- Use Pi `0.84.2` and Node.js `>=22.19.0` for the verified contract.
- Keep config, state, backup, and recovery copies outside repositories and at mode `0600`.
- Prefer a trusted vault/keychain `command`, then `env`, over a literal `value`.
- Give each pool a stable unique `poolId` and state path on a local hard-link-capable filesystem.
- Run `/key-rotator doctor` after install, config changes, and recovery.
- Keep exactly one installed copy. Remove any old vendored extension before loading the package.
- Review [docs/PI_INTERNALS.md](docs/PI_INTERNALS.md) and rerun the real-host contract tests for any
  host upgrade.
- If a strict whole-turn retry ceiling is required, set Pi `retry.enabled` to `false`; Pi 0.84.2 can
  classify final provider-like error text for a new agent-level retry outside this wrapper.

## If a key leaks

1. Revoke or rotate the key at the provider first.
2. Stop old workers that may still hold it in memory.
3. Replace the config/env/vault value. Prefer a new key id when operationally practical.
4. Run `/reload`, `/key-rotator doctor`, and `/key-rotator reset <poolId>`.
5. Remove or protect upstream logs, backups, shell history, and git history, but do not treat deletion
   as revocation.
6. Inspect state counters if useful. State has no raw secret, but it has a SHA-256 identity and should
   remain private.
