# C05 — MCP 서버 없는 일반 재개 구현 계획

<!-- C05-MCP-OFFLINE-FINAL-PROOF: 28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9 -->
**MCP 서버 없는 일반 재개와 명시 온라인 재열기**를 연결했다. 신뢰된 시작 프로그램이 저장 전용 모드를 명시하면 MCP 서버를 시작하거나 발견하지 않고 같은 담당의 저장 응답과 영수증을 검증해 일반 CLI·Web에서 재개한다. 새 읽기가 필요하면 연결을 기다리고, 같은 담당을 온라인으로 다시 열어 기존 목표를 이어 실행한다. **macOS Node24 신규 145/145·관련 847/847, NAS Linux Node24 신규 145/145·관련 847/847·전체 3,601/3,601 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [저장 전용 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-usage.md) · [MCP 호스트 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json). 저장 계약과 새 호출 가능성을 구분하며 원문·현재 권한·목표·출처 검사는 유지한다. raw 파일만 있거나 intent 영수증만 있으면 응답 영수증을 만들거나 재전송하지 않는다. 보관·사용량 정산 성공은 본문 채택이나 업무 완료의 허가가 아니다. 자동 연결 실패 fallback과 모델까지 포함한 무네트워크 실행을 뜻하지 않는다. 다음 후보는 collection(여러 항목 수집)·페이지·대기의 일반 입구 연결이다. 검토 메모를 준비했으며 제품은 미착수다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도 측정·인수한다. [후속 연결 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-notes.md) · [전체 MCP 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

C01 SQLite/file-journal에서 실제 로컬 stdio peer를 닫은 뒤 별도 CLI 자식 프로세스 2사례와 실제 localhost HTTP 4사례를 확인했다. HTTP는 저장 응답 복구·재열기와 미호출 작업의 연결 대기→명시 온라인 재열기를 각각 두 저장 방식에서 확인했다. 온라인 전환은 원 work/session/goal/plan/task를 보존하고 tools/call 한 번으로 완료하며, 같은 명령 재전송은 추가 호출·정산·답변을 만들지 않는다. 실제 브라우저 렌더링 시험은 아니다.

연결 대기는 새 예약·논리 호출을 소비하지 않는다. 기존 미송신 예약은 원 owner·lease까지 유지하고 만료 회수를 우선한다. 실제 송신한 실패를 reservation_expired/cancelled 문자열만으로 시도 수에서 빼지 않는 경계도 이번 인수에 포함했다.

아래의 구현 예정·미수정 표시는 착수 당시 계획이다. 최종 현재 동작은 [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-result.md)와 [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-usage.md)을 따른다.

## 착수 당시 계획과 인수 항목

2026-09-07 · **구현 진행 중, 이번 변경 검증 전.** 선행 보관·정산 단위는 로컬 신규121/관련775와 NAS Linux 전체3544·필수8단계를 통과했다. 원로그 회수·SSH 정리·확정 증거·v0.65 안내 갱신을 마친 checkpoint318 이후 이 단위를 시작했다. 선행 증거와 원로그는 보존한다. [현재 사용법 초안](C05-mcp-offline-resume-usage.md)·[읽기 검토 메모](C05-mcp-offline-resume-notes.md)·[MCP 후속 순서](C05-mcp-host-plan.md)·[현재 보관 결과](C05-mcp-sent-authority-result.md)를 참고한다.

서버 연결이 없어도 같은 담당의 이력·저장 응답을 읽고, 검증 가능한 결과와 사용량을 이어 처리한다. 새 자료가 필요하면 연결을 기다리되, 다른 실행 가능한 독립 작업은 진행할 수 있어야 한다. 실제 모델/API 시험 중단과 기존 담당·세션 격리를 유지한다.

## 재사용과 변경 범위

| 그대로 재사용 | 이번에 추가하거나 연결할 것 |
|---|---|
| C01 stores, agent/session/work ID, 현재 호스트 정책 | 신뢰된 호스트가 명시하는 `stored_only` 시작 방식 |
| MCP 원 envelope·dispatch/intent/response, 원문 SHA와 binding 지문 | 실제 연결 세션 없이 같은 증명 코드를 조립하는 reader |
| `restoreUsage`, `restoreResult`, 수신·채택·정산·compact·문맥 복원 | 현재 실행 가능성과 저장 계약의 구분 |
| 기존 도구 등록·provider 교체·카탈로그·입력 프레임 | 새 호출 목록 필터와 예약/송신 직전 검사 |
| 기존 CLI/Web 입구, 기다림 제어와 소유·만료 규칙 | `connection_required`가 최종 CLI/Web 결과까지 유지되는 연결 |

새 DB·카탈로그·복구 장부·공개 권한 입력을 만들지 않는다. 연결 실패를 숨기는 자동 fallback도 추가하지 않는다. 실제 서버가 끊길 것을 예측하는 기능은 아니며, 호스트가 저장 전용으로 연 상태에서 새 호출을 막는 기능이다.

## 저장 응답 reader와 호스트 구성

`mcp-read-tools.ts`의 공통 factory를 내부적으로 분리한다. 기존 `createMcpReadTool(binding, session, client, services, schemas)` 공개 호출은 유지하고, `createMcpStoredReadTool(binding, origin, services, schemas)`를 추가한다. `origin`은 endpointId와 protocolVersion만 가지며 가짜 generation/discoveryDigest를 만들지 않는다. 원 generation/discoveryDigest는 기존 원문과 intent 영수증에서 검증한다.

두 factory는 동일한 definition, bindingDigest, 버전 suffix, 원문·정산·결과 검사와 projector를 공유한다. 실제 session/client는 온라인 실행 부분에만 전달한다. 저장 전용 execute는 방어적으로 어떤 기록도 쓰기 전에 거절하지만, 이것만을 새 호출 차단으로 삼지는 않는다. 현재 protocol 상수는 한 정의를 양쪽에서 사용하고, 저장 전용 origin은 strict 검증한다. 과거 온라인 factory의 입력 계약을 이유 없이 강화하지 않는다.

`McpHostToolsOptions`는 기존 `{mode?: 'online', config}`와 새 `{mode: 'stored_only', origin}`을 구분한다. 저장 전용은 현재 호스트가 등록한 binding을 고정해 기존 static tools 입구로 반환한다. MCP client를 생성하지 않고 providerSources도 만들지 않는다. 온라인 discovery/source 경로는 유지한다. 서로 모순되는 mode/config/origin 조합을 거절한다. 저장된 과거 도구를 원문이나 모델 입력에서 임의로 다시 등록하지 않는다.

close는 기존 프로필·실행기의 종료 책임을 유지한다. 저장 reader가 C01 stores를 별도로 소유하거나 닫지 않고, 호스트 신호가 취소됐다는 이유만으로 이미 받은 응답의 정산 마무리를 끊지 않는다.

## 저장 계약과 현재 호출 가능성

`Tool.availability?: 'available' | 'stored_only'`를 definition 밖의 호스트 메타데이터로 추가한다. 생략은 기존 동작이다. `snapshotTool`이 검증·고정하고 이후 변경은 기존 등록/provider 교체 경로를 사용한다. 이 값은 원 도구 지문·버전이나 저장 형식에 넣지 않는다.

`ToolContracts.get/check/visible`은 기존 의미를 유지한다. 특히 visible은 복원용 계약 지문에도 쓰인다. 새 `checkExecution(task, policy)`는 기존 계약·권한 검사 뒤 저장 전용에 `tool_connection_required`를 반환하고, `callable(policy)`는 현재 새 호출이 가능한 정의만 반환한다. 과거 응답의 검증은 callable 여부 때문에 무효화하지 않는다.

Catalog 검색과 모델의 `options.tools`·활성 도구 ID는 callable 목록을 사용한다. 정확한 도구 설명 요청은 기존 권한 검사 후 연결 필요를 알려준다. 권한 없는 도구의 존재를 추가 공개하지 않는다. Compiler의 frontier에는 성공한 의존 작업도 포함되므로 전체 frontier를 실행 가능성으로 거절하지 않는다. 과거 작업·결과·출처 계약은 남기고 새 호출 후보만 제외한다.

## 제어 흐름과 송신 경합

Application `decideExecution`에서 실제 새 reserve 후보와 미송신 reserved→dispatch에 실행 가능성 검사를 연결한다. 기존 task allocation gate의 대기 합성을 재사용해 연결이 필요한 작업을 건너뛰고 다른 준비된 작업을 선택한다. 이미 received인 결과의 adopt와 만료 시도의 recover, 원 사용량 정산을 먼저 유지한다.

연결 필요는 기존 `wait` 제어의 `connection_required` 사유로 표현한다. 일반 오류 gate는 예약을 실패 처리하므로 그대로 사용하지 않는다. 이미 존재하는 예약의 owner·lease를 바꾸지 않으며 기존 만료·반환 처리가 막히지 않도록 한다. 기존 한 작업 안의 활성 시도 제약을 유지하므로 미송신 예약이 있으면 그 lease/deadline에 깨어나 회수한다. 활성 예약이 없는 준비 작업 목록에서는 연결이 없는 후보를 건너뛰고 독립 작업을 선택한다. 새 예약과 논리 호출 사용량은 증가하지 않는다. 온라인으로 명시적으로 다시 열었을 때 기존 목표·출처·권한을 재검증하고 이어갈 수 있어야 한다.

Runtime reserve/dispatch의 최초 검사·트랜잭션 편집·게시 직전 검사와 Broker의 최초/최종 선택·일반 authorize에서 현재 실행 가능성을 확인한다. **이미 송신한 응답의 custody permit에는 이 검사를 넣지 않는다.** 실행 가능성이 사라졌다고 실제 호출의 정산을 소급 취소하지 않는다.

Planning의 송신용 검사와 받은 응답의 검사를 구분한다. 저장된 `options.tools`를 현재 callable 정의와 대조하는 검사는 모델 예약 게시 전·dispatch 차감 전·transport 직전에 적용한다. 기존 `definitionsCurrent`는 받은 응답과 생성 답변 검증에도 쓰이므로 의미를 일괄 변경하지 않는다. `inspectNext` cache는 도구 등록 revision의 변경을 감지하고 materialize 때 재확인한다. 미송신 예약은 기존 취소·반환 경로를 쓰며 원 입력을 고쳐 쓰지 않는다.

Planning의 불필요한 자동 compact 앞과 Workflow의 최종 `finish` 계산에도 같은 제어 판정을 사용한다. 실행기만 wait를 반환하고 마지막 계산에서 다시 reserve로 덮이는 흐름을 허용하지 않는다. 필요한 원문·문맥 검증은 유지한다.

## 작은 구현 순서와 인수

1. availability 계약과 공통 실행 판정·송신 검사를 연결한다. 기존 catalog lifecycle, broker refresh, context inspection/dispatch와 모델 입력 프로필 시험을 확장한다. 동일 definition의 availability 교체, 비동기 게시 직전 교체, 이미 받은 응답 유지, 성공한 의존 작업과 실행 가능한 독립 작업을 확인한다.
2. 공통 MCP factory와 저장 전용 호스트 조립을 연결한다. 같은 binding의 definition/hash가 온라인과 같고 client 생성·peer 시작·initialize/list/call은 0인지 확인한다. 원문·영수증·현재 권한 검사를 그대로 실행한다.
3. 기존 C01 SQLite/file-journal과 CLI/localhost HTTP fixture를 확장한다. 온라인에서 실제 로컬 peer로 응답을 만든 뒤 peer 없는 새 프로세스/서버로 상태·이력·명시 run을 수행한다. raw-only/intent-only, 정상 response, 이미 received/정산/완료, 취소·권한 축소를 구분하고 원 ID·입력·원문·영수증·정산·답변을 중복하지 않는다.
4. 아직 읽지 않은 자료가 필요한 경우에는 새 MCP attempt/예약/논리 호출 증가 없이 최종 연결 대기를 반환한다. 온라인 명시 재개, 기존 예약의 만료, 별도 독립 작업 진행을 확인한다. 필요한 정상 모델/다른 도구 활동까지 0으로 만들었다고 확대하지 않는다.
5. 바뀐 projector/remote schema/endpoint/protocol, 제거된 binding, 같은 버전의 definition 변경, 다른 담당·손상·삭제 세대는 기존처럼 거절한다. 현재 계약에 없는 과거 reader를 자동 복원하지 않는다.
6. 최종 같은 소스의 신규·영향 회귀·빌드/코어/구조와 Linux 통합 검증을 수행한 뒤 결과·사용법·HTML을 갱신한다. 기존 검증을 다시 만든 것으로 세지 않는다. 실제 모델 의미 품질·사내 MCP/Knox·native Windows·PostgreSQL은 별도 구현/실기 항목으로 남긴다.

추가 확인 항목: 현재 domain/control의 시도 수 계산은 reservation_cancelled/expired 오류 문자열만으로 시도를 제외한다. 실제 전송한 도구가 같은 오류명을 반환해도 maxAttempts를 우회하지 않도록, 미송신 예약을 구분하는 기존 정산 보강과 일치시켜 검증한다. 이는 이번 연결 대기·예약 반환 인수에 포함할 대상이며 아직 수정하지 않았다.

정산 후보가 없는 업무의 중복 읽기와 전체 event 조회 비용은 [별도 계측 항목](C05-context-cost-review.md)에 저장했다. 이 구현에서 측정 없이 성능 개선을 주장하지 않는다. 단순 저장 응답의 서버 없는 일반 입구를 끝낸 뒤 페이지·대기의 일반 입구 연결로 이어간다.
