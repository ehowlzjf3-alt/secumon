# P0 재사용과 외부 계약

원본 정적 선언 160개는 테스트 40개와 비테스트 후보 120개(114개 이름)다. 전체 후보를 옮기지 않고 첫 업무에 필요한 책임만 선택한다. 숫자는 실행 중 등록 수가 아니다. 원본은 [카탈로그 검토](/Users/seunghanee/Documents/secumon/design/tool-catalog-review.json)를 유지한다.

| 첫 필요 | 원본에서 확인한 근거 | 결정/적용 시점 |
|---|---|---|
| 도구 등록/검색 | `agent/tools/registry.py`: 중복 이름 거부, base/deferred 정렬, 제한된 검색 | 등록/정확한 선택/짧은 카드 규칙 재사용. provider/id/version·권한 view는 새 포트로 구현. P1-04/P2-04 |
| 선택적 명세 로딩 | `tool_search_tool.py`: select:NAME, max_results, context.unlocked_tools | 정확한 선택·상한 의미 재사용. 영구 unlock 대신 현재 의무/수명에 맞춘 활성 명세 관리. P1-04/P2-03 |
| 근거 읽기 | `read_extract.py`: 구조화 신호와 원본 행 번호 연결 | 원본 위치를 잃지 않는 출력 원칙 재사용. package/install_trace 전용 tool 자체는 범용 코어에 넣지 않음. 첫 도구는 합성 fixture.read, 후속 artifact.read |
| 업무 간 기억 | `memory_tool.py`: state.memory_search/get/add/delete/touch 직접 호출 | 개인/범위·조회/정정 동작을 참고하고 저장소 독립 포트로 구현. 기존 DB 연동 코드를 코어에 이식하지 않음. P2-02 |
| 브라우저 조작 | `browser_tool.py`: browser_session/action/query/supervisor와 ToolContext | 관찰/행동/확인·참조 ID를 참고. 실제 driver/OS 요구 확인 후 재사용 또는 TS adapter 결정. P3-04 |
| 상태 포트 | 기존 persistence/port.py는 SQL connection/DDL/finding 포함 | 교체 경계의 목적을 유지하고 새 범용 commit/event/outbox 포트 작성. P0/P1 |
| 지침 | 기존 skill 중심 업무 흐름 | 첫 지침은 합성 두 업무에 공통인 ‘근거 먼저 확인/반증 보존/모르는 범위 표시’로 정의. 실행/권한 자체를 skill에 맡기지 않음. P1-04 |

복사한 Python 런타임 코드는 없다. 필요한 동작/계약/출처 연결을 재사용하는 판단이며 전체 도구 이식 완료를 의미하지 않는다. 선택 도구의 실제 adapter 구현/시험 결과는 해당 작업에서 별도로 기록한다.

## 외부 계약 확인표

| 대상 | 현재 확인 | 필요한 정보 | 코어 진행용 대역 |
|---|---|---|---|
| SIEM/EDR·자산 MCP | 사용자 설명상 존재, 이번 archive 밖 | transport/endpoint, tools/list·입출력 schema, auth handle, scope/tenant, pagination·rate limit·cancel·부분 오류·cursor | 합성 관측과 scripted read 결과 |
| Knox MCP | 사용자 설명상 존재, 명세 없음 | 수신 이벤트 방식, 사람/방 identity, message ID, idempotency/조회 대조, 발송 결과/오류, 실제 지원 UI | 로컬 message sink/outbox fixture |
| 사내 모델 | 모델/endpoint 미지정 | API 형식·model ID·capability·인증 참조·자료 목적지·한도 | scripted planner; 실제 추론 품질은 미검증 |
| 컴퓨터 유즈 | 첫 OS/앱 미지정 | 브라우저/데스크톱 범위, 세션/사용자 인계, 관측/행동/확인 계약 | 로컬 합성 UI 후보 |
| 실제 데이터 경계 | 원문 차단 대안 비교 후 결정 | 등급·주체/목적지·보존/삭제와 원문 공개 방식 | synthetic/public label과 별도 tenant fixture |

실제 연동 정보를 비동기 질문으로 요청했다. 미확인 항목을 구현 완료/연동 통과로 보고하지 않는다. API 키 탐색/이전 연결 시험은 재개하지 않는다.
