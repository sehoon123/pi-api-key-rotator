# pi-api-key-rotator

하나의 LLM endpoint에 여러 API key를 순차적으로 적용하는 **Pi extension**입니다.

사용자가 입력한 prompt 수가 아니라 Pi가 실제로 수행한 **provider HTTP 요청 횟수**를 기준으로 key를 회전합니다. 한 agent turn에서 tool call이 여러 번 발생하면 LLM 요청도 여러 번 발생하므로, 각 요청이 rotation counter에 반영됩니다.

## 주요 기능

- 같은 provider/endpoint에 여러 API key 적용
- 기본값으로 key 하나를 20회 사용한 뒤 다음 key로 순환
- `429` 발생 시 `Retry-After`를 반영해 해당 key를 cooldown 처리하고 같은 논리 요청을 다음 key로 즉시 재시도
- `401`, `402`, `403` 발생 시 해당 key를 비활성화하고 다음 key로 failover
- `5xx`, timeout 계열 status 및 HTTP 응답 전 network failure에 대한 제한된 failover
- Pi SDK 내부 재시도를 `0`으로 설정하여 같은 key가 먼저 반복 사용되는 현상 방지
- 여러 Pi 프로세스가 동시에 실행돼도 파일 lock과 atomic write로 rotation state 공유
- API key 원문을 config, state, status, log에 저장하지 않음
- `/key-rotator` 명령으로 현재 상태 확인, 수동 전환, 상태 초기화
- TypeScript 소스 그대로 Pi package로 설치 가능

## 동작 구조

```text
Pi agent
   │
   │ provider request
   ▼
pi-api-key-rotator
   │
   ├─ key-1: 20 attempts ──────────────┐
   ├─ key-2: 20 attempts               │ round-robin
   └─ key-3: 20 attempts ◀─────────────┘
   │
   ▼
단일 provider endpoint
```

Failover는 다음과 같이 동작합니다.

```text
key-1로 요청
   │
   ├─ 2xx/3xx ── 응답 stream을 Pi에 즉시 전달
   │
   ├─ 429 ────── Retry-After 동안 key-1 cooldown
   │                 └─ 같은 논리 요청을 key-2로 재시도
   │
   ├─ 401/402/403 ─ key-1 disabled
   │                    └─ 같은 논리 요청을 key-2로 재시도
   │
   └─ 5xx/network ─ 짧은 cooldown 후 key-2로 제한적 재시도
```

Extension은 provider 응답 status가 확인될 때까지만 초기 `start` 이벤트를 보관합니다. 정상 status면 즉시 streaming을 시작하고, failover 대상 status면 실패한 시도의 이벤트를 폐기한 뒤 다음 key로 재요청합니다. 이미 정상 응답 body가 사용자에게 전달되기 시작한 뒤에는 중복 실행 위험 때문에 다른 key로 재시도하지 않습니다.

## 요구 사항

- Pi `0.84.2` 이상 권장
- Node.js `22.19.0` 이상
- `~/.pi/agent/models.json`에 이미 등록된 단일 custom provider
- 서로 독립적으로 사용할 수 있는 API key 2개 이상

> 동일 계정, project 또는 organization의 quota를 key들이 공유한다면 key 개수만 늘려도 전체 quota는 증가하지 않습니다. 먼저 provider의 quota 단위를 확인해야 합니다.

## 설치

GitHub 저장소에서 설치하는 경우:

```bash
pi install git:github.com/sehoon123/pi-api-key-rotator
```

Private repository를 SSH로 설치하는 경우:

```bash
pi install git:git@github.com:sehoon123/pi-api-key-rotator
```

로컬 checkout으로 먼저 시험하는 경우:

```bash
pi -e /absolute/path/to/pi-api-key-rotator
```

정식으로 로컬 package를 등록하는 경우:

```bash
pi install /absolute/path/to/pi-api-key-rotator
```

## 설정

### 1. 기존 provider 확인

이 extension은 endpoint와 model 정의를 새로 만들지 않습니다. 기존 `~/.pi/agent/models.json`의 provider를 같은 ID로 감싸고, 실제 요청에 들어가는 API key만 교체합니다.

예를 들어 OpenAI-compatible endpoint가 다음과 같이 등록돼 있다고 가정합니다.

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

여기서 중요한 값은 다음 두 개입니다.

```text
provider ID = my-company-ai
API type    = openai-completions
```

`models.json`의 `apiKey`는 Pi가 provider를 사용 가능한 상태로 판단하기 위한 fallback auth입니다. Extension이 활성화되면 실제 provider 요청의 `apiKey`는 매번 key pool에서 선택한 값으로 덮어씁니다.

`authHeader: true` 또는 custom header 때문에 fallback key가 이미 `Authorization`, `x-api-key` 같은 header 문자열 안에 들어간 경우에도, extension은 해당 문자열에서 기존 `options.apiKey` 부분만 선택된 key로 치환합니다. Gateway용 별도 token처럼 fallback key와 무관한 header 값은 그대로 유지합니다.

### 2. API key를 환경변수로 설정

API key 원문은 `key-rotator.json`에 넣지 않습니다.

PowerShell 현재 세션:

```powershell
$env:MY_COMPANY_API_KEY_1 = "sk-key-1"
$env:MY_COMPANY_API_KEY_2 = "sk-key-2"
$env:MY_COMPANY_API_KEY_3 = "sk-key-3"
```

Windows 사용자 환경변수로 저장:

```powershell
setx MY_COMPANY_API_KEY_1 "sk-key-1"
setx MY_COMPANY_API_KEY_2 "sk-key-2"
setx MY_COMPANY_API_KEY_3 "sk-key-3"
```

`setx`를 사용한 뒤에는 기존 terminal이 아니라 새 terminal에서 Pi를 실행해야 합니다.

Bash/Zsh:

```bash
export MY_COMPANY_API_KEY_1="sk-key-1"
export MY_COMPANY_API_KEY_2="sk-key-2"
export MY_COMPANY_API_KEY_3="sk-key-3"
```

### 3. Rotation config 생성

`config.example.json`을 다음 위치에 복사합니다.

- Windows: `%USERPROFILE%\.pi\agent\key-rotator.json`
- Linux/macOS: `~/.pi/agent/key-rotator.json`

기본 예시:

```json
{
  "provider": "my-company-ai",
  "api": "openai-completions",
  "keys": [
    { "id": "key-1", "env": "MY_COMPANY_API_KEY_1" },
    { "id": "key-2", "env": "MY_COMPANY_API_KEY_2" },
    { "id": "key-3", "env": "MY_COMPANY_API_KEY_3" }
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

다른 위치의 config를 사용하려면 Pi 실행 전에 다음 환경변수를 설정합니다.

```powershell
$env:PI_KEY_ROTATOR_CONFIG = "C:\secure-config\key-rotator.json"
```

```bash
export PI_KEY_ROTATOR_CONFIG=/secure-config/key-rotator.json
```

### 4. Pi reload

Pi를 다시 시작하거나 다음 명령을 실행합니다.

```text
/reload
```

그다음 기존 provider의 model을 선택합니다.

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
| `/key-rotator` | 현재 pool 상태 표시. `status`와 동일 |
| `/key-rotator status` | current key, 호출 수, 성공/실패 수, cooldown/disabled 상태 표시 |
| `/key-rotator next` | 다음 사용 가능한 key로 수동 이동 |
| `/key-rotator reset` | disabled/cooldown 상태와 모든 counter 초기화 |

명령과 footer에는 `key-1` 같은 ID만 나타나며 API key 값이나 환경변수 값은 표시하지 않습니다.

## 기본 정책

| 상황 | 기본 동작 |
|---|---|
| 정상 요청 | 한 key로 20회 실제 provider call 후 다음 key로 이동 |
| `429` | `Retry-After`를 우선 사용하고, 없으면 60초 cooldown |
| `401`, `402`, `403` | 해당 key를 disabled 처리하고 다음 key로 재시도 |
| `408`, `409`, `425`, `5xx` | 해당 key를 5초 cooldown하고 다음 key로 재시도 |
| HTTP 응답 전 network failure | 5초 cooldown 후 다른 key로 재시도 |
| 모든 key 실패 | `maxAttemptsPerRequest` 도달 후 sanitized error 반환 |
| 정상 response stream 시작 후 오류 | 중복 요청을 막기 위해 failover하지 않음 |

### 왜 SDK retry를 0으로 만드는가

OpenAI/Anthropic 계열 SDK는 자체 retry를 수행할 수 있습니다. SDK가 먼저 같은 key로 재시도하면 rotation extension이 다른 key를 선택할 기회를 얻지 못합니다. 따라서 각 물리적 시도에서는 `maxRetries: 0`으로 호출하고, 재시도 여부와 다음 key 선택을 extension이 직접 관리합니다.

## Config reference

| 필드 | 기본값 | 설명 |
|---|---:|---|
| `provider` | 필수 | `models.json`에 있는 provider ID |
| `api` | 필수 | 대상 model이 사용하는 Pi API type |
| `keys` | 필수 | `{ id, env }` 목록. 최소 2개이며 ID와 env는 중복 불가 |
| `requestsPerKey` | `20` | 다음 key로 넘어가기 전 실제 provider attempt 수 |
| `maxAttemptsPerRequest` | key 개수 | 하나의 논리 요청에서 시도할 최대 key 수 |
| `cooldownMs` | `60000` | `429`에 `Retry-After`가 없을 때 cooldown |
| `transientCooldownMs` | `5000` | network/5xx 계열 실패의 짧은 cooldown |
| `maxRetryAfterMs` | `900000` | `Retry-After` 적용 상한. `0`이면 상한 없음 |
| `retryStatuses` | 위 예시 | 다음 key로 failover할 HTTP status |
| `disableStatuses` | `401,402,403` | 수동 reset 전까지 key를 비활성화할 status |
| `cooldownStatuses` | `429` | `Retry-After` 또는 `cooldownMs`를 사용할 status |
| `retryNetworkErrors` | `true` | HTTP 응답 전 오류에서 다음 key 사용 여부 |
| `stateFile` | provider별 자동 경로 | rotation state JSON 위치 |
| `lockTimeoutMs` | `5000` | state lock 획득 제한 시간 |
| `staleLockMs` | `30000` | 비정상 종료 후 남은 lock을 stale로 판단하는 시간 |

`disableStatuses`와 `cooldownStatuses`의 모든 값은 반드시 `retryStatuses`에도 포함돼야 합니다.

## 지원 대상

주 사용 대상은 다음과 같은 **API-key 기반 단일 HTTP endpoint**입니다.

- `openai-completions`: OpenAI Chat Completions compatible endpoint
- `openai-responses`: OpenAI Responses compatible endpoint
- `anthropic-messages`: Anthropic Messages compatible endpoint
- 그 밖에 Pi의 built-in `streamSimple` adapter가 `apiKey`, `maxRetries`, `onResponse`를 지원하는 API

AWS Bedrock, Google Vertex처럼 API key가 아니라 ambient cloud credential이나 서명 기반 인증을 사용하는 provider에는 이 방식이 적합하지 않습니다.

`provider`와 `api`가 대상 model과 일치하지 않으면 extension은 model 선택 시 경고합니다. 특히 같은 provider 안에서 서로 다른 API type의 model을 혼합한 경우에는 현재 버전에서 config 하나당 API type 하나만 감쌉니다.

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

저장되지 않는 정보:

- API key 원문
- API 요청/응답 body
- prompt 또는 model output

여러 Pi 프로세스가 같은 state 파일을 사용하면 lock file로 selection과 counter 갱신을 직렬화합니다. State는 temporary file에 먼저 기록한 후 atomic rename으로 교체합니다.

## 보안 고려 사항

1. API key는 환경변수에서만 읽으며 repository와 config에 저장하지 않습니다.
2. Config validation error, `/key-rotator status`, footer에는 secret이 출력되지 않습니다.
3. Extension이 생성하는 최종 failover error에서는 등록된 secret 문자열을 redaction합니다.
4. State와 lock file은 생성 시 사용자 전용 permission을 요청합니다.
5. Pi extension은 사용자 권한으로 실행되는 코드입니다. 설치 전에 source를 검토해야 합니다.
6. CI, shell history, process environment dump, endpoint 자체 log는 이 extension의 통제 범위 밖입니다.

## 정확한 counting 의미

`requestsPerKey: 20`은 다음을 의미합니다.

```text
20개의 사용자 prompt가 아니라
20개의 실제 provider attempt
```

예를 들어 한 prompt가 다음 agent loop를 만들 수 있습니다.

```text
LLM call #1 → tool call → LLM call #2 → tool call → LLM call #3
```

이 경우 rotation counter는 3 증가합니다. `429` 후 다른 key로 failover한 요청도 물리적으로 두 번 전송됐으므로 counter는 각각의 key에 한 번씩 반영됩니다.

## 개발과 테스트

```bash
npm install
npm run check
```

개별 명령:

```bash
npm run typecheck
npm test
```

Test suite는 Node 내장 test runner를 사용하며 다음을 검증합니다.

- N회 단위 round-robin 경계
- 429 + `Retry-After` cooldown
- 401 key disable과 reset
- 5xx/network failover
- 실패 시도의 stream event가 성공 stream에 섞이지 않는지
- SDK retry override
- caller options 불변성
- fallback key가 포함된 custom auth header의 안전한 교체
- concurrent selection과 file lock
- corrupt state normalization
- config 및 status에서 secret 비노출
- extension provider/command 등록

GitHub Actions는 Node `22.19.0`과 최신 Node `24.x`에서 typecheck와 test를 실행합니다.

## Troubleshooting

### `/model`에서 provider가 보이지 않음

- `models.json`의 provider ID가 `key-rotator.json`의 `provider`와 정확히 같은지 확인합니다.
- `models.json`의 `apiKey`를 `$MY_COMPANY_API_KEY_1`처럼 환경변수 참조로 설정합니다.
- key 환경변수가 Pi 프로세스에 실제로 전달됐는지 확인합니다.
- `/reload` 후 다시 `/model`을 엽니다.

### Footer에 `keys: disabled`가 표시됨

다음을 실행하면 정확한 config error를 볼 수 있습니다.

```text
/key-rotator
```

흔한 원인은 config 파일 누락, JSON 문법 오류, 환경변수 누락, 중복 key 값입니다.

### 모든 key가 cooldown 상태임

`/key-rotator status`에서 종료 시각을 확인합니다. 긴 `Retry-After`가 내려오면 `maxRetryAfterMs`까지 적용됩니다. 원인을 해결했다는 확신이 있는 경우에만 `/key-rotator reset`을 사용합니다.

### Key를 추가하거나 환경변수를 바꿈

현재 key 값은 extension load 시점에 읽습니다. Config 또는 환경변수를 수정한 뒤 Pi를 새 terminal에서 다시 실행하거나 `/reload`를 수행합니다.

### Key를 여러 개 만들었는데 quota가 늘지 않음

Provider가 API key가 아니라 account/project/org 단위 quota를 적용하는 경우입니다. 이 extension은 독립 quota를 새로 만들지 않으며, 이미 존재하는 quota bucket 사이의 routing만 수행합니다.

## 설계상 제한

- 동일 endpoint 전체가 장애 상태라면 key rotation으로 복구되지 않습니다.
- 이미 응답 content를 전달하기 시작한 요청은 중복 생성 방지를 위해 다른 key로 replay하지 않습니다.
- API별 quota reset header는 표준 `Retry-After`만 직접 해석합니다. Provider 전용 header는 현재 지원하지 않습니다.
- 하나의 config는 provider 하나와 API type 하나를 대상으로 합니다.
- Literal API key, shell command 기반 key resolver, OAuth token rotation은 의도적으로 지원하지 않습니다.

## License

MIT
