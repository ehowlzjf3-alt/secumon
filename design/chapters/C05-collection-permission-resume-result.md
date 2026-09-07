# C05 collection 권한 철회 뒤 일반 입구 재개 결과

2026-09-08 · checkpoint375. 실제 로컬 stdio 응답을 보관한 뒤 현재 본문 읽기 권한이 철회된 업무를 일반 CLI/HTTP에서 다시 열었다. **collection 입구 4개와 코어 권한 차단 6개가 10/10 통과**했고, CLI 제한 안내 신규 3개와 기존 CLI 8개·WorkView 28개가 **39/39 통과**했다. 두 실행은 build12의 같은 소스 `043b09e3878214c4731f5e9c5c4b5168bfb02599ae11246e817648f111c0a5c9`다. [입구·차단 원로그](../../runtime/evidence/C05-ordered-target18.log) · [CLI·WorkView 원로그](../../runtime/evidence/C05-ordered-target19.log) · [빌드 manifest](../../runtime/evidence/C05-ordered-build12-manifest.json) · [실행 기록](../../runtime/evidence/checkpoint375.json).

## 사용자에게 보이는 동작

CLI `status`는 정산이나 실행을 시작하지 않는다. `resume`은 만료된 원 collection attempt를 정리하고 알려진 전송 사용량을 한 번 기록한 뒤, 현재 도구 권한이 없으면 `blocked/tool_permission_denied`와 정상 `runtime_resume` checkpoint를 반환한다. 제한 안내는 같은 첫 재개에서 표시하며, 다시 실행해도 같은 제한과 원 정산을 유지한다. 모델 호출·질문·답변 생성은 없다. 정산 완료를 업무 완료로 표시하지 않는다.

HTTP의 view 조회도 무쓰기다. 명시 cancel은 원 전송 사용량을 한 번 정산하면서 `cancelled`를 유지한다. 서버를 닫고 다시 열어 같은 명령을 보내면 기존 명령 결과를 재사용하며, 원 사용자 요청이나 취소 입력을 중복 접수하지 않는다. 두 입구 모두 보호된 원문·가공 facts·raw/head 참조를 노출하지 않는다.

이 인수는 SQLite와 file-journal 각각에서 임시 담당·같은 임시 identity registry를 사용한다. 공개 요청은 처음부터 `labels=[]`로 접수했고, 신뢰된 fixture의 명시 권한 부여 후 실제 로컬 peer를 한 번 호출했다. 원응답 영수증 게시 뒤 권한을 축소해 페이지 투영 전에 거절되도록 했다. 원응답의 새 witness는 `returned/decoded_response`다. `captured` 실패나 늦은 수신 응답의 본문 복구 제한을 이 경우에 대신 적용하지 않는다.

원 peer를 종료한 뒤에는 `stored_only` 등록으로 CLI 새 프로세스와 loopback HTTP를 열었다. 전체 실제 `tools/call`은 1회, 이후 재전송·discovery는 0회이며 projector·새 모델 호출도 0회다. 원 raw bytes·head·dispatch/intent/response 영수증·owner·lease·task 입력·goal·plan은 보존한다. 만료 attempt의 `failed/lease_expired`를 성공으로 바꾸지 않고 result/page/evidence를 채택하지 않는다. [신규 fixture](../../runtime/src/tests/mcp-collection-custody-entry-fixture.ts) · [입구 시험](../../runtime/src/tests/mcp-collection-custody-entry.test.ts).

## 필요한 제품 교정

[ExecutionRuntime](../../runtime/src/application/execution-runtime.ts)의 기존 collection 복구는 만료 attempt를 실패로 정리한 뒤, 현재 권한으로 보이지 않는 진행 자료의 본문 복구를 생략했다. 그러나 업무를 `ready`로 남겨 다음 compact 입력 검사에서 권한 없는 frontier 도구를 필수로 요구했고, 정상 제어 결과 대신 `context_tool_unavailable` 오류가 났다.

새 검사는 기존 정리 뒤 현재 제어가 정확히 `replan/plan_cannot_complete_goal`일 때만 적용된다. 현재 plan·goal·scope·task 입력에 속하고 후속 attempt가 없는 마지막 collection의 `tool_permission_denied`를 확인해 업무 차단을 게시한다. 독립적으로 실행 가능한 작업, 오래된 task/goal, 이미 이어 읽은 부모, 취소·일시정지 상태는 덮지 않는다. 게시 직전 상태 revision·등록 객체·권한을 다시 확인하며, 원 attempt와 정산을 수정하지 않는다. [코어 회귀 6개](../../runtime/src/tests/stored-collection-permission-gate.test.ts).

차단 게시를 끝난 로컬 recovery 단계로 반환해 기존 workflow 정산·outbox 처리를 이어간다. 처음부터 terminal control을 반환해 제한 안내가 두 번째 재개까지 밀리던 문제도 고쳤다. [CLI view](../../runtime/src/presentation/agent-turn-cli.ts)는 기존 WorkView의 현재 공개 투영을 재사용하고, 같은 세션에 실제 전달된 현재 제한 안내만 표시한다. 옛 이유·세대의 안내를 현재 실패처럼 노출하지 않는다. 선택 안내를 읽는 중 `work_view_knowledge_changed`가 나면 상태만 유지하고, 접근 거절 등 다른 오류는 숨기지 않는다. 신규 CLI 회귀의 knowledge 변경은 실제 WorkView 읽기 성공 뒤 오류를 주입한 것이며 실제 원본 삭제 인수가 아니다. [CLI 회귀](../../runtime/src/tests/agent-turn-cli.test.ts).

## 실행별 근거와 실패 이력

| 실행 | 결과와 범위 |
| --- | --- |
| build6 / target12 | 빌드 통과. 입구 4개 모두 fixture의 오류 기대값에서 실패. 실제 권한 축소 오류는 `read_scope_changed`였다. |
| build7 / target13 | 입구 4개 모두 witness 위치 단언에서 실패. 실제 이벤트는 `data.payload.custody`를 사용한다. |
| build8 / target14 | HTTP 2개 통과, CLI 2개는 `context_tool_unavailable`로 실패. 제품 권한 차단 연결의 누락을 확인했다. |
| build9 / target15·16 | 코어 차단 6개와 HTTP 2개 통과. CLI 2개는 제한 안내가 뒤늦게 게시돼 실패. 관련 collection/custody·availability 5파일은 39/39 통과했다. |
| build10 / target17 | 빌드 통과. 차단 positive 1개 통과, CLI 2개는 view가 failure 안내를 제외해 실패했다. source `76ae56e0978d413093a8839ebd75fd5f0178af8313d325f8c75d6d552f585799`. |
| build11 | CLI 현재 제한 안내 투영 교정의 빌드 통과. source `8322ef191ac2289245d8f60e75bfc24eb5b113420475ca6792ff9560276ff005`. 이 빌드를 최종 입구 통과로 계산하지 않는다. |
| build12 / target18 | 최종 입구 4개 + 코어 차단 6개 **10/10**, session91839, exit0, 10,534.374875ms. |
| build12 / target19 | 신규 CLI 안내 3개 + 기존 CLI/WorkView 36개 **39/39**, session53136, exit0, 21,445.674625ms. |

원 실패 로그와 각 빌드 지문은 [checkpoint375](../../runtime/evidence/checkpoint375.json)에 보존한다. target15~17 재실행을 고유 시험 수에 더하지 않는다. 이전 C05 662개 + 원문 재사용 신규 7개 + 차단 6개 + 입구 4개 + CLI 안내 3개로 **선택 고유 682개 통과**다. 682개 전체를 build12에서 다시 실행한 결과는 아니다. 최종 관련 실행에는 실패·취소·skip이 없다.

같은 checkpoint에서 개인 기억 원문 검사 재사용 신규 7개와 기존 회귀 55개는 build6에서 62/62 통과했다. 단회 SQLite 계측의 `state.get`과 `session.input`은 각각 12→8회이며 이력 조회 4회와 마지막 현재성 검사는 유지했고, 기록한 결과 요약(본문 해시·revision·owner·size)이 같았다. 전체 반환 객체의 bytes가 동일하다는 뜻은 아니다. 반환 JSON bytes·공개 포트 횟수의 관측이고 시간·물리 I/O·모델 토큰 절감 주장이 아니다. [측정 비교](../../runtime/evidence/C05-source-read-comparison2.json) · [62개 원로그](../../runtime/evidence/C05-ordered-target11.log). C03 신규 복구 5개는 별도 집계하여 고유 243개이며 C05 수에 더하지 않는다. [C03 결과](C03-ordered-verification-result.md).

## 범위 밖

권한을 다시 부여한 뒤 일반 입구에서 끝까지 명시 재개하는 end-to-end 흐름은 **미검증**이다. 호스트 권한 확대만으로 저장된 work policy가 자동 변경되지는 않는다. 원 policy의 명시 재허용과 blocked 상태를 해제하는 재개 명령 뒤, 현재 권한·원 proof를 다시 통과해야 한다. 이번 차단은 `lease_expired`와 원 head를 보존하지만 그것만으로 재허용 후 완료를 입증하지 않는다. 코어의 게시 직전 재허용 경합 검증은 이 전체 흐름의 대체가 아니다.

target16에서 기존 collection/custody·availability 관련 39개를 재실행했다. 기존 complete successor·nonfinal·partial 부품과 중단·종료 인수가 권한 재허용 뒤 일반 입구 전체 완주를 대신하지는 않는다. 이번 환경은 macOS/arm64 Node v24.20.0, 임시 C01 stores·로컬 stdio·loopback HTTP다. 실제 모델/API·사용자 GUI·사내 서비스는 실행하지 않았으며 현재 Linux/native Windows·PostgreSQL·최종 통합 인수와 분리한다. 다음 순차 범위는 [C06 직접 Knox 입구·격리 설치·두 담당 배치](C06-ordered-verification-preparation.md)다.
