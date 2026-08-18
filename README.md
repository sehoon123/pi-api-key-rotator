# pi-api-key-rotator

하나의 LLM endpoint에 여러 API key를 순차적으로 적용하는 **Pi extension**입니다.

사용자 prompt 수가 아니라 Pi가 실제로 수행한 **provider 요청 횟수**를 기준으로 key를 회전합니다. 한 agent turn 안에서 tool call이 여러 번 일어나면 provider 요청도 여러 번 발생할 수 있으며, 각각 rotation counter에 반영됩니다.

## 주요 기능

- 동일한 provider/endpoint에 여러 API key 적용
- key 하나를 `requestsPerKey`회 사용한 뒤 다음 key로 순환
- 환경변수 기반 key와 JSON에 직접 입력한 key를 모두 지원
- 두 key source를 하나의 pool에서 혼합 가능
- `429` 응답 시 `Retry-After` 기반 cooldown 후 다음 key로 failover
- `401`, `402`, `403` 응답 시 해당 key를 비활성화하고 다음 key로 failover
- `408`, `409`, `425`, `5xx`, HTTP 응답 전 network failure에 제한적 failover
- SDK 내부 retry를 비활성화하고 extension이 key 단위 retry를 제어
- 여러 Pi 프로세스가 동일 state를 사용할 때 file lock과 atomic write 적용
- API key를 state, status, footer, log에 기록하지 않음
- config parse 및 validation 오류에서 secret 문자열을 노출하지 않음
- `/key-rotator status`, `/key-rotator next`, `/key-rotator reset` 명령 제공

## 동작 구조

```text
Pi agent
   │
   │ provider request
   ▼
pi-api-key-rotator
   │
   ├─ key-1: N attempts ───────────────┐
   ├─ key-2: N attempts                │ round-robin
   └─ key-3: N attempts ◀──────────────┘
   │
   ▼
single provider endpoint
```

기본 실패 정책은 다음과 같습니다.

```text
key-1로 요청
   │
   ├─ 정상 응답 ───────── 응답 stream 전달
   │
   ├─ 429 ─────────────── Retry-After/cooldown 적용
   │                         └─ key-2로 같은 논리 요청 재시도
   │
   ├─ 401/402/403 ─────── key-1 disabled
   │                         └─ key-2로 같은 논리 요청 재시도
   │
   └─ 5xx/network ─────── 짧은 cooldown
                             └─ key-2로 제한적 재시도
```

이미 정상 response body가 Pi에 전달되기 시작한 뒤 발생한 오류는 다른 key로 재시도하지 않습니다. 이 시점에 재요청하면 tool call이나 출력이 중복될 수 있기 때문입니다.

## 요구 사항

- Pi `0.84.2` 이상 권장
- Node.js `22.19.0` 이상
- `~/.pi/agent/models.json`에 등록된 API-key 기반 custom provider
- 서로 독립적으로 사용할 수 있는 API key 2개 이상

> 같은 account, project 또는 organization에 속한 key들이 하나의 quota bucket을 공유한다면 key 개수만 늘려도 총 quota는 증가하지 않습니다. provider의 quota 단위를 먼저 확인하세요.

## 설치

GitHub에서 설치:

```bash
pi install git:github.com/sehoon123/pi-api-key-rotator
```

로컬 checkout으로 시험:

```bash
pi -e /absolute/path/to/pi-api-key-rotator
```

로컬 package로 등록:

```bash
pi install /absolute/path/to/pi-api-key-rotator
```

업데이트 후에는 Pi를 재시작하거나 다음 명령을 실행합니다.

```text
/reload
```

## 빠른 설정

### 1. 기존 provider 확인

이 extension은 endpoint와 model을 새로 만들지 않습니다. 기존 `~/.pi/agent/models.json`의 provider를 같은 ID로 감싸고, provider request의 `apiKey`만 key pool에서 선택한 값으로 덮어씁니다.

예시:

```json
{
  "providers": {
    "my-company-ai": {
      "baseUrl": "https://ai.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_COMPANY_API_KEY_1",
      "models": [
        {
          "id": "company-model",
          "name": "Company Model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

위 예시에서 extension 설정과 일치해야 하는 값은 다음 두 개입니다.

```text
provider ID = my-company-ai
API type    = openai-completions
```

`models.json`의 `apiKey`는 Pi가 provider를 사용 가능한 상태로 인식하기 위한 fallback auth입니다. Extension이 활성화된 요청에서는 key pool에서 선택한 값이 실제 `apiKey`로 사용됩니다.

### 2. Rotation config 생성

기본 위치:

- Linux/macOS: `~/.pi/agent/key-rotator.json`
- Windows: `%USERPROFILE%\.pi\agent\key-rotator.json`

다른 위치를 사용하려면 Pi 실행 전에 `PI_KEY_ROTATOR_CONFIG`를 설정합니다.

```bash
export PI_KEY_ROTATOR_CONFIG=/secure/path/key-rotator.json
```

```powershell
$env:PI_KEY_ROTATOR_CONFIG = "C:\secure\key-rotator.json"
```

## 방식 A: API key를 JSON에 직접 입력

`config.literal.example.json`을 참고하세요.

```json
{
  "provider": "my-company-ai",
  "api": "openai-completions",
  "keys": [
    { "id": "key-1", "value": "YOUR_API_KEY_1" },
    { "id": "key-2", "value": "YOUR_API_KEY_2" },
    { "id": "key-3", "value": "YOUR_API_KEY_3" }
  ],
  "requestsPerKey": 20
}
```

이 방식은 설정이 간단하지만 key가 파일에 **평문으로 저장**됩니다. 개인 장비에서 사용할 수는 있으나 파일 권한과 Git 추적 여부를 반드시 확인해야 합니다.

Linux/macOS:

```bash
chmod 600 ~/.pi/agent/key-rotator.json
```

확인:

```bash
stat -c '%a %n' ~/.pi/agent/key-rotator.json
```

macOS에서는 다음도 사용할 수 있습니다.

```bash
stat -f '%Lp %N' ~/.pi/agent/key-rotator.json
```

Windows PowerShell에서는 상속 권한을 제거하고 현재 사용자만 읽을 수 있게 제한할 수 있습니다.

```powershell
$config = "$env:USERPROFILE\.pi\agent\key-rotator.json"
icacls $config /inheritance:r
icacls $config /grant:r "$env:USERNAME:(R,W)"
```

`value`는 extension 자체가 읽는 literal 문자열입니다. 다음 값은 환경변수 참조로 확장되지 않고 그대로 API key가 됩니다.

```json
{ "id": "key-1", "value": "$NOT_AN_ENV_REFERENCE" }
```

## 방식 B: 환경변수에서 API key 읽기

`config.example.json`을 참고하세요.

```json
{
  "provider": "my-company-ai",
  "api": "openai-completions",
  "keys": [
    { "id": "key-1", "env": "MY_COMPANY_API_KEY_1" },
    { "id": "key-2", "env": "MY_COMPANY_API_KEY_2" },
    { "id": "key-3", "env": "MY_COMPANY_API_KEY_3" }
  ],
  "requestsPerKey": 20
}
```

Bash/Zsh:

```bash
export MY_COMPANY_API_KEY_1="YOUR_API_KEY_1"
export MY_COMPANY_API_KEY_2="YOUR_API_KEY_2"
export MY_COMPANY_API_KEY_3="YOUR_API_KEY_3"
```

PowerShell 현재 세션:

```powershell
$env:MY_COMPANY_API_KEY_1 = "YOUR_API_KEY_1"
$env:MY_COMPANY_API_KEY_2 = "YOUR_API_KEY_2"
$env:MY_COMPANY_API_KEY_3 = "YOUR_API_KEY_3"
```

Windows 사용자 환경변수로 저장:

```powershell
setx MY_COMPANY_API_KEY_1 "YOUR_API_KEY_1"
setx MY_COMPANY_API_KEY_2 "YOUR_API_KEY_2"
setx MY_COMPANY_API_KEY_3 "YOUR_API_KEY_3"
```

`setx` 실행 후에는 새 terminal에서 Pi를 실행해야 합니다.

## 방식 C: 두 source 혼합

각 key entry는 `env` 또는 `value` 중 **정확히 하나만** 가져야 합니다. Pool 안에서 두 방식을 섞는 것은 허용됩니다.

```json
{
  "provider": "my-company-ai",
  "api": "openai-completions",
  "keys": [
    { "id": "personal", "value": "YOUR_PERSONAL_API_KEY" },
    { "id": "team-1", "env": "TEAM_API_KEY_1" },
    { "id": "team-2", "env": "TEAM_API_KEY_2" }
  ],
  "requestsPerKey": 20
}
```

다음 형태는 설정 오류입니다.

```json
{
  "id": "invalid",
  "env": "API_KEY",
  "value": "YOUR_API_KEY"
}
```

Secret 값이 동일한 entry를 여러 개 등록하는 것도 오류로 처리합니다. 같은 key가 서로 다른 이름으로 중복 등록되면 rotation이 실제 quota를 분산하지 못하고 상태만 왜곡하기 때문입니다.

## 전체 설정 예시

```json
{
  "provider": "my-company-ai",
  "api": "openai-completions",
  "keys": [
    { "id": "key-1", "value": "YOUR_API_KEY_1" },
    { "id": "key-2", "value": "YOUR_API_KEY_2" },
    { "id": "key-3", "value": "YOUR_API_KEY_3" }
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

## Config reference

| 필드 | 기본값 | 설명 |
|---|---:|---|
| `provider` | 필수 | `models.json`에 등록된 provider ID |
| `api` | 필수 | 대상 model이 사용하는 Pi API type |
| `keys` | 필수 | 최소 2개. 각 entry는 `{id, env}` 또는 `{id, value}` 중 하나 |
| `requestsPerKey` | `20` | 다음 key로 넘어가기 전 실제 provider attempt 수 |
| `maxAttemptsPerRequest` | key 개수 | 하나의 논리 요청에서 시도할 최대 key 수 |
| `cooldownMs` | `60000` | `429`에 `Retry-After`가 없을 때 cooldown |
| `transientCooldownMs` | `5000` | network/5xx 계열 실패의 짧은 cooldown |
| `maxRetryAfterMs` | `900000` | `Retry-After` 적용 상한. `0`이면 상한 없음 |
| `retryStatuses` | 예시 참조 | 다음 key로 failover할 HTTP status |
| `disableStatuses` | `401,402,403` | 수동 reset 전까지 key를 비활성화할 status |
| `cooldownStatuses` | `429` | `Retry-After` 또는 `cooldownMs`를 적용할 status |
| `retryNetworkErrors` | `true` | HTTP 응답 전 오류에서 다음 key 사용 여부 |
| `stateFile` | provider별 자동 경로 | rotation state JSON 위치 |
| `lockTimeoutMs` | `5000` | state lock 획득 제한 시간 |
| `staleLockMs` | `30000` | 남은 lock을 stale로 판단하는 시간 |

`disableStatuses`와 `cooldownStatuses`의 값은 반드시 `retryStatuses`에도 포함되어야 합니다.

## 실행

Pi를 다시 시작하거나 다음 명령을 실행합니다.

```text
/reload
```

대상 model 선택:

```text
/model
```

상태 확인:

```text
/key-rotator status
```

## 명령

| 명령 | 설명 |
|---|---|
| `/key-rotator` | 현재 pool 상태 표시 |
| `/key-rotator status` | current key, counter, cooldown/disabled 상태 표시 |
| `/key-rotator next` | 다음 사용 가능한 key로 수동 이동 |
| `/key-rotator reset` | disabled/cooldown 상태와 counter 초기화 |

Literal key는 상태 화면에서 `<literal>`로 표시됩니다. 실제 value는 표시되지 않습니다.

## Rotation 및 failover 정책

| 상황 | 기본 동작 |
|---|---|
| 정상 요청 | 한 key로 20회 provider attempt 후 다음 key로 이동 |
| `429` | `Retry-After` 우선, 없으면 60초 cooldown 후 다른 key 사용 |
| `401`, `402`, `403` | 해당 key disabled 후 다른 key 사용 |
| `408`, `409`, `425`, `5xx` | 5초 cooldown 후 다른 key 사용 |
| HTTP 응답 전 network failure | 5초 cooldown 후 다른 key 사용 |
| 모든 key 실패 | `maxAttemptsPerRequest`에 도달하면 sanitized error 반환 |
| 정상 stream 시작 후 오류 | 중복 실행 방지를 위해 failover하지 않음 |

### SDK retry를 0으로 설정하는 이유

OpenAI/Anthropic 계열 SDK는 자체 retry를 수행할 수 있습니다. SDK가 같은 key로 먼저 재시도하면 extension이 다른 key를 선택할 기회를 얻지 못합니다. 따라서 각 물리적 시도에는 `maxRetries: 0`을 적용하고, retry 여부와 다음 key 선택을 extension이 관리합니다.

## State와 동시 실행

기본 state 파일:

```text
~/.pi/agent/key-rotator-<provider>.state.json
```

저장되는 정보:

- current key ID
- key별 attempt/success/failure counter
- disabled 여부
- cooldown 종료 시각
- 마지막 HTTP status와 시각
- key source label 또는 환경변수 이름

저장되지 않는 정보:

- API key 원문
- prompt 또는 model output
- provider request/response body

여러 Pi 프로세스가 같은 state 파일을 사용하면 lock file로 key selection과 counter 갱신을 직렬화합니다. State는 temporary file에 먼저 쓴 뒤 atomic rename으로 교체합니다.

## 보안 고려 사항

### Literal mode의 보안 경계

`value`를 사용하면 API key는 `key-rotator.json`에 평문으로 존재합니다. Extension은 이를 암호화하지 않습니다. 로컬에서 복호화할 수 있는 key를 같은 위치에 보관하는 방식은 실질적인 보호가 제한적이기 때문입니다.

다음 원칙을 권장합니다.

1. 가능하면 config를 Git repository 밖에 둡니다.
2. Linux/macOS에서는 `chmod 600`을 적용합니다.
3. Windows에서는 ACL을 현재 사용자로 제한합니다.
4. cloud-sync 또는 backup 정책에 secret 파일이 포함되는지 확인합니다.
5. 공유 PC나 다중 사용자 서버에서는 환경변수 또는 별도 secret manager를 우선합니다.
6. Pi extension은 사용자 권한으로 실행되는 코드이므로 신뢰하지 않는 extension을 함께 설치하지 않습니다.

### Git에 API key를 commit한 경우

`.gitignore`는 아직 추적되지 않은 파일만 보호합니다. 이미 commit한 key는 `.gitignore`를 추가해도 history에 남습니다.

실제 key가 commit되었다면 다음 순서로 대응하세요.

1. 해당 key를 즉시 revoke/rotate합니다.
2. 새 key로 config를 교체합니다.
3. 필요하면 `git filter-repo` 등으로 history를 정리합니다.
4. fork, clone, CI log, cache에도 노출되었을 가능성을 검토합니다.

History 삭제만으로 기존 key가 다시 안전해지는 것은 아니므로 **key rotation이 우선**입니다.

### Secret redaction

- config validation error는 secret 값을 포함하지 않습니다.
- 최신 Node.js가 malformed JSON 오류에 source excerpt를 포함하더라도 extension은 위치 정보만 남깁니다.
- `/key-rotator status`와 footer는 ID 및 source label만 표시합니다.
- provider failover error는 등록된 secret 문자열을 redaction합니다.
- state와 lock file에는 secret을 쓰지 않습니다.

다만 요청을 보내려면 실행 중인 Pi process memory에는 선택된 API key가 존재합니다. 같은 사용자 권한으로 실행되는 악성 프로세스나 extension까지 방어하는 secret vault는 아닙니다.

## 지원 대상

주 사용 대상은 API-key 기반 단일 HTTP endpoint입니다.

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- 그 밖에 Pi `streamSimple` adapter가 `apiKey`, `maxRetries`, `onResponse`를 지원하는 API

AWS Bedrock, Google Vertex처럼 ambient cloud credential 또는 요청 서명을 사용하는 provider에는 적합하지 않습니다.

같은 provider 안에 서로 다른 API type의 model이 섞여 있으면 config 하나는 지정된 `api` 하나만 감쌉니다.

## 테스트

```bash
npm install
npm run check
```

`npm run check`는 TypeScript type check와 Node test suite를 실행합니다. CI는 지원 Node 버전에서 같은 검증을 수행합니다.

테스트 범위에는 다음 항목이 포함됩니다.

- N회 요청 후 round-robin rotation
- 429 cooldown과 `Retry-After`
- 401/402/403 disable
- network/5xx failover
- stream event 격리
- state migration 및 concurrent update
- literal/env/mixed key source
- 중복 secret 탐지
- malformed JSON redaction
- UTF-8 BOM
- 공백, control character, 비정상적으로 큰 secret validation

## 문제 해결

### `must specify exactly one of "env" or "value"`

한 key entry에서 `env`와 `value`를 동시에 사용했거나 둘 다 생략했습니다.

### `Missing or empty environment variables`

`env` 방식으로 지정한 환경변수가 Pi process에 전달되지 않았습니다. 환경변수를 설정한 뒤 새 terminal에서 Pi를 실행하세요.

### `same secret value`

서로 다른 ID가 동일한 실제 API key로 해석되었습니다. 중복 entry를 제거하거나 올바른 key를 설정하세요. 오류에는 secret 원문이 출력되지 않습니다.

### 모든 key가 disabled/cooldown 상태

```text
/key-rotator status
```

으로 상태를 확인합니다. 인증 문제를 해결한 뒤 다음 명령으로 초기화할 수 있습니다.

```text
/key-rotator reset
```

### 설정을 바꿨는데 반영되지 않음

Extension은 reload 시 config를 다시 읽습니다.

```text
/reload
```

## License

MIT
