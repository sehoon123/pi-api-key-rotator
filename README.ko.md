# pi-api-key-rotator

English: [README.md](README.md)

여러 개의 교체 가능한 API credential pool을 관리하는
[Pi](https://github.com/earendil-works/pi) extension입니다. 각
**rotator가 제어하는 provider 시도**마다 key를 선택하고, semantic output이 시작되기 전에는 다른 key로
failover하며, session과 process가 공유하는 state를 저장합니다.

raw secret은 저장하지 않습니다. state v2에는 SHA-256 credential identity를 저장하여 오래된 worker가
교체된 secret에 outcome을 적용하지 못하게 합니다. wrapper에 도달한 error data는 bounded redaction을
적용합니다. upstream adapter/SDK log와 Pi의 별도 agent-level retry는 이 boundary 밖에 있습니다.
[알려진 upstream 한계](#12-known-upstream-한계)를 참고하세요.

```text
footer:  pi-api-key-rotator   ibm-ica-shared: ica-key-3 7/20
```

## 1. v0.4.0 주요 기능

- `requestsPerKey`만큼 선택된 시도가 끝나면 다음 key로 순환합니다.
- 하나의 wrapper 요청에서 최대 `maxAttemptsPerRequest`개의 서로 다른 key를 시도합니다. 기본값은
  `min(keys.length, 3)`입니다.
- 지원 adapter가 status를 제공하면 기본적으로 `401/402/403`에서 credential을 비활성화합니다.
- 분류된 `429` cooldown 범위를 `key`, `target`, `pool` 중에서 선택할 수 있습니다.
- retryable transient HTTP/network failure를 target health failure로 처리합니다.
  `targetFailureThreshold`만큼 연속 실패하면 target circuit을 엽니다.
- semantic 의미가 없는 stream 구조만 buffer합니다. text, thinking, tool-call content가 보인 뒤에는
  failover하지 않습니다.
- 최종 provider terminal은 outcome state transaction이 commit될 때까지 보류합니다.
- state v2 generation과 credential-identity fence가 오래된 reset/config completion을 무시합니다.
- atomic replacement, 이전 state version backup, cross-process hard-link lock을 사용합니다.
- corrupt, wrong-pool, oversized, unsafe state를 조용히 초기화하지 않고 거부합니다.
- command-backed secret source와 read-only `/key-rotator doctor`를 제공합니다.
- 선택된 API, Pi에 유지된 provider registration, pool preflight가 rotator contract와 다르면 managed
  request를 거부합니다.

## 2. 요구 사항과 호환성

- **Pi `0.84.2`**와 matching `@earendil-works/pi-ai`. v0.4.0이 검증한 host contract입니다.
- **Node.js `>=22.19.0`**.
- pool마다 독립적으로 사용할 수 있는 API key 2개 이상.
- 각 provider가 `<agent dir>/models.json`에 이미 있어야 하며 `api` 값이 이 config와 정확히 같아야 합니다.
  `<agent dir>`은 `PI_CODING_AGENT_DIR`가 설정되어 있으면 그 값이고, 아니면 `~/.pi/agent`입니다.
  API mismatch에서는 Pi가 provider-scoped extension stream을 bypass할 수 있으므로 v0.4.0은 provider
  dispatch 전에 해당 managed request도 abort합니다.
- state directory의 filesystem이 atomic hard link를 지원해야 합니다.

Pi의 provider composition, adapter event, retry classification은 version별 contract입니다. 다른 Pi version을
쓰기 전에 [docs/PI_INTERNALS.md](docs/PI_INTERNALS.md)를 검토하세요.

Pi에는 extension 밖의 agent-level retry budget도 있습니다. `maxAttemptsPerRequest`는 wrapper invocation
하나만 제한합니다. 전체 turn의 엄격한 상한이 필요하면 Pi settings에서 `retry.enabled`를 `false`로 두고
`retry.provider.maxRetries`도 `0`으로 유지하세요.

> **key가 많다고 quota가 늘어나는 것은 아닙니다.** 같은 account, project, organization의 key는 보통
> quota bucket을 공유합니다. provider 정책을 먼저 확인하세요.

## 3. 설치, 업데이트, 삭제

검토한 release tag를 고정하세요.

```bash
pi install git:github.com/sehoon123/pi-api-key-rotator@v0.4.0
```

[빠른 시작](#5-빠른-시작)에서 config를 만든 뒤 session 안에서 다음을 실행합니다.

```text
/reload
/key-rotator doctor
/key-rotator status
```

pin된 source는 `pi update --extensions`로 새 tag로 이동하지 않습니다. 다음 검토 release를 쓰려면 그 ref를
명시하여 다시 설치합니다.

```bash
pi install git:github.com/sehoon123/pi-api-key-rotator@vNEXT
```

`pi update --extensions`는 이미 선택한 ref를 reconcile할 수 있습니다. 삭제할 때는 Pi settings에 표시된
source를 `pi remove`에 전달하세요.

pin하지 않은 설치는 이후 credential을 읽을 수 있는 코드까지 추적합니다. 업데이트마다 다시 검토하세요.
실제 config, state file, 로컬 수정 사항을 설치된 package clone 안에 두지 마세요. git package reconcile은
그 clone을 reset/clean할 수 있습니다.

## 4. v0.1-v0.3에서 업그레이드

이 upgrade에는 모든 writer를 중지해야 합니다.

1. 이 state file을 쓸 수 있는 모든 Pi session과 process를 중지합니다.
2. 각 state file과 모든 sidecar를 private backup directory로 복사합니다.
3. duplicate vendored/local extension copy가 있으면 제거합니다.
4. v0.4.0 tag를 설치하고 `/reload`를 실행합니다.
5. 모든 pool에서 `/key-rotator doctor`와 `/key-rotator status`를 실행합니다.

유효한 Pi v1 state는 memory에서 정규화되고 다음 mutation에서 Pi state v2로 기록됩니다. state 이름은 계속
`key-rotator-<poolId>.state.json`입니다. v0.4가 시작된 뒤 v0.1-v0.3 writer가 같은 파일을 쓰게 두지
마세요. 이전 writer는 generation, credential identity, target health, 새 lock protocol을 보존하지 않습니다.

배포 전에 다음 동작 변경을 검토하세요.

- `maxAttemptsPerRequest` 생략 시 더 이상 모든 key를 시도하지 않습니다. 최대 3개입니다.
- transient/network health는 key별 cooldown이 아니라 target scope로 관리합니다.
- state와 lock validation이 더 엄격하며 fail closed합니다.
- mutation에는 hard-link 지원이 필요합니다.
- custom `maxStateFileBytes`는 새 pool별 최소값 이상이어야 합니다.
- packaged example은 root `config*.example.json`에서 `examples/key-rotator.*.example.json`으로 이동했습니다.
- Pi agent-level retry는 settings에서 끄지 않으면 별도 budget으로 남습니다.

전체 breaking change와 복구 절차는 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 5. 빠른 시작

install command는 현재 working directory에 example을 만들지 않습니다. 따라서 고정된 release의 example을
직접 download하세요. `PI_CODING_AGENT_DIR` 또는 `PI_KEY_ROTATOR_CONFIG`를 설정했다면 absolute path를
사용하세요.

```bash
umask 077
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
config_file="${PI_KEY_ROTATOR_CONFIG:-$agent_dir/key-rotator.json}"
mkdir -p "$(dirname "$config_file")"
curl --fail --location \
  https://raw.githubusercontent.com/sehoon123/pi-api-key-rotator/v0.4.0/examples/key-rotator.literal.example.json \
  --output "$config_file"
chmod 600 "$config_file"
# "$config_file"의 provider/api를 <agent dir>/models.json과 일치시키고
# 모든 sk-REPLACE-ME-* placeholder를 실제 key로 바꾸세요.
```

package entry는 `PI_KEY_ROTATOR_CONFIG`가 설정되어 있으면 그 config를 읽습니다. 설정되어 있지 않으면
`<agent dir>/key-rotator.json`을 읽습니다. 여기서 `<agent dir>`은 `PI_CODING_AGENT_DIR`가 설정되어 있으면
그 값이고, 아니면 `~/.pi/agent`입니다. relative override는 Pi process의 working directory를 기준으로
resolve하므로 absolute path를 권장합니다. `PI_KEY_ROTATOR_CONFIG`는 config path만 바꾸며 Pi agent
directory나 default state-file directory를 바꾸지 않습니다.

example의 provider id와 `api` 값은 placeholder이며 provider/model을 생성하지 않습니다. `/reload` 전에
`<agent dir>/models.json`의 기존 항목과 정확히 일치시키세요. `env` example을 쓰면 Pi process를 시작하는
environment에 모든 변수를 export해야 합니다. 다른 terminal에 설정한 변수는 `/reload`가 가져오지 않습니다.

다른 example:

| File | 형태 |
|---|---|
| [`examples/key-rotator.env.example.json`](examples/key-rotator.env.example.json) | pool 1개, environment source |
| [`examples/key-rotator.literal.example.json`](examples/key-rotator.literal.example.json) | pool 1개, placeholder literal source |
| [`examples/key-rotator.command.example.json`](examples/key-rotator.command.example.json) | pool 1개, vault/keychain command |
| [`examples/key-rotator.multi-pool.example.json`](examples/key-rotator.multi-pool.example.json) | 독립 pool 2개 |
| [`examples/key-rotator.ibm-ica.example.json`](examples/key-rotator.ibm-ica.example.json) | Pi provider target 2개가 공유하는 pool 1개 |

editor schema는 [`docs/key-rotator.schema.json`](docs/key-rotator.schema.json)입니다. editor 설정에서
이 경로를 지정하세요. `key-rotator.json`에 `$schema` property를 추가하면 안 됩니다. runtime은 unknown
field를 거부합니다. JSON Schema로 표현할 수 없는 cross-field, physical-path, dynamic-size 검사를 포함하여
runtime validation이 최종 기준입니다.

## 6. 설정 reference

문서는 pool object 하나 또는 `{ "pools": [<pool>, ...] }` 형태입니다. pool은 최대 128개입니다.
`configVersion`은 선택 항목이며, 있으면 integer `1`이어야 하고 document root에만 둡니다. 최상위
`pools`와 pool field를 함께 사용할 수 없습니다.

| Field | 기본값 | Runtime 규칙 |
|---|---|---|
| `poolId` | 첫 provider id를 sanitize한 값 | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`에 맞는 1-64자. 안정적인 pool/state identity. |
| `targets[]` | multi-target 형식 | `{ provider, api }` object 1-128개. provider id는 중복 불가. |
| `provider` + `api` | legacy single-target 형식 | 항상 둘을 함께 쓰고 `targets`와 같이 쓰지 않음. |
| `keys[]` | 필수 | 2-256개. 각 항목은 `id`와 `env`/`value`/`command` 중 정확히 하나. |
| `requestsPerKey` | `20` | 1-1,000,000. shared pool의 모든 선택된 rotator 시도를 합산. |
| `maxAttemptsPerRequest` | `min(keys.length, 3)` | 1-`keys.length`. 논리적 요청 하나에서 검토할 서로 다른 key 수. |
| `cooldownMs` | `60000` | 0-86,400,000 ms. `Retry-After`가 없거나 잘못된 경우의 fallback. |
| `transientCooldownMs` | `5000` | 0-3,600,000 ms. transient/network target circuit 지속 시간. |
| `maxRetryAfterMs` | `900000` | 0-86,400,000 ms. `0`은 config cap 없음. safe-integer 제한은 유지. |
| `retryStatuses` | `401,402,403,408,409,425,429,500,502,503,504` | 비어 있지 않아야 하며 각 status는 100-599. |
| `disableStatuses` | `401,402,403` | 빈 배열 가능. `retryStatuses`의 subset. |
| `cooldownStatuses` | `429` | 빈 배열 가능. `retryStatuses`의 subset이며 `disableStatuses`와 겹치지 않음. |
| `rateLimitScope` | `"key"` | `"key"`, `"target"`, `"pool"` 중 하나. `cooldownStatuses`에 적용. |
| `targetFailureThreshold` | `2` | 1-100. target circuit을 열기 전 연속 transient/network failure 수. |
| `retryNetworkErrors` | `true` | 동일 요청 failover를 제어. false여도 network failure는 target health에 기록. |
| `stateFile` | `<agent dir>/key-rotator-<poolId>.state.json` | 절대, `~` 상대, config directory 상대 경로. config/다른 state artifact와 물리적으로 충돌하면 안 됨. |
| `lockTimeoutMs` | `5000` | 100-60,000 ms. |
| `staleLockMs` | `30000` | 1,000-600,000 ms. live owner의 lock은 오래됐다는 이유만으로 회수하지 않음. |
| `maxStateFileBytes` | `1048576` | 1,024-16,777,216 bytes이며 아래 dynamic minimum 이상. |

unknown field는 거부합니다. pool id는 대소문자를 무시하고 유일해야 합니다. provider 하나는 독립 pool
하나에만 속할 수 있습니다. `stateFile`, `.lock`, `.lock.reclaim`, `.bak` 위치는 모두 달라야 합니다.

### Dynamic `maxStateFileBytes` minimum

loader는 설정된 pool id, key id, target id로 UTF-8 직렬화한 worst-case v2 record의 크기를 계산합니다.
현재 record에 더해 bounded prior rolling-config generation(미설정 key 최대 256개, target 최대 128개)을
보존할 공간과 추가 1,024 bytes를 예약합니다. 따라서 범위상 최소값 1,024 bytes만으로는 실제 pool을 담을 수 없습니다. 설정값이 너무 작으면 load를
거부하고 필요한 정확한 byte 수를 표시합니다. 같은 제한을 state read/write 전에 적용합니다.

### Key source와 command 제한

| Source | 예 | 설명 |
|---|---|---|
| `env` | `{ "id": "k1", "env": "MY_KEY_1" }` | Pi process 환경에서 읽음. GUI/daemon은 shell profile을 상속하지 않을 수 있음. |
| `value` | `{ "id": "k1", "value": "sk-REPLACE-ME-1" }` | config에 평문. 파일을 private하게 유지. |
| `command` | `{ "id": "k1", "command": "op read op://Private/ai/k1", "commandTimeoutMs": 10000 }` | load 중 순차적으로 1회 실행. trim한 stdout을 memory secret으로 사용. |

secret은 well-formed Unicode여야 하며 최대 65,536 UTF-16 code unit와 131,072 UTF-8 byte입니다. command string은 최대 4,096자입니다.
`commandTimeoutMs` 기본값은 10,000이며 범위는 100-120,000 ms입니다. document 전체에서 command-backed
key는 최대 64개이고, 설정된 timeout 합계는 최대 600,000 ms입니다. resolution 자체에도 600,000 ms의
aggregate startup deadline이 있습니다. stdout은 132,096 bytes로 제한하며 stderr는 무시합니다. output과
rejection detail은 extension error로 복사하지 않습니다.

public loader는 cancellation을 받습니다. timeout/cancel 시 stdout을 닫고 process tree 종료를 요청합니다.
POSIX에서는 detached process group에 `SIGKILL`을 보내고, Windows에서는 `taskkill /T /F` 뒤 direct
termination을 시도합니다. 이는 best effort입니다. command가 만든 detached child는 완전히 종료하지 못할
수 있습니다. 신뢰할 수 있고 실행 시간이 제한된 command만 설정하세요.
[docs/SECRETS.md](docs/SECRETS.md)를 참고하세요.

## 7. Shared pool, rate-limit scope, target circuit

shared pool은 여러 `targets`를 가집니다. key, selection counter, disabled credential, current key는
공유합니다. target circuit state는 provider target마다 별도입니다.

독립 `pools[]` 항목은 key, 정책, state file이 모두 별도입니다. 독립 pool 두 개가 같은 `api` type을 쓸
수 있지만 provider id는 pool 하나에만 속합니다. [docs/MULTI_POOL.md](docs/MULTI_POOL.md)를 참고하세요.

`rateLimitScope`는 `cooldownStatuses`에 속한 status의 영향 범위를 정합니다.

| Scope | 기본 `429` 처리 | 사용 가능 범위 |
|---|---|---|
| `key` | 선택한 credential을 `Retry-After` 또는 `cooldownMs` 동안 cooldown. | 그 credential은 모든 shared target에서 중단되고 다른 key는 계속 가능. |
| `target` | 해당 provider target circuit을 즉시 그 시간 동안 open. | shared pool의 다른 target은 계속 가능. |
| `pool` | pool 전체를 즉시 그 시간 동안 cooldown. | 그 pool의 어떤 target/key도 계속할 수 없음. |

다른 retryable transient status 또는 network failure에서는 선택한 key의 failure counter를 올리지만 key를
cooldown/disable하지 않습니다. target의 consecutive failure가 증가하고 `targetFailureThreshold`에
도달하면 `transientCooldownMs` 동안 circuit을 엽니다. 더 최신인 success는 해당 key/target health와
더 오래된 pool cooldown을 해제합니다. attempt ordering fence 때문에 더 오래된 late failure가 그 key를
다시 disable하거나 해제된 scope를 다시 열 수 없습니다.

기본 threshold `2`에서는 `maxAttemptsPerRequest`가 `3`이어도 두 번의 연속 target failure 뒤 세 번째 key를
쓰지 않고 중단할 수 있습니다. target/pool scope `429`는 즉시 해당 scope를 닫으므로 같은 요청에서 다른
key도 그 unavailable scope를 계속 사용할 수 없습니다.

## 8. Stream과 failure 정책

아래 처리는 Pi adapter가 reliable HTTP status 또는 지원되는 structured failure를 제공할 때 적용됩니다.
그렇지 않은 adapter는 [Known upstream 한계](#12-known-upstream-한계)를 참고하세요.

| Semantic output 전 outcome | Durable 처리 | 동일 wrapper failover |
|---|---|---|
| 정상 `2xx`/`3xx` terminal | success | 아니오 |
| `disableStatuses` | 선택한 credential 비활성화 | 다른 key와 scope가 available이면 예 |
| `cooldownStatuses` | `rateLimitScope` delay 적용 | 선택 scope가 계속 available인 경우만 |
| 그 외 `retryStatuses` | target circuit 업데이트 | circuit/attempt budget이 멈출 때까지 예 |
| `400` 같은 non-retry status | failure 기록 후 최종 error 전달 | 아니오 |
| response 없는 network/stream failure | target circuit 업데이트 | `retryNetworkErrors`가 true일 때 |
| caller callback failure | 선택 attempt는 집계하지만 health penalty 없음 | 아니오 |
| caller abort | disable/cooldown health penalty 없음 | 아니오 |

각 선택 attempt는 adapter에 `maxRetries: 0`을 전달합니다. counter는 선택된 rotator attempt 수이며 모든
physical network call 수를 보장하지 않습니다. nested SDK와 Pi outer agent retry는 더 많은 call을 만들 수
있습니다. 임의의 숫자 error text를 HTTP status로 처리하지 않습니다.

### Semantic-event buffering

빈 `start`, block structure 같은 non-semantic event는 실제 text, thinking, tool-call content가 올 때까지
buffer합니다. in-band retryable failure는 이 pre-semantic 구조만 버릴 수 있습니다. unknown extension event는
호환성을 위해 semantic으로 봅니다.

semantic content를 전달한 뒤에는 low-latency streaming을 유지하고 automatic failover를 중단합니다. 이후
source가 실패하면 request를 반복하여 text/tool call을 중복시키지 않고 그 wrapper invocation의 terminal을
하나 보냅니다.

### 복구와 최종 오류 진단

package entry는 실행 중인 Pi의 public 오류 분류 함수를 주입합니다. HTTP `200` 연결 성공은 아직
완료된 응답이 아닙니다. semantic output 전에 일시적 오류, body iterator 단절, terminal 누락이 발생하면
기존 network 정책, target circuit, attempt budget 범위 안에서 failover합니다.

출력 전에 확인한 입력/context 초과는 `context_length_exceeded`로 전달하여 Pi가 입력을 압축하고
bounded recovery를 수행할 수 있게 합니다. 인증 오류, 상충하는 HTTP status, 이미 출력이 보인 뒤의 오류는
이 복구 경로에 넣지 않습니다. 나머지 최종 오류는 retry-neutral 문구를 유지하여 중복 출력과 별도
agent-level retry loop를 막습니다.

정제된 원인은 UI 알림과 `/key-rotator errors`에서 확인합니다. 최근 보고서 10개를 memory에 유지하고,
최소한의 non-context session metadata로 저장하여 reload 때 복원합니다. 보고서에는 prompt, assistant
content, header, stack, 전체 provider diagnostics를 저장하지 않습니다.

### Durable terminal gate

최종 `done` 또는 `error` event는 success/failure transaction이 state에 commit될 때까지 보류합니다. commit이
실패하면 provider terminal을 전달하지 않고 key-rotator 내부 error를 보냅니다. 전체 response를 buffer하는
것은 아니며 semantic incremental event는 이미 보일 수 있습니다.

Pi 0.84.2는 최종 provider-like error를 별도로 agent-level retry할 수 있습니다. 이 package는 private host lifecycle diagnostic을 가정하지 않습니다. 전체 시도 수의 엄격한 상한이 필요하면 Pi
`retry.enabled`를 끄세요.

## 9. 명령과 doctor

| 명령 | 설명 |
|---|---|
| `/key-rotator` | `status`와 동일. |
| `/key-rotator status [poolId]` | 모든 pool 또는 한 pool의 전체 상태. |
| `/key-rotator list` | pool마다 한 줄 요약. |
| `/key-rotator doctor` | read-only config/state/lock/post-bind registration 점검. provider 요청 없음. |
| `/key-rotator errors [poolId]` | 해당 session의 최근 정제된 오류 보고서 10개 확인. provider 요청 없음. |
| `/key-rotator next <poolId\|all>` | current key를 다음으로 이동. |
| `/key-rotator reset <poolId\|all>` | health/counter를 지우고 state generation 증가. |

pool이 여러 개이면 인자 없는 `next`/`reset`은 선택된 model의 pool을 추론할 수 있을 때 그 pool에 적용합니다.
추론할 수 없으면 거부하고 pool id 또는 `all`을 요구합니다.

`doctor`는 config metadata, 기존 state의 size/ownership/mode/readability, fixed lock sidecar, strict
read-only state parse, Pi의 public post-bind provider-registration evidence를 확인합니다. Pi 0.84.2에서는 정확한
configured API, inert `rotator-managed-key`, rotator stream function, 안전한 field set, native provider 부재,
그리고 capture한 registration-object identity를 요구합니다. request boundary에서 missing, changed, native,
unreadable registration을 관찰하면 `/reload` 전까지 `FAIL`로 유지합니다. doctor 실행 자체는 request state를
capture하거나 latch하지 않습니다. 두 public lookup method가 없는 Pi version에서는 local
submission을 acceptance로 간주하지 않고 `WARN`을 보고합니다.

Doctor는 `OK`, `WARN`, `FAIL`을 보고하며 provider request를 보내지 않습니다. credential/quota를 검증하지
않고 Windows ACL, 모든 adapter failure shape, mutation 없는 hard-link 지원을 증명하지 않습니다. 또한 Pi
hook을 bypass하거나 `AbortSignal`을 무시하거나 직접 `fetch`/registry API를 호출하는 malicious trusted
extension/provider를 통제할 수 없습니다. config load 자체가 실패하면 disabled `/key-rotator`가 load error를
표시하며 full doctor는 아직 사용할 수 없습니다.

## 10. State v2, lock, fail-closed 동작

Pi state v2에는 다음 정보가 있습니다.

- `magic: "pi-api-key-rotator-state"`, `version`, `poolId`, positive `generation`;
- current-key/attempt counter, timestamp, pool cooldown과 success-ordering fence;
- key별 counter/health, outcome ordering, `credentialFingerprint`, `configRevision`;
- target별 failure, ordering, circuit field.

`credentialFingerprint`는 resolved secret의 lowercase SHA-256입니다. raw secret은 state에 기록하지 않습니다.
hash는 encryption이 아니라 identity metadata입니다. entropy가 낮은 secret은 offline guessing이 가능할 수
있습니다. status snapshot에서는 hash와 config revision을 제외합니다.

selection은 state `generation`을 epoch로, credential fingerprint를 identity로 capture합니다. `reset`은
generation을 증가시키므로 이전 in-flight completion이 reset된 pool을 다시 disable할 수 없습니다. 더 최신
config가 같은 key id의 value를 바꾸면 새 identity의 key health를 초기화합니다. 이전 worker와 in-flight
outcome은 새 identity를 선택하거나 업데이트할 수 없습니다. rolling config overlap 중 잠시 config에서
빠진 유효 record도 key 256개와 target 128개 한도로 보존하여 반복 변경이 state를 무한히 키우지 않게 합니다.

commit write 순서:

1. unique mode-`0600` candidate를 쓰고 `fsync`;
2. 이전 immutable state version을 hard-link하고 그 link를 `<stateFile>.bak`으로 이동;
3. candidate를 state file 위로 atomic rename;
4. platform이 지원하면 parent directory sync.

`.bak`은 보통 **직전** complete state이며 자동 복원하지 않습니다. platform이 안전한 backup 교체를
거부하면 더 오래된 known-good backup을 유지하므로 둘 이상의 transaction만큼 뒤처질 수 있습니다. 첫 state
write에는 이전 backup이 없습니다.

cross-process mutation은 완전히 기록하고 sync한 lock candidate를 hard link로 `<stateFile>.lock`에 atomic
publish합니다. creator가 소유한 `<stateFile>.lock.reclaim` hard link가 compare-and-unlink stale-lock recovery를
직렬화합니다. 기존 reclaim claim은 자동 삭제하지 않습니다. Node에는 portable pathname compare-and-delete가
없으므로 claimant가 crash하면 fail closed하며 아래 recovery 절차가 필요합니다. 새 owner는 mutation 전에
claim이 사라질 때까지 기다리고 자신의 lock을 다시 검증합니다. timestamp가 오래됐다는 이유만으로 live
owner의 lock을 빼앗지 않습니다. Linux에서는 PID reuse를 구분하기 위한 process-start marker도 저장합니다.
malformed lock metadata는 dead owner의 증거로 취급하지 않으며 manual recovery가 필요합니다. 오래된
pre-publication lock candidate도 creator가 살아 있으면 유지하며, valid matching metadata로 creator death가
증명된 경우에만 자동 cleanup합니다. hard link가 unsupported이면 unsafe fallback을 쓰지 않고 mutation을
거부합니다.

malformed JSON/UTF-8, invalid known field, unknown version/magic, wrong `poolId`, unsafe type/owner/write mode,
symlink/repeated identity race, `maxStateFileBytes` 초과 state는 fail closed하며 증거를 overwrite하지 않습니다.
lock-free read-only snapshot은 concurrent atomic replacement race를 한 번 retry합니다. state file이 단순히
없는 경우에만 fresh state를 시작합니다.

loader는 **command-backed secret 실행 전** lexical/physical path collision도 거부합니다. 모든 pool의
config, state, lock, reclaim, backup 경로에 대해 symlink ancestor와 reliable existing inode/hard-link
alias를 resolve합니다. inode `0`을 보고하는 filesystem에서는 false collision을 피하기 위해 canonical path만
사용합니다. 이 파일들을 private local directory에 두세요. 이 collision 검사는 같은 OS user 권한을 가진
악성 process를 막는 sandbox는 아닙니다.

## 11. 복구

corrupt, wrong-pool, oversized, unsafe state를 `/key-rotator reset`으로 고치려고 하지 마세요. reset도 먼저
기존 파일을 읽고 검증해야 합니다.

1. pool을 사용할 수 있는 모든 Pi process를 중지합니다.
2. state, `.bak`, `.lock`, `.lock.reclaim`을 진단용으로 보존합니다.
3. 원인을 고칩니다.
   - unsafe mode/owner: 올바른 owner로 복원하고 `chmod 600` 적용;
   - wrong pool/path collision: pool에 전용 state file을 지정하고 다른 pool id를 수정하지 않음;
   - dynamic size config error: `maxStateFileBytes`를 16 MiB 이내로 높이거나 id/key/target 수를 줄임;
   - hard link unsupported: hard-link 가능한 local filesystem으로 state 이동;
   - lock timeout: reaper crash 후 `.lock`이 없어도 `.lock.reclaim`이 남을 수 있습니다. 모든 owner가
     중지됐는지 확인하고 두 path를 보존한 뒤 stale `.lock`과 `.lock.reclaim`을 함께 archive하고
     재시작합니다. writer가 실행될 수 있을 때 sidecar 하나만 삭제하지 마세요.
4. main state가 잘못됐고 `<stateFile>.bak`이 같은 pool의 known-good state라면 backup을 같은 directory의 새
   mode-`0600` file로 복사한 뒤 main state 위로 atomic rename합니다. 실패한 원본은 보관하세요. 최신
   transaction 하나는 잃을 수 있습니다.
5. 유효한 backup이 없으면 계속 disabled여야 할 credential을 먼저 revoke/fix하고, 모든 state artifact를
   archive한 뒤 fresh state를 만들게 합니다. counter, cooldown, disabled flag를 의도적으로 잃는 절차입니다.
6. `/reload`, `/key-rotator doctor`, `/key-rotator status`를 실행합니다.

모든 writer를 중지한 뒤 같은 directory에서 복원하는 예:

```bash
state="$HOME/.pi/agent/key-rotator-POOL_ID.state.json"
cp "$state" "$state.failed.$(date +%s)"
cp "$state.bak" "$state.recovered.tmp"
chmod 600 "$state.recovered.tmp"
mv "$state.recovered.tmp" "$state"
```

`PI_CODING_AGENT_DIR` 또는 custom `stateFile`을 쓰면 위 path를 바꾸세요.

사용 전에 backup의 `magic`, `version`, `poolId`가 예상값인지 검증하세요. age만 보고 lock을 삭제하지 마세요.

## 12. Known upstream 한계

다음 한계는 Pi 0.84.2, pi-ai, vendor SDK에 있습니다.

- adapter failure reporting이 균일하지 않습니다. 일부 OpenAI-compatible non-2xx, Anthropic HTTP-200
  in-band error, Google/WebSocket path는 `onResponse`, status, `Retry-After`를 누락할 수 있습니다. 분류할 수
  없는 failure에는 status별 disable/cooldown을 적용할 수 없습니다.
- Pi는 wrapper budget이 끝난 뒤 최종 error text를 보고 agent-level retry할 수 있습니다. 전체 turn의
  엄격한 상한에는 `retry.enabled: false`가 필요합니다.
- provider adapter/SDK가 wrapper가 terminal event를 받아 redact하기 전에 error, response, header,
  request를 log할 수 있습니다. 이미 기록된 upstream log는 이 extension이 지울 수 없습니다.
- incremental event로 이미 노출된 assistant `content`는 이후 terminal에서도 그대로 보존합니다. model
  output을 사후에 바꾸거나 truncate하지 않습니다.
- `maxRetries: 0`이어도 nested SDK가 hidden retry를 가질 수 있습니다. 따라서 `totalAttempts`와
  `requestsPerKey`는 선택된 rotator attempt 수이며 모든 physical network call 수와 다를 수 있습니다.
- text fallback은 좁은 api-specific 형식만 사용합니다. 임의 숫자는 HTTP status로 보지 않습니다. 새
  adapter/Pi release의 failure 동작은 real-host test가 필요합니다.

upstream log를 보호하고 credential을 다룰 때 provider debug logging을 끄세요. Pi provider retry는 0으로
유지하고 별도 agent-level retry setting도 검토하세요.

## 13. 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| footer가 `keys: disabled` | local config 또는 startup 실패. `/key-rotator`에서 기록된 load error 확인. |
| duplicate extension/provider registration | competing registration을 관찰하면 request fence와 doctor가 실패함. duplicate copy를 제거하고 `/reload` 실행. |
| managed request가 dispatch 전에 거부됨 | selected model API mismatch, pool preflight 실패, 또는 Pi가 정확한 rotator registration을 유지하지 않음. 원인을 수정하고 `/reload` 실행. |
| managed provider가 rotation 없이 fallback 전송 | 즉시 중단. trusted component가 검증된 Pi 0.84.2 extension pipeline을 bypass했거나 cancellation을 무시함. |
| `The credential rotator stopped this request. Review diagnostics for details.` | 알림 또는 `/key-rotator errors`에서 실제 원인 확인. budget, credential, state의 실제 실패는 계속 안전하게 중단. |
| `No rotation entry is currently available (...)` | key, target, pool scope 중 하나가 unavailable. status 확인. |
| `Credential failover exhausted N attempt(s)` | wrapper budget 소진 또는 target/pool circuit 중단. Pi outer retry는 별도일 수 있음. |
| state corruption/security/size error | fail closed 상태. reset이 아니라 복구 절차 사용. |
| state lock timeout | live/ambiguous writer 또는 contention. process 확인 전 sidecar 삭제 금지. |
| filesystem does not support atomic hard-link locks | hard-link 가능한 local filesystem으로 `stateFile` 이동. |
| `maxStateFileBytes must be at least N` | 표시된 dynamic minimum 이상 사용. |
| command timeout/stdout 초과/start 실패 | trusted secret command 수정. output은 error에 포함하지 않음. |
| 401/429가 network/unknown으로 기록 | adapter가 지원 status shape를 제공하지 않음. pinned host 한계와 integration test 확인. |

## 14. Pi 연동 방식

Pi 0.84.2는 extension `streamSimple`을 registered provider마다 compose하고 selected model API와
registration API가 같을 때만 호출합니다. package는 configured target마다 inert fallback
`rotator-managed-key`를 등록하고 각 attempt에 선택한 실제 key를 inject합니다. 또한 `input`, 모든
`turn_start`, 두 provider-request hook에서 public provider registration과 model API를 다시 확인합니다. blocked
request는 dispatch 전에 동기적으로 abort하며 authentication header 삭제는 defense in depth일 뿐입니다.
selected managed target이 blocked 상태이면 compaction/tree summary generation도 cancel합니다.

검증된 fence 범위는 Pi의 `AgentSession` lifecycle pipeline입니다. trusted extension이
`ctx.modelRegistry.complete()`를 직접 호출하면 lifecycle hook을 bypass합니다. `fetch` 또는 registry를 직접
호출하거나 cancellation을 무시하는 code도 범위 밖입니다. global per-API dispatcher를 설치하거나 native
provider를 takeover하지 않습니다.

base attempt stream은 `@earendil-works/pi-ai/compat`의 `streamSimple`입니다. auth-like header 안의 raw,
URL-encoded, base64, base64url credential 형태도 선택한 key 형태로 교체합니다. failure event와 outer retry는
host-specific입니다. [docs/PI_INTERNALS.md](docs/PI_INTERNALS.md)를 참고하세요.

| Pi | pi-ai | v0.4.0 상태 |
|---|---|---|
| `0.84.2` | `0.84.2` | 검증 target |

## 15. 개발과 release check

```bash
npm ci --include=dev
npm run check
npm run test:coverage
npm run test:package
npm run test:host
```

설치된 Pi **0.99.1** host로 targeted recovery test를 추가 실행할 수 있습니다.

```bash
PI_ROTATOR_HOST_ROOT=/absolute/path/to/pi-coding-agent \
  node --test test/current-host-recovery.integration.mjs
```

가짜 credential과 loopback HTTP 서버로 loading, failover, context recovery, 최종 오류 budget,
API fence를 검증합니다. 위 pinned release contract를 넘어서는 전체 호환성 선언은 아닙니다.

Pi core package 두 개는 installed extension에 Pi가 제공하므로 wildcard peer입니다. lockfile은 development와
contract test용 copy를 정확한 0.84.2로 고정합니다. CI는 Ubuntu/Windows와 Node 22.19/24를 실행합니다.

MIT license. [LICENSE](LICENSE)를 참고하세요.

