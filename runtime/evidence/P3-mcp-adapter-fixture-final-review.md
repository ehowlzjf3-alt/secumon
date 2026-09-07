# P3-01 MCP 합성 fixture·읽기 연결 최종 검토

2026-09-06. 저장된 제품·시험·fixture source와 최종 관련 실행 로그를 읽고 대조했다. 이 검토에서는 제품·시험·dist를 수정하거나 typecheck/build/시험/서버를 실행하지 않았다. 새 확정 제품 결함은 확인하지 못했다. 진행 중인 전체 verify의 성공 여부는 이 문서에서 판정하지 않는다.

범위: [MCP read wrapper](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-tools.ts), [read 통합 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/mcp-read-tools.test.ts), [client 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/mcp-stdio-client.test.ts), [공유 계약](/Users/seunghanee/Documents/secumon/runtime/src/tests/helpers/mcp-fixture-contracts.ts), [서버 fixture](/Users/seunghanee/Documents/secumon/runtime/src/tests/helpers/mcp-fixture-server.ts), [챕터 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-adapter-plan.md).

## 최종 관련 실행 기록

[targeted-final-v2.log](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-targeted-final-v2.log)의 끝에서 **58개 통과, 실패·취소·건너뜀 0**을 확인했다. 구성은 MCP read 28개, client 14개, 기존 Broker 경계 16개다. 이것은 관련 시험 합계이며 신규 시험 수나 전체 runtime 시험 수가 아니다. SDK client/server의 [package.json](/Users/seunghanee/Documents/secumon/runtime/package.json) pin은 모두 `2.0.0`이다.

## fixture와 근거 변환

- 두 도구는 `documents.read`, `observations.read`이며 strict `{id}`만 받는다. 고정 enum으로 정상·부분·오류·잘못된 출력·지연·종료·크기 초과를 선택한다. 파일 경로나 임의 프로세스·URL은 도구 입력에 없다. audit 경로와 목록 fault는 호스트 argv로만 지정한다.
- 응답은 `id/source/observedAt/value/complete`의 작은 자료 계약이다. source는 각각 `doc-origin`, `observation-origin`, 시각은 900, 값은 30과 1이다. 서버가 Evidence나 정책·완료 명령을 반환하지 않는다.
- 호스트 mapper는 요청 id, 고정 source·시각을 확인한 뒤 `value` 하나를 사실로 옮긴다. tenant/scope/labels/artifact/accepted 상태는 호스트가 부여한다. 문서·관측 의미는 fixture binding에 있고 범용 실행 코어에 추가되지 않았다.
- 부분 응답은 ToolResult와 Evidence 모두 partial이다. 초기 목표의 `requireCompleteCoverage:true`가 보존되므로 실제 완료 판정 함수가 false를 반환한다. 오류와 출력 schema 위반은 결과의 evidence/artifacts가 빈 배열이며, 진단용 원본 envelope는 work.artifacts에 따로 남는다. 원본 보존을 성공 근거로 오인하지 않는 시험이다.
- 같은 source를 재조회하면 attempt별 Evidence id는 달라지지만 lineageId는 유지된다. 두 근거가 생겨도 두 독립 출처 조건은 충족하지 않는 회귀가 두 저장소에서 존재한다. 이는 이 mapper의 고정 원출처 계약을 확인한 것이며 임의 사내 출처의 독립성을 자동 판정했다는 뜻은 아니다.

## 원본 proof와 조회·채택

보존한 원본은 **SDK가 decode한 응답 JSON과 호스트 envelope**다. wire의 공백·순서·프레이밍을 보존한 packet capture가 아니다. SDK가 검증 후 제거한 `resultType:'complete'`의 부재를 wrapper가 허용하는 동작은 direct client 시험과 맞는다. 명시된 다른 discriminator는 계속 거절한다.

readProof는 dispatch/intent/response receipt, 현재 artifact index와 공개 가능 상태, byteLength/SHA256, work/attempt/task/contract/binding/goal/policy/generation, envelope 시각 및 labels를 확인한다. 같은 호스트 mapper로 결과를 재생성해 비교한다. 변조한 사실, 다른 attempt 대입, 원본 blob 손상이 거절되는 시험이 있으며 실패 결과는 채택해도 근거가 추가되지 않는다. 손상된 원본 때문에 adopt가 `artifact_unavailable`로 거절되는 것은 복구 성공이 아니다.

proof 검사는 서버 재호출을 필요로 하지 않는다. 호스트 mapper 코드의 의미가 바뀌면 projectorVersion을 올려야 하는 신뢰 계약은 남는다. 원본 hash와 schema만으로 임의 mapper 코드의 의미까지 증명한다고 표현하지 않는다.

## 호출 권한과 중복 방지

intent는 호출 전에 저장되고 같은 attempt의 두 번째 invoke는 거절된다. client의 최종 전송 authorize와 wrapper의 응답 후 authorize가 별도다. adapter 대기 중 pause/정책 확대는 입력 전 차단되며, 실제 reply 이후 cancel/label 축소는 원본 response 게시와 근거 채택을 차단하는 시험이 있다. 후자는 원격 조회 자체가 없었다는 뜻이 아니며 실제 call 수 1을 확인한다.

목록 페이지·중복 이름·schema 불일치·반복 cursor·알림을 호스트 승인 manifest 및 connection generation과 대조한다. 전체 목록을 확인하고 승인한 subset만 게시하는 로컬 동작이다. 원격에서 목록이 원자적으로 고정되었거나 알림 없는 원격 계약 변경까지 탐지한다는 주장은 하지 않는다.

SDK cache와 input-required 자동 충족은 꺼져 있고 동일 call의 숨은 재전송도 막는다. 현재 실제 fixture 회귀가 보여 주는 것은 시험한 정상·오류·취소·재연결 경로의 호출 수다. 실제 `input_required` 응답을 발생시키는 fixture는 없으므로 그 전체 대화 교환까지 시험했다고 확대하지 않는다.

## 재개·지연·운영 범위의 정확한 표현

1. `reopen`은 **같은 Node 시험 프로세스**에서 SQLite/file journal 저장소와 ExecutionRuntime을 다시 연다. 서버를 끄고 저장 결과를 채택하며 새 ToolContracts/adapter도 한 차례 구성해 proof를 재검증한다. 부모 worker 전체 프로세스 재시작, registry의 자동 복원, SIGKILL 또는 전원 장애 시험은 아니다.
2. crash fixture는 소유 서버 프로세스의 `process.exit(23)`이다. 명시적 discover가 새 프로세스와 새 session generation을 만들고 과거 session은 재사용하지 않는 것을 확인한다. 운영 서버 가용성이나 원격 쓰기 복구 영수증은 범위 밖이다.
3. 최종 delayedReply audit는 `handler-ready` → `response-delayed` → cancel → close이며 `response-sent`가 없다. **서버 함수가 끝난 뒤 응답 전송을 보류한 상태에서 취소·연결 종료**를 관측했다. 늦은 응답이 클라이언트에 실제 도착했다거나 원격 효과가 취소되었다고 표현하면 안 된다. [recovery-final.json](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-recovery-final.json)은 이 차이와 같은 프로세스 reopen을 명시하고 있다.
4. [protocol-final.json](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-protocol-final.json)의 두 업무군 × 두 저장소 정상 4셀은 각각 논리 도구 1회·MCP 도구 1회·모델 0회다. handshake/구독/목록까지 포함한 요청 수, 직렬화 요청 bytes, decode된 목록·응답 bytes는 서로 다른 측정량이다. 지연 분포·모델 품질·전체 workflow 완료의 비교 자료가 아니다.
5. 이번 소단위는 로컬 stdio의 단발 읽기 연결이다. ReadCollections page/resume, 자동 rate-limit cooldown, HTTP/OAuth, 사내 인증·MCP·Knox, 쓰기 도구, 실제 모델/API·운영 자료는 구현·검증 범위에 추가되지 않았다. stdio 자식 프로세스 실행은 OS 보안 sandbox를 제공한다는 뜻이 아니다.

현재 계획과 최종 protocol/recovery JSON의 범위 표시는 위 구분에 부합한다. 기존 넓은 [fixture 제안서](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-fixture-review.md)의 collections·rate-limit 제안은 이후 소단위 설계이며 이번 구현 완료 목록에 합산하면 안 된다.
