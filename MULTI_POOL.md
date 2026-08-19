# Independent endpoint pools

`pi-api-key-rotator` can run multiple, completely independent API-key rotation pools from one `key-rotator.json`.

Use this when two endpoints have different credentials or different quota buckets, for example:

```text
https://api.nextgen-beta.ica.ibm.com/ica/v1  -> primary pool -> primary keys
https://api2.new.ica.com/v1                  -> second pool  -> second keys
```

Each pool owns its own:

- API keys
- current key and request counter
- `requestsPerKey` policy
- `401`/`403` disabled state
- `429` cooldown and `Retry-After`
- transient network/5xx cooldown
- state file and lock file

A failure or rotation in one pool never changes another pool.

## 1. Give each endpoint a unique Pi provider ID

The extension routes by Pi `provider` ID. Define every endpoint separately in `~/.pi/agent/models.json`.

```json
{
  "providers": {
    "ibm-ica": {
      "name": "IBM ICA Primary",
      "baseUrl": "https://api.nextgen-beta.ica.ibm.com/ica/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "gpt-5.5-gus",
          "name": "GPT-5.5 (ICA Primary)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1050000,
          "maxTokens": 128000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    },
    "ibm-ica-secondary": {
      "name": "IBM ICA Secondary",
      "baseUrl": "https://api2.new.ica.com/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "gpt-5.5-gus",
          "name": "GPT-5.5 (ICA Secondary)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1050000,
          "maxTokens": 128000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

The model IDs may be the same because they live under different providers. The provider IDs must be different.

## 2. Define one pool per credential/quota boundary

Copy `config.multi-pool.example.json` to `~/.pi/agent/key-rotator.json` and replace the placeholders:

```json
{
  "pools": [
    {
      "poolId": "ibm-ica-primary",
      "targets": [
        { "provider": "ibm-ica-claude", "api": "anthropic-messages" },
        { "provider": "ibm-ica", "api": "openai-completions" }
      ],
      "keys": [
        { "id": "primary-key-1", "value": "PRIMARY_API_KEY_1" },
        { "id": "primary-key-2", "value": "PRIMARY_API_KEY_2" },
        { "id": "primary-key-3", "value": "PRIMARY_API_KEY_3" }
      ],
      "requestsPerKey": 20
    },
    {
      "poolId": "ibm-ica-secondary",
      "provider": "ibm-ica-secondary",
      "api": "openai-completions",
      "keys": [
        { "id": "secondary-key-1", "value": "SECONDARY_API_KEY_1" },
        { "id": "secondary-key-2", "value": "SECONDARY_API_KEY_2" }
      ],
      "requestsPerKey": 10
    }
  ]
}
```

Inside one pool, `targets` intentionally share the same keys and state. In the example above, `ibm-ica-claude` and `ibm-ica` share the primary ICA credentials. The secondary provider belongs to a different pool and uses only the secondary keys.

Environment-backed keys are also supported:

```json
{
  "id": "secondary-key-1",
  "env": "SECONDARY_ICA_API_KEY_1"
}
```

Each key entry must contain exactly one of `value` or `env`.

## Rotation example

With `requestsPerKey: 20` in the primary pool and `requestsPerKey: 10` in the secondary pool:

```text
primary request 1..20  -> primary-key-1
primary request 21     -> primary-key-2

secondary request 1..10 -> secondary-key-1
secondary request 11    -> secondary-key-2
```

Primary requests do not increment the secondary counter, and secondary requests do not increment the primary counter.

If `primary-key-1` receives `401`, only `primary-key-1` is disabled. `secondary-key-1` remains available. Likewise, a `429` cooldown is scoped to the pool that owns the key.

## Commands

```text
/key-rotator list
/key-rotator status
/key-rotator status ibm-ica-primary
/key-rotator next ibm-ica-primary
/key-rotator next all
/key-rotator reset ibm-ica-secondary
/key-rotator reset all
```

When multiple pools exist, bare `next` or `reset` acts on the currently selected model's pool. If no active pool can be inferred, the command requires a `poolId` or `all` to prevent changing the wrong endpoint.

## State files

Unless `stateFile` is explicitly set, each pool uses:

```text
~/.pi/agent/key-rotator-<poolId>.state.json
```

The loader rejects duplicate pool IDs, providers assigned to multiple independent pools, and state-file collisions before registering any provider. This prevents two pools from accidentally sharing or corrupting runtime state.

## Upgrade

Existing single-pool and shared-target configurations remain valid. To update an installed package:

```bash
pi update --extensions
```

Then restart Pi or run:

```text
/reload
/key-rotator status
```

When literal `value` keys are used, protect the local configuration file:

```bash
chmod 600 ~/.pi/agent/key-rotator.json
```

Never commit a real key. If a key has entered Git history, revoke and replace it rather than only deleting the file.
