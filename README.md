# pi-api-key-rotator

하나의 API-key pool을 Pi의 하나 또는 여러 provider에 공유하는 TypeScript extension입니다.

Pi가 실제로 수행한 **provider 요청 횟수**를 기준으로 key를 회전합니다. 한 agent turn에서 tool call이 여러 번 발생하면 provider 요청도 여러 번 발생할 수 있으며, 각 요청이 rotation counter에 반영됩니다.

## 주요 기능

- 하나 또는 여러 Pi provider/API target 지원
- 여러 target이 동일한 key pool, counter, cooldown, disabled state를 공유
- 기존 단일 `provider`/`api` 설정과 하위 호환
- 환경변수 기반 key와 JSON에 직접 입력한 literal key 지원
- key 하나를 `requestsPerKey`회 사용한 뒤 다음 key로 순환
- `429` 발생 시 `Retry-After` 기반 cooldown 후 다음 key로 failover
- `401`, `402`, `403` 발생 시 해당 key를 비활성화하고 다음 key로 failover
- `408`, `409`, `425`, `5xx`, HTTP 응답 전 network failure에 제한적 failover
- SDK 내부 retry를 `0`으로 설정하고 extension이 key 단위 retry를 제어
- 여러 Pi process가 동일 state를 사용할 때 file lock과 atomic write 적용
- API key를 state, status, footer, error log에 기록하지 않음
- malformed JSON 및 validation error에서 literal key 노출 방지

## 설치

```bash
pi install git:github.com/sehoon123/pi-api-key-rotator
```

이미 설치했다면 다음 명령으로 갱신합니다.

```bash
pi update --extensions
```

설정 또는 package를 변경한 뒤 Pi를 다시 시작하거나 다음 명령을 실행합니다.

```text
/reload
```

요구 사항:

- Pi `0.84.2` 이상 권장
- Node.js `22.19.0` 이상
- `~/.pi/agent/models.json`에 등록된 API-key 기반 provider
- 서로 독립적으로 사용할 수 있는 API key 2개 이상

> 같은 account, project 또는 organization의 key들이 하나의 quota bucket을 공유한다면 key 개수만 늘려도 총 quota는 증가하지 않습니다. provider의 quota 정책을 먼저 확인하세요.

## IBM ICA: Claude와 OpenAI-compatible provider를 함께 사용

사용자가 제시한 `models.json`에는 다음 두 provider가 있습니다.

| Provider ID | API type | Endpoint |
|---|---|---|
| `ibm-ica-claude` | `anthropic-messages` | `https://api.nextgen-beta.ica.ibm.com/ica` |
| `ibm-ica` | `openai-completions` | `https://api.nextgen-beta.ica.ibm.com/ica/v1` |

기존 `models.json`의 model 목록과 endpoint는 그대로 유지합니다. 이 extension은 각 provider를 같은 ID로 감싸고 실제 요청의 `apiKey`만 shared pool에서 선택한 값으로 덮어씁니다.

`config.ibm-ica.example.json`을 다음 위치로 복사합니다.

Linux/macOS:

```bash
cp config.ibm-ica.example.json ~/.pi/agent/key-rotator.json
chmod 600 ~/.pi/agent/key-rotator.json
```

Windows PowerShell:

```powershell
Copy-Item .\config.ibm-ica.example.json "$HOME\.pi\agent\key-rotator.json"
```

설정 예시:

```json
{
  "poolId": "ibm-ica-shared",
  "targets": [
    {
      "provider": "ibm-ica-claude",
      "api": "anthropic-messages"
    },
    {
      "provider": "ibm-ica",
      "api": "openai-completions"
    }
  ],
  "keys": [
    { "id": "ica-key-1", "value": "REPLACE_WITH_ICA_API_KEY_1" },
    { "id": "ica-key-2", "value": "REPLACE_WITH_ICA_API_KEY_2" },
    { "id": "ica-key-3", "value": "REPLACE_WITH_ICA_API_KEY_3" }
  ],
  "requestsPerKey": 20,
  "maxAttemptsPerRequest": 3,
  "cooldownMs": 60000,
  "transientCooldownMs": 5000,
  "maxRetryAfterMs": 900000,
  "retryStatuses": [401, 402, 403, 408, 409, 425, 429, 500, 502, 503, 504],
  "disableStatuses": [401, 402, 403],
  "cooldownStatuses": [429],
  "retryNetworkErrors": true,
  "lockTimeoutMs": 5000,
  "staleLockMs": 30000
}
```

placeholder를 실제 key로 바꾼 뒤 Pi에서 확인합니다.

```text
/reload
/key-rotator status
```

### Shared pool의 의미

`requestsPerKey`가 `20`이면 두 provider의 요청 수를 합산합니다.

```text
key-1으로 Claude 요청 12회
key-1으로 GPT 요청     7회
key-1으로 Claude 요청  1회  ← 총 20회
다음 요청부터 key-2 사용
```

한 provider에서 key가 `401` 또는 `403`으로 실패하면 동일한 credential은 shared pool 전체에서 비활성화됩니다. `429` cooldown도 두 provider가 공유합니다. 같은 ICA credential이 두 endpoint에서 공통으로 유효하고 quota도 공유되는 환경에 적합합니다.

## 환경변수 방식

JSON에 평문 key를 넣지 않으려면 다음처럼 설정합니다.

```json
{
  "poolId": "ibm-ica-shared",
  "targets": [
    { "provider": "ibm-ica-claude", "api": "anthropic-messages" },
    { "provider": "ibm-ica", "api": "openai-completions" }
  ],
  "keys": [
    { "id": "ica-key-1", "env": "IBM_ICA_API_KEY_1" },
    { "id": "ica-key-2", "env": "IBM_ICA_API_KEY_2" },
    { "id": "ica-key-3", "env": "IBM_ICA_API_KEY_3" }
  ],
  "requestsPerKey": 20
}
```

Bash/Zsh:

```bash
export IBM_ICA_API_KEY_1="..."
export IBM_ICA_API_KEY_2="..."
export IBM_ICA_API_KEY_3="..."
```

PowerShell:

```powershell
$env:IBM_ICA_API_KEY_1 = "..."
$env:IBM_ICA_API_KEY_2 = "..."
$env:IBM_ICA_API_KEY_3 = "..."
```

각 key entry는 `env` 또는 `value` 중 **정확히 하나만** 가져야 합니다. 두 source를 같은 pool에서 혼합할 수도 있습니다.

## 기존 단일-provider 설정

기존 형식은 변경 없이 계속 지원합니다.

```json
{
  "provider": "my-company-ai",
  "api": "openai-completions",
  "keys": [
    { "id": "key-1", "env": "MY_API_KEY_1" },
    { "id": "key-2", "env": "MY_API_KEY_2" }
  ],
  "requestsPerKey": 20
}
```

다음 `targets` 형식과 동일한 의미입니다.

```json
{
  "targets": [
    { "provider": "my-company-ai", "api": "openai-completions" }
  ],
  "keys": [
    { "id": "key-1", "env": "MY_API_KEY_1" },
    { "id": "key-2", "env": "MY_API_KEY_2" }
  ]
}
```

`provider`/`api`와 `targets`를 동시에 지정하면 configuration error가 발생합니다. 동일한 provider ID를 `targets`에 두 번 등록하는 것도 차단합니다. Pi의 provider override는 provider ID 단위이므로 서로 다른 API adapter가 필요하면 `models.json`에서 각각 다른 provider ID를 사용해야 합니다.

## 명령

| 명령 | 설명 |
|---|---|
| `/key-rotator` | `status`와 동일 |
| `/key-rotator status` | pool, target 목록, key별 counter와 상태 표시 |
| `/key-rotator next` | 다음 사용 가능한 key로 수동 이동 |
| `/key-rotator reset` | counter, cooldown, disabled 상태 초기화 |

`reset`은 인증 실패로 비활성화된 key도 다시 활성화합니다. credential 문제를 수정한 뒤 사용하세요.

## 기본 실패 정책

| 상황 | 동작 |
|---|---|
| 정상 요청 | `requestsPerKey`회 실제 provider attempt 후 다음 key로 이동 |
| `429` | `Retry-After` 우선, 없으면 `cooldownMs` 적용 후 다음 key로 재시도 |
| `401`, `402`, `403` | 해당 key를 shared pool 전체에서 disabled 처리 |
| `408`, `409`, `425`, `5xx` | `transientCooldownMs` 적용 후 다음 key로 제한적 재시도 |
| HTTP 응답 전 network failure | 설정 시 짧은 cooldown 후 다음 key로 재시도 |
| 정상 response stream이 시작된 뒤 오류 | 중복 tool/output 방지를 위해 failover하지 않음 |
| 모든 key 실패 | secret을 제거한 terminal error 반환 |

OpenAI/Anthropic SDK가 자체 retry를 먼저 수행하면 동일한 key가 반복 사용되고 extension이 다른 key를 선택할 기회를 잃습니다. 따라서 각 물리적 시도에서는 `maxRetries: 0`을 사용하고 retry 여부와 다음 key 선택은 extension이 제어합니다.

## Config reference

| 필드 | 기본값 | 설명 |
|---|---:|---|
| `poolId` | 첫 target의 provider ID | 기본 state-file 이름에 사용할 안정적인 pool ID |
| `targets` | multi-target에서 필수 | `{ provider, api }` 목록. 모든 target이 하나의 pool 공유 |
| `provider` | legacy 형식에서 필수 | 단일 target의 provider ID |
| `api` | legacy 형식에서 필수 | 단일 target의 Pi API type |
| `keys` | 필수 | `{ id, env }` 또는 `{ id, value }` 목록, 최소 2개 |
| `requestsPerKey` | `20` | 다음 key로 이동하기 전 합산 provider attempt 수 |
| `maxAttemptsPerRequest` | key 개수 | 하나의 논리 요청에서 시도할 최대 key 수 |
| `cooldownMs` | `60000` | `429`에 `Retry-After`가 없을 때 cooldown |
| `transientCooldownMs` | `5000` | network/5xx 계열 실패의 짧은 cooldown |
| `maxRetryAfterMs` | `900000` | `Retry-After` 적용 상한. `0`이면 상한 없음 |
| `retryNetworkErrors` | `true` | HTTP response 전 오류에서 failover할지 여부 |
| `stateFile` | poolId 기반 자동 경로 | shared rotation state JSON 위치 |
| `lockTimeoutMs` | `5000` | state lock 획득 제한 시간 |
| `staleLockMs` | `30000` | 비정상 종료 후 lock을 stale로 판단하는 시간 |

`disableStatuses`와 `cooldownStatuses`의 모든 값은 `retryStatuses`에도 포함되어야 합니다.

## State와 보안

기본 state 파일은 다음과 같습니다.

```text
~/.pi/agent/key-rotator-<poolId>.state.json
```

state에는 current key ID, attempt/success/failure counter, disabled 여부, cooldown 종료 시각과 마지막 HTTP status만 저장됩니다. API key 원문, request/response body, prompt, model output은 저장하지 않습니다.

`value` 방식은 key를 `key-rotator.json`에 평문으로 저장합니다. Linux/macOS에서는 다음 권한을 권장합니다.

```bash
chmod 600 ~/.pi/agent/key-rotator.json
```

실제 credential 파일을 Git repository에 commit하지 마세요. `.gitignore`는 일반적인 local config 이름을 차단하지만 이름이 다른 파일은 Git이 추적할 수 있습니다. 실제 key를 한 번이라도 commit했다면 파일 삭제만으로 해결되지 않으므로 key를 revoke하고 새 key로 교체해야 합니다.

## 개발과 검증

```bash
npm install
npm run check
```

테스트는 legacy 설정 호환성, multi-target registration, shared rotation counter, literal/env/mixed key, `$`/`!` escaping, duplicate target 및 secret validation, `429`/`401`/`5xx`/network failover, stream 시작 후 중복 retry 방지, concurrent state update와 atomic write를 검증합니다.

## License

MIT
