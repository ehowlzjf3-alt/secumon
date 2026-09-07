# 로컬 Web 컴퓨터 드라이버: 문서 폼 fixture 검토

작성일: 2026-09-06. 상태: 읽기 기반 설계 제안. 제품 구현·서버·브라우저·시험·비용 측정은 이번 검토에서 실행하지 않았다. 사내 자료, 실제 모델, 사내 API/MCP/Knox는 범위 밖이다.

권장 첫 범위는 **사람이 열어 볼 수 있는 로컬 문서 폼 하나와 고정된 타입 기반 드라이버**다. 범용 core의 ComputerDriver/ComputerCondition/continuation 계약을 재사용하고, Query/Note와 facts 매핑은 fixture 전용 adapter에 둔다. HTTP로 앱 상태만 바꾸는 시험과 실제 브라우저 DOM을 조작하는 시험을 구분한다.

## 현재 코드에서 확인한 기준

- [합성 드라이버](../src/infrastructure/synthetic-computer-driver.ts): 앱과 영수증을 같은 상태 파일에 기록하며, 입력 직전 권한 콜백 이후 lease/focus/view/target을 동기 검사한다. 실제 GUI나 네트워크 전송은 없다.
- [공통 포트](../src/application/computer-use-ports.ts), [입력 영수증](../src/domain/computer-operation.ts): act는 applied/not_applied/unknown, lookup은 exact identity의 found 또는 unknown이다. 영수증 부재가 not_applied 증명은 아니다.
- [기존 비용 스크립트](P3-computer-use-cost.mjs): 동일 Save 목표의 batched/separate, SQLite/file-journal 4개 셀. fill만으로는 evidence가 없고, Save 조건을 새로 관찰한 후에만 완료한다. 이전 측정은 합성 관찰이며 새 Web 측정의 대조군 수치로 그대로 재사용할 수 없다.
- [드라이버 시험](../src/tests/synthetic-computer-driver.test.ts), [영수증 시험](../src/tests/synthetic-computer-receipts.test.ts): focus/rerender, 늦은 readiness, 입력 전 권한 철회, 원래 operation의 영수증 조회, bounded ledger를 다룬다.
- [입력 복구](../src/tests/computer-use-recovery.test.ts), [영수증 SIGKILL](../src/tests/computer-operation-recovery.test.ts), [continuation SIGKILL](../src/tests/computer-continuation-recovery.test.ts): 저장 전후 경계를 구분하며, 이미 적용된 입력은 재실행하지 않는다. 이 합성 시험의 성공을 Web 드라이버의 성공으로 간주하지 않는다.

## 최소 앱 상태와 화면

| 항목 | 원본과 맞출 의미 | 실제 화면/관찰 |
| --- | --- | --- |
| Query | 문자열, 최대 8192자. fill하면 resultsReady=false이며 이전 검색 완료 예약 취소. 같은 값으로 다시 fill해도 취소 | 명시 label이 있는 textbox, 현재 value 관찰 |
| Search | 현재 query의 검색을 시작. delay=0이면 즉시 ready, 양수면 나중에 ready | 이름이 유일한 button. 로딩/검색 완료 상태는 같은 위치에서 갱신 |
| Note | 문자열, 최대 8192자. 수정만으로 savedNote는 변하지 않음 | label이 있는 textarea/textbox, 현재 value 관찰 |
| Save | 현재 Note를 savedNote로 복사하고 saveCount를 1 증가. 빈 값도 원본처럼 허용하며 검색을 선행 조건으로 추가하지 않음 | 이름이 유일한 button. 저장된 값과 횟수를 별도 output에 표시 |
| resultsReady | 현재 검색 세대가 완료했을 때 true. 오래된 검색이나 이전 document/epoch의 응답은 현재 상태를 덮지 못함 | 화면에 표시한 boolean 상태와 fixture adapter의 fact가 일치 |
| savedNote | 마지막으로 저장 확정된 Note 값 | textarea의 임시 값과 다른, 명시적인 저장 결과 영역 |
| saveCount | 각 적용된 Save마다 증가. 같은 텍스트라는 이유로 합치지 않음 | 표시 값과 저장 정본을 함께 검증 |
| inputCount | 합성 기준으로 적용된 fill/click operation 수. 대조군은 Note fill+Save로 2 | 모델 관찰 facts에 자동 추가하지 않는 호스트 진단 수치. Web의 raw DOM event 수와 별도 |

기본 초기값은 빈 Query/Note/savedNote, false resultsReady, 두 count=0이다. 새 대조 셀마다 새 디렉터리와 새 fixture instance를 사용한다. 화면에는 `로컬 실습용 문서 앱 · 생성한 자료 · 실제 모델 미연결`을 표시한다. 기본 비용 목표에는 Search를 몰래 추가하지 않는다. 검색/지연은 별도 기능 시나리오다.

관찰 가능한 4개 요소의 role/name은 기존 테스트와 동일한 textbox/Query, button/Search, textbox/Note, button/Save로 고정할 수 있다. 한글 설명을 함께 제공하되 accessible name과 selector 계약을 혼동하지 않는다. 버튼 type과 submit 처리를 명시하여 폼 기본 동작이 의도하지 않은 두 번째 Save를 만들지 않게 한다. 결과 문자열은 textContent/value로 렌더하고 HTML로 해석하지 않는다.

최소 fixture 데이터는 앱 상태, 영속 epoch, 영수증 집합이다. 현재 document/surface, viewRevision/focusRevision, element ref, live lease와 fence는 드라이버/세션 계층의 메타데이터다. 재시작 후 문서와 lease는 새로 만들고 앱/영수증은 보존한다. UI가 각 페이지에서 lease를 독립 발급해서 두 소유자가 생기지 않게 단일 fixture session owner를 둔다. 다른 fixture instance나 프로세스까지 전역 잠금을 보장했다고 확대하지 않는다.

## 실제 관찰과 마지막 입력 검사

1. 드라이버 observe는 실제 브라우저의 현재 DOM에서 요소·값·visible/enabled를 읽는다. fixture 서버의 JSON만 읽어서 DOM 관찰이라고 부르지 않는다. savedNote 등의 facts는 화면 출력에서 읽거나, fixture 전용 정본 projection으로 읽었다면 그 경로를 별도 기록한다.
2. ref는 현재 document/surface의 실제 요소 identity에 묶는다. 같은 role/name으로 노드를 교체하면 새 ref다. CSS selector 문자열이나 DOM 배열 index를 영구 identity로 사용하지 않는다.
3. 부분 관찰의 maxElements/maxBytes와 partial/omittedCount를 유지한다. 잘린 결과에 대상이 보인다는 이유로 전체 대상의 유일성을 추정하지 않는다. 조작 대상 범위는 문서 폼 하나로 명시하고, 호스트 실험 제어판을 그 범위 밖에 둔다.
4. 실제 입력 직전 현재 document/surface, epoch/fence/work/attempt/lease와 만료, view/focus revision, 원래 노드, role/name 유일성, 실제 표시/disabled/readonly를 검사한다. 읽은 뒤 stale ref를 최신 selector로 자동 재해석하지 않는다.
5. DOM 교체·중복 이름·숨김·disabled 변경은 revision을 올린다. MutationObserver의 지연된 알림만 믿지 않고 입력 직전 현재 노드와 속성을 직접 확인한다. 노드가 바뀌었는데 observer callback 전인 경우도 거절해야 한다.
6. document blur/visibility 변경, 탭·창 변경, 사람의 직접 입력, 명시 takeover는 대기 중 입력을 무효화한다. 사람의 takeover 뒤 agent release가 탭을 닫거나 소유권을 회수하면 안 된다. reclaim은 호스트/사람의 명시 동작이다.
7. 정상적인 드라이버 입력으로 대상에 focus가 이동하는 것과 사람의 개입을 구분해야 한다. 자신의 click/fill 때문에 다음 순간 focus revision이 달라졌다는 이유로 모든 입력을 거절하거나, 반대로 모든 focus 변경을 드라이버 것으로 간주하지 않는다. 각 operation에 허용한 대상 focus 전이만 처리하고 다음 단계는 새로 관찰한다.

wait는 현재 revision 변화 알림 또는 제한된 polling을 사용하되 변화 자체를 완료 증거로 삼지 않는다. 다시 observe하여 해당 조건을 확인한다. 한 번 정한 actionDeadline/lease/work budget 중 남은 최솟값을 사용하며 poll·재관찰·continuation에서 제한 시간을 새로 지급하지 않는다. Web은 실제 경과 시간을 측정하고 합성 virtual time=0과 속도 비교하지 않는다.

## DOM 입력과 영속 영수증 사이의 경계

합성 드라이버는 app+receipt 저장과 입력을 같은 동기 구간으로 모델링한다. 실제 브라우저 입력과 서버 저장은 다른 실행 주체이므로 이 보장을 그대로 옮겼다고 주장할 수 없다.

| 실제로 확인한 경계 | act/lookup에서 허용할 결론 |
| --- | --- |
| 브라우저 입력 전달 전에 lease/권한/target 검사가 거절됨 | 입력이 전달되지 않았음을 확인한 경우만 not_applied |
| 입력을 브라우저에 보냈으나 응답을 받지 못함 | unknown. 취소·timeout·접속 종료만으로 미입력을 추정하지 않음 |
| DOM input/click은 발생했으나 서버 저장/receipt를 확인하지 못함 | unknown. 서버 거절이 발생했더라도 DOM 입력 0으로 기록하지 않음 |
| 앱 상태와 exact operation receipt가 원자적으로 저장됨 | 해당 앱 효과의 applied 증명. 새 관찰과 조건 검증은 여전히 필요 |
| 영수증 조회 결과 없음/손상/identity 불일치 | unknown. savedNote/saveCount나 화면 문구로 이전 operation 영수증을 만들어내지 않음 |

첫 구현은 아래 두 능력을 별도 gate로 둔다.

- **실제 DOM 조작:** 모델에는 fill/click과 role/name/ref 데이터만 제공한다. 드라이버 내부의 고정 코드가 실제 페이지를 조작한다. 모델 입력의 script/evaluate/임의 URL/임의 HTTP body를 실행 가능한 것으로 승격하지 않는다. fixture API 직접 변경을 DOM 조작 대체 경로로 넣지 않는다.
- **협력하는 fixture의 효과 증명:** fixture의 trusted handler가 정확한 operation identity와 앱 상태 변경을 결합하여 영수증을 영속화한다. 앱이 협력하므로 가능한 능력이며 일반 사이트의 영수증 지원을 뜻하지 않는다. raw browser dispatch 수, DOM event 수, 앱 적용 operation 수를 구분한다. 기존 receipt가 가리키는 effect 단위를 구현 전에 확정한다. DOM 입력 자체의 미실행까지 증명할 수 없다면 그 경로는 not_applied 증명을 발급하지 않는다.

기존 포트는 authorizeInput() 이후 마지막 동기 검사와 입력을 요구한다. Node에서 authorizeInput→DOM 검사→다른 IPC 명령으로 browser click을 실행하면 그 사이에 변경이 가능하다. 이 두 호출을 원자적이라고 표시하지 않는다. 고정된 page-side transaction/gate를 사용한다면 최종 live DOM 검사를 그 transaction 안에서 실행해야 한다. native 입력 전에 검사한 뒤 실제 event 수신은 나중이라면 event handler에서도 세대와 target을 재검사해야 한다. 앱 효과 적용을 막았다는 사실과 native 입력 자체가 없었다는 사실은 별도다.

현재 런타임 권한 콜백과 원격 페이지의 live 권한 상태를 원자적으로 묶을 수 없는 구간도 남을 수 있다. 모든 await 뒤에 콜백을 호출했다는 것만으로 프로세스 사이 race가 사라지지 않는다. 협력 fixture의 취소/fence 전파와 최종 수신 gate가 어느 지점까지 보장하는지 시험으로 한정한다. 현재 포트의 강한 입력 보장을 만족하지 못하면 기능을 축소하거나 계약 차이를 명시하고, 합성 드라이버와 동급 보장으로 등록하는 것은 보류한다.

영수증 구현 시 최소 조건은 기존 identity 전체(work/attempt/session/원 epoch/surface/operation/view/focus/ref/action) 일치, 같은 key의 다른 payload 충돌 거절, bounded ledger, 상태+receipt 원자적 저장, 저장 후 응답이다. 현재 같은 work의 새 attempt/epoch lease로 옛 identity를 조회할 수 있고 lookup은 입력하지 않는다. 재시작과 재접속 후 action을 자동 재전송하지 않는다. DOM 내용·일반 화면 응답은 정산 권한이나 영수증으로 승격하지 않는다.

## 호스트 전용 실패 주입

첫 fixture는 모델 tool에 없는 typed host hooks를 제공하면 기존 경계 시험을 이식하기 쉽다: rerender, 동일 이름 노드 추가/제거, hidden/disabled/readonly, blur/takeover/reclaim, 검색 완료 지연, 입력 전 pause, 저장 후 ACK 유실, 문서 reload, fixture process restart. 임의 스크립트 실행 hook을 모델/일반 폼에서 호출할 수 있게 만들지 않는다.

사람이 편집한 값을 agent operation의 영수증에 귀속하지 않는다. 수동 입력은 소유권·revision을 바꾸고 그 이후 agent는 새 관찰을 받아야 한다. agent 작업 중 입력을 잠갔다면 화면에 소유 상태와 takeover 방법을 보여준다. 잠긴 화면을 자동화 성공의 증거로만 쓰고 사람 개입 시험을 생략하지 않는다.

localhost 서버는 테스트가 만든 주소/포트와 고정 route만 사용한다. 외부 resource/CDN/폰트/프레임/탐색은 fixture에 필요 없다. loopback에 한정하여 실행하고, 조작·호스트 제어 endpoint에는 동일 origin과 instance 권한을 적용한다. 모델이 지정한 URL을 해당 권한으로 대신 호출하지 않는다. 종료는 이번 실행이 만든 server/browser 자원만 대상으로 한다.

## 동일 목표의 before/after 비교

한 번의 새 build pin에서 **backend 2 × driver 2 × sequence 2 = 8개 정상 셀**을 권한다.

| 차원 | 값 |
| --- | --- |
| 상태 저장소 | SQLite / file-journal |
| 드라이버 | 합성 / 실제 로컬 Web |
| baseline | observe → Note fill 단일 act → 그 결과의 최신 observation으로 Save 단일 act |
| batched | observe → [Note fill, Save] 한 act |

목표·완료 기준·입력 `reviewed`·두 단계의 조건·초기 앱 내용·한도는 같다. 정상 경로의 예상 논리 toolCalls는 3 대 2, 적용 operation은 2, Save는 1이다. 중간 fill 결과는 evidence=[]/목표 미완료여야 한다. 최종 savedNote, 저장 횟수, criterion 결과, 독립 근거 수, unresolved obligation 유무, 최종 완료 상태를 비교한다. 별도 새 Source를 만드는 드라이버의 실제 source/lineage ID는 다를 수 있으므로 생성 ID를 제외한 비교와 각 driver의 provenance 진실성 검증을 별도로 한다. source 검증을 지워서 동등성을 만들지 않는다.

측정 필드는 다음을 구분한다.

- logical toolCalls, modelCalls(이번 범위는 0), driver method calls(observe/act/wait/lookup), acquire/release sessionCalls.
- 실제 HTTP/CDP/기타 browser protocol 전송 수와 bytes. 합성의 transportCalls는 method 호출이며 네트워크 전송 수가 아니다. 여러 종류의 숫자를 같은 열에서 절감률로 계산하지 않는다.
- browser 입력 dispatch, DOM event, 적용된 앱 operation, Save 수. fill 한 번이 여러 keyboard/input event를 만들 수 있다.
- artifact body read/write bytes, unique stored bytes, ToolResult/output UTF-8 bytes. Node 수준 파일 bytes를 물리 disk I/O로 표시하지 않는다.
- setup/browser launch, 실제 작업, wait, 검사·스크린샷 시간을 분리한다. 이미지가 쓰이지 않았다면 imageBytes=0이며 스크린샷 첨부를 모델 이미지 비용에 합치지 않는다.

스크립트와 source/build/lock, fixture HTML·client·server, browser/runtime 버전 및 실행 조건을 pin한다. 측정 전후 코드 pin을 확인하고 기존 evidence 파일을 덮어쓰지 않는다. 첫 8셀은 기능과 호출 수 비교이지 일반적인 latency·모델 품질·실제 사내 앱 성능 증명이 아니다. 시간 개선을 주장하려면 같은 Web driver 내 baseline/batched를 반복 측정하고 초기화·warmup·분산을 함께 기록한다. 합성 virtual clock과 브라우저 wall time의 비율에는 의미를 부여하지 않는다.

## 구현 후 통과해야 할 gate

| gate | 최소 관측 / 실패 시 중단 기준 |
| --- | --- |
| 실제 페이지 확인 | 사람이 볼 수 있는 폼, Query/Note 입력, Search/Save 결과와 DOM snapshot 일치. API-only 모의 완료는 이 gate의 성공이 아님 |
| 기본 동등성 | 8개 정상 셀의 명시한 목표/횟수/완료 의미 일치. evidence 없이 UI의 성공 문구만으로 complete 금지 |
| DOM 마지막 검사 | rerender/ref 교체, duplicate name, hidden/disabled/readonly, focus/takeover를 입력 전 barrier에서 변경. 확정 pre-input 거절이면 dispatch/적용 count 모두 0 |
| 권한/기한 | driver await 중 다른 runtime의 goal/policy/pause/cancel 변경, lease 만료 뒤 새 소유자, deadline 경계. 늦은 입력 추가 0 또는 이미 전달된 경우 unknown의 명시적 기록 |
| readiness | Search 지연, 같은 query 재입력, reload 후 옛 응답, 다른 revision 변화만 발생. ready 확인 없이 성공하지 않고 기존 마감 시간을 보존 |
| ACK/재시작 | 전달 전 종료, DOM 입력 후 저장 확인 전 종료, durable app+receipt 후 ACK 전 종료, 결과 artifact 후 adopt 전 종료를 구분. missing receipt는 unknown, exact receipt 조회는 입력 0 |
| continuation | applied prefix 재입력 없음. 현재 fresh entry/inherited 관찰·원 head/proof 참조 유지, sibling 거절, lineage 한도 보존. 영수증 정산 자체는 goal evidence 아님 |
| proof 소비 | 같은 state revision에서 proof/head/blob 손상·유실 시 context/restore·complete·공개 결과·전송 gate가 기존 원칙대로 차단 |
| UI/브라우저 | 키보드 label/focus, 320–390px 화면 overflow, 보이는 소유/저장/검색 상태, 새로고침은 cancel 아님, 사람 takeover 후 탭 유지, text 렌더·script 미실행 확인 |
| 정리/증거 | console/page error와 실제 외부 request 부재, 시작한 child/server/browser만 정리. screenshot+DOM+실제 driver trace+앱/receipt 검사와 build pin을 함께 저장 |

복구 gate의 세부 단계는 실제 채택한 전송/영수증 방식으로 재현 가능해야 한다. 특히 페이지와 서버를 한 프로세스로 간주하거나 fixture의 저장 성공을 브라우저 처리 완료로 대체하지 않는다. 실제 browser driver가 아직 영수증 lookup을 지원하지 않는 첫 버전이라면 `.act`의 unknown 차단까지 먼저 검증하고, 정산/후속 입력 지원은 별도 미검증 항목으로 남긴다.

이번 문서만으로 위 gate를 통과했다고 주장할 수 없다. 실제 모델의 계획 품질, 사내 Web·SSO·외부 GUI, 범용 사이트의 영수증 지원, 여러 프로세스/기기 간 전역 session lease는 별도 작업이다.
