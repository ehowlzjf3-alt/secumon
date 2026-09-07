# P3-01 MCP adapter: 의존성 변경·복구 검증 계획

2026-09-06 · 독립 읽기 검토 · 구현 및 실행 전 계획

이번 검토에서는 파일과 기존 실행 경로만 읽었다. SDK 설치, 제품/시험/이전 기록 수정, MCP 프로세스·브라우저·서버·모델/API 실행은 하지 않았다. 새 기록 helper도 복사하지 않았다. 실제 사내 MCP와 데이터·키 접근은 계속 범위 밖이다.

## 고정한 이전 정본

아래 값은 이번 읽기에서 현재 파일의 크기와 SHA256을 계산하여 확인했다.

| 대상 | bytes | SHA256 |
|---|---:|---|
| `runtime/evidence/P3-local-web-driver-local-verification.json` | 202932 | `e4a7d322d62135b1628209d3e386d64f0b3b91a1f42924275b0f915e38488725` |
| `runtime/evidence/P3-local-web-driver-verify.log` | 245753 | `54f2d747bd5e4e9ebcac1786839236b2484432785df47def895ac530fce81b01` |
| `runtime/package-lock.json` | 4032 | `0c9ead61d07e560f9a1278aa8a4d280e8e8791869c14dc6082c9351b5af1fa79` |
| `design/extraction-manifest.json` | 420378 | `d4655e259eece6de1ec2537fdb7a4f79fe0faf07313ad8e1468cf8e85a572e3a` |

정본은 v0.38, 전체 기본 검증 1,950 통과·실패 0, P3-04 `in_progress`/로컬 `partially_verified`다. verify 로그와 lock은 그 정본의 pin과 일치했다. 원본 1,973개 보존은 이전 정본에 기록되어 있으며, 이 bounded 검토에서 1,973개 본문을 다시 순회하지 않았다. 새 단위 최종 검증에서는 기존 manifest의 크기/해시 대조를 다시 수행해야 한다.

## SDK 추가로 lock이 바뀔 때

1. SDK client/server의 **정확한 패키지명·버전·공식 stable 여부·지원 Node·협상 protocol version**을 루트의 공식 자료 확인 결과로 고정한다. 착수 지시에서 언급된 v2 및 2026-07-28 규격은 루트가 확인 중인 입력이다. 이 검토는 설치되거나 협상된 버전으로 확정하지 않는다. 과거 설계의 2025-11-25 링크도 당시 근거이며 현재 버전 확인을 대체하지 않는다.
2. 이번 추가는 의도된 의존성 변경이다. 이전 helper의 `dependencyLockUnchanged === true`를 그대로 성공 조건으로 복사하지 않는다. 이전 lock pin은 위 값으로 보존하고, 새 record에 변경 이유·직접/전이 의존성 delta·exact version·lock integrity/resolved 정보·설치 명령/종료 코드/로그·새 package/lock hash를 남긴다. 계획 밖 업그레이드나 lock 전체 재해결을 숨기지 않는다.
3. 이전 v0.38 정본·검증 로그·과거 source/build pin은 수정하지 않는다. 옛 source/build pin은 당시 기록의 일부다. 현재 워크스페이스와 일치시키기 위해 옛 JSON을 재생성하면 안 된다. 새 source/build stamp와 새 SDK를 사용하는 타입/아키텍처/fixture/전체 검증은 새 기록에서 연결한다.
4. client는 인프라 adapter에서 사용하고 domain/application에 SDK·Node transport 타입을 전파하지 않는다. local fixture server가 시험 전용이면 server 의존성의 용도도 구분한다. 실제 설치된 SDK를 사용하는 로컬 stdio 시험과 메서드를 대체한 fake 시험은 별도 수치로 남긴다.
5. reproducible install 검증의 명령·환경은 루트가 정한다. `npm ci` 또는 다른 설치를 실행하지 않은 상태에서 통과라고 쓰지 않는다. 외부 취약점/API 조회나 추가 패키지 다운로드를 검증 helper가 자동 수행하게 만들지 않는다.

## 기존 런타임에서 재사용할 지점

- [ToolBroker](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts:23)는 committed dispatch receipt, task/input/contract digest, 현재 owner·goal·policy·budget·deadline·효과 의무를 검사한 뒤 도구에 진입한다. MCP 도구 설명과 annotation은 발견 자료이며, 신뢰된 effect/권한 정책을 대신하지 않는다. 선택된 작은 기능 집합만 로컬 등록 계약에 매핑한다.
- [ExecutionRuntime.execute](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:231)는 abort로 호출자 대기를 끝내도 진행 중 promise를 `pending`으로 보존하며 늦은 응답을 receive 경로로 보낸다. MCP adapter의 취소 notification 전송, SDK promise rejection, child 종료는 서로 다른 사실이다. 어느 하나만으로 실제 원격 효과가 취소됐다고 표시하지 않는다.
- `receive:${attemptId}`와 기존 artifact 저장·CAS는 응답을 정본화하고, adoption은 당시 goal/policy/deadline·원본/효과 검사를 별도로 수행한다. MCP 응답 원본과 정규화한 결과의 출처를 유지하며, 저장된 응답 채택을 위해 MCP 호출을 다시 실행하지 않는다.
- [recover](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:421)는 미호출 reserved 예약만 반환하고, 만료된 running write는 unknown과 대조 의무를 남긴다. adapter 진입 횟수, 실제 protocol 전송 횟수, 서버 handler 진입/효과 횟수를 나눠야 한다. SDK 또는 transport가 소비되지 않았음을 입증하지 못하는 전송은 미호출로 낮추지 않는다.
- `ExecutionJoin`, 조회 결과 재사용 및 read-collection checkpoint는 기존 의미를 유지한다. 한 caller의 abort가 다른 waiter를 자동 취소하지 않으며, 재시작 뒤 메모리 request map을 근거로 자동 재전송하지 않는다. 서버의 수집 cursor는 SDK의 응답 목록과 별개로 고정 query/snapshot/contract/lifecycle 및 전체 call budget에 연결해야 한다.

## 필수 로컬 시험 행렬

상태·영수증·예산·adoption·재시작 사례는 SQLite와 file-journal에서 같은 실제 runtime/adapter를 사용한다. 순수 parser와 child transport 수명 시험은 별도 단위로 집계할 수 있다. 아래는 시험군이며 아직 실행된 시험 수가 아니다.

| 군 | 로컬 trigger | 반드시 확인할 결과 |
|---|---|---|
| 1. 초기 연결/소유 | 정상 initialize, 미지원 version/capability, handshake timeout, 잘못된 fixture 실행 경로 | 협상 성공 전 tool call 0. 실패 시 소유 child 정리. 모델 입력이 command/args/env/CWD를 고르지 못함. 환경에 사내 키를 복사하거나 출력하지 않음. |
| 2. 계약/권한 변화 | reserve 뒤 같은 이름의 schema/effect/version 변경, 허용 label/scope 철회 | 실제 요청 전송 0 또는 명시된 경계 이후 unknown. catalog snapshot의 옛 설명으로 새 계약을 실행하지 않음. annotation만으로 write→read 완화하지 않음. |
| 3. 페이지/부분 응답 | 두 페이지, empty advancing page, cursor loop, snapshot 변화, partial/error items | accepted 원응답/범위를 유지하고 완료와 구분. 허용한 read-resume가 없다면 해당 기능은 미지원으로 명시. reconnect로 전체 page/call 상한과 원 deadline을 초기화하지 않음. |
| 4. 전송 전 취소 | 예약 후·transport write 전 abort 또는 child 초기화 실패 | 서버 handler/효과 0. durable 예약/논리 사용량은 실제 runtime 단계와 일치. 전송 여부를 입증할 수 없는 SDK 경계는 보수적으로 분류. |
| 5. 전송 뒤 취소 | 서버 handler 대기 중 abort; fixture가 취소 notification을 무시하고 나중에 적용 | 취소 알림 송신은 취소 완료가 아님. write unknown/의무 유지, 같은 입력 자동 재시도 0. read도 empty success가 아닌 interrupted/partial/error로 구분. |
| 6. 늦은 결과/변경 | 대기 중 pause/cancel/goal/policy/deadline 변경 후 응답 | 원 응답과 실제 알려진 사용량은 보존 가능하지만 새 goal의 근거로 채택하지 않음. late success가 cancelled 상태를 ready/completed로 되살리지 않음. |
| 7. 프로세스 중단 | committed dispatch 후 응답 전 소유 서버 SIGKILL; runtime 자체 SIGKILL 후 새 owner reopen | receipt 없이 결과를 만들지 않음. write는 unknown, read는 기존 복구 규칙. old request ID/old process epoch의 늦은 메시지를 새 호출에 붙이지 않음. 명시 새 attempt 외 자동 재전송 0. |
| 8. 응답 저장 후 중단 | 원응답 artifact+receive CAS 후 adoption 전 runtime 종료 | 새 process에서 저장된 원본을 채택하며 MCP 전송/handler/효과 증가 0. 원본 유실/변조 또는 권한 철회 시 fail closed. |
| 9. 중복/합류 | 같은 attempt 동시 caller, 같은 response ID 중복, 응답 commit ACK 유실 | 논리 결과/예산/효과를 중복 계수하지 않음. 최초 authoritative result와 receipt 유지. 다른 waiter의 abort는 shared physical 실행 중단으로 해석하지 않음. |
| 10. protocol byte 상한 | 상한 직전/정확히/초과 프레임, 여러 조각으로 온 미완성 프레임, 큰 stderr/progress 연속 메시지 | UTF-8 raw byte를 decode/JSON/schema 전에 제한. 입력·출력·누적 버퍼·stderr tail·notification queue의 각각과 합계가 유한함. 상한 초과 후 도구 결과/원본을 완전한 것처럼 만들지 않으며 타이머/요청 map/소유 child가 정리됨. |
| 11. 오류/재시도 | malformed JSON, unknown/duplicate request ID, 잘못된 result schema, tool-level error, rate limit/backoff | protocol 오류·tool 오류·관측 없음의 의미를 분리. wait/retry는 원 budget/deadline 안에서 명시적으로 수행. `Retry-After` 유사 입력이나 progress notification으로 무한 대기/재시도하지 않음. |
| 12. 종료/자원 | idle·요청 진행 중·초기화 실패 중 close, 동시 close, SIGTERM 무시 fixture | close 완료는 실제 owned process exit까지 확인하고 필요 시 유한 grace 뒤 owned child만 종료. 여러 close caller가 동일 종료 완료를 관측. stdout/stderr reader·timer·listener·in-flight map 정리. 다른 작업/사용자의 프로세스는 건드리지 않음. |

process-kill 시험은 harness가 생성하여 PID/handle을 보유한 child에만 수행한다. 출력이 일정 크기가 되거나 입력 적용 marker가 저장되는 barrier로 종료 지점을 고정하고, 임의 sleep만으로 "전송 전/후"를 추정하지 않는다. stdio stream에 write가 수락되었거나 전송 여부가 불명확하면 실제 handler가 아직 확인되지 않았더라도 효과 없음의 증거가 아니다.

## protocol 비용·메모리 상한의 판정 기준

- SDK의 완성된 result 객체에 `JSON.stringify(...).length`를 재는 것만으로 raw transport buffer를 제한했다고 주장하면 안 된다. byte 제한은 SDK가 큰 본문을 모으기 전에 작동하는지 확인한다. JS 문자열 길이와 UTF-8 byte 길이도 구분한다.
- 단일 응답 cap만으로는 progress/notification·동시 request·stderr의 전체 메모리 상한이 되지 않는다. 첫 단위에서 허용한 동시성, frame, request, 전체 transport lifetime의 상한을 숫자로 확정하고 그 값의 경계만 시험한다. SDK 자체 한계와 adapter에서 추가한 한계를 분리한다.
- 초과 본문은 임의로 전체를 계속 drain·해시·저장하지 않는다. bounded 진단 prefix/관측 byte 수/잘림 여부만 보존한 경우 원본 전체 확보로 기록하지 않는다. stderr에는 원자료/키가 섞일 수 있으므로 기본 공개 결과에 그대로 붙이지 않는다.
- 논리 tool attempt, protocol request/notification, 서버 handler 진입, 실제 로컬 효과, 송수신 byte, image byte, wait 시간은 서로 다른 분모다. 미확인 비용을 0으로 바꾸지 않는다. handshake/catalog 비용과 본 호출 비용도 구분한다.

## 이번 완료 표현과 다음 기록

실제 SDK client/server와 소유한 **로컬 stdio fixture**를 통해 protocol 및 runtime 계약을 통과하면 그 범위의 로컬 adapter 진전으로 기록할 수 있다. localhost HTTP까지 구현했다면 별도 transport 관측을 추가한다. stdio 통과를 HTTP auth/session, 실제 기존 사내 MCP의 기능/권한, Knox, G-DATA, 운영 배포의 완료로 확대하지 않는다.

P3-01의 전체 acceptance에는 실제 MCP 명세·전용 환경과 접근 범위가 남을 수 있다. 따라서 전체 재설계 완료를 주장하지 않으며, 실제 범위를 확정한 후에만 작업 목록의 로컬 상태와 새 helper를 정한다. 이전 1,950은 당시 전체 기본 검증 수이고, 새 protocol fixture의 별도 실행 수를 무조건 더하지 않는다.

새 최종 기록은 이전 정본 body hash, 기존 고정 log/artifact hash, 원본 1,973개, 의도한 package/lock delta, exact SDK/협상 version, source/build stamp, 전체 npm 검증, 실제 stdio/종료/복구 로그, 제한된 비용 계측 및 미실행 범위를 각각 보존해야 한다.
