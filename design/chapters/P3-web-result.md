# P3-02 두 번째 단위: 로컬 Web 작업실 학습·결과

2026-09-06 · 로컬 합성 업무 · 마지막 UI 표시 수정 뒤 전체 검증 완료

이번 단위에서는 기존 범용 실행 코어에 사람이 업무를 접수하고, 상태를 읽고, 질문에 답하고, 실행을 제어하는 Web 화면을 연결했다. 문서·관측 합성 자료와 명시적인 예제 계획을 사용한다. 제목이나 답변의 자연어를 모델이 이해해 계획했다는 의미는 아니다. **실제 LLM/API·MCP·Knox 호출은 0회**다.

[구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-web-plan.md), [독립 검토](/Users/seunghanee/Documents/secumon/design/chapters/P3-web-review.md), [앞선 공통 조회/CLI 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-work-view-result.md)를 이어서 읽으면 된다. 이번 화면이 goal/state, planner, 가설·근거, compact, 재개 패킷을 대신하지 않는다. 그 코어에 **조회와 명시 제어**를 붙이는 단위다.

## 이번에 배울 점

| 구분 | 이 작업실에서의 의미 |
| --- | --- |
| 접수 | 업무와 접수 안내가 저장됨. 질문 예제의 초기 의무와 질문도 같은 commit에 저장 |
| 실행 | 사용자가 실행을 요청했거나, 접수 폼에서 ‘접수 뒤 바로 실행’을 선택한 경우에만 예제 계획과 workflow 실행 |
| 화면 갱신 | 현재 권한과 근거를 통과한 공개 snapshot 조회. 도구·모델 실행, 발송, checkpoint 생성 없음 |
| 결과 준비 | 현재 목표와 근거·가설·산출물 검사를 통과한 답변이 있음 |
| 로컬 저장 확인 | LocalChannel에 해당 답변을 저장한 영수증. 브라우저 읽음이나 Knox 전달 확인이 아님 |
| 창/연결 종료 | 화면 연결의 종료. 업무 취소 명령이 생기지 않음 |

기본 대화에는 접수·현재 필수 질문·유효한 결과만 둔다. 진행 상태는 별도 표시로 갱신하고, 계획·가설·근거와 실행 사건 메타데이터는 사용자가 상세/진단을 열 때 조회한다. 권한이나 근거가 바뀌어 현재 답변을 검증할 수 없으면 과거 본문을 현재 결과에서 내린다.

## 코드에서 따라갈 곳

- [LocalWorkbench](/Users/seunghanee/Documents/secumon/runtime/src/presentation/local-workbench.ts): 고정 합성 사용자, 예제 접수, 공개 목록/조회, 명시 명령과 내구성 있는 실행 요청 기록.
- [Web 요청 계약](/Users/seunghanee/Documents/secumon/runtime/src/presentation/web-contracts.ts): 접수·연결·실행·목표·모드·질문 응답의 strict 입력 구조.
- [HTTP adapter](/Users/seunghanee/Documents/secumon/runtime/src/presentation/web-server.ts): 연결 인증, 세션/CSRF, 요청 상한, 공개 상태 스트림.
- [브라우저 client](/Users/seunghanee/Documents/secumon/runtime/src/presentation/web/client.ts)와 [화면 상태 규칙](/Users/seunghanee/Documents/secumon/runtime/src/presentation/web/view-state.ts): 늦은 응답 배제, 입력 보존, 메시지 중복 제거, 스크롤과 편집 충돌 처리.
- [공통 조회 서비스](/Users/seunghanee/Documents/secumon/runtime/src/application/work-view-service.ts): 현재 질문 ID와 편집 가능한 목표를 선별하며, 원문·도구 입출력·모델 입력을 화면에 보내지 않음.

목록의 모든 카드도 공통 공개 조회를 통과한다. Web을 기존 CLI 업무에 연결해도 주 답변 경로를 바꾸거나 답변을 다시 보내지 않는다. 실행 요청의 goal revision은 최초 예제 계획과 workflow 진입까지 고정한다. g1 실행 요청의 저장 확인이 늦는 동안 g2로 목표가 바뀌면, 그 요청으로 g2를 새로 실행하지 않는다.

## 직접 실행해 보기

고정 Node 24.20.0과 현재 빌드 결과를 사용한다. 아래 실행은 로컬 합성 자료만 사용한다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
node dist/presentation/web.js --data-dir .data/web-learning --state-backend sqlite
```

터미널에 표시된 ‘최초 연결’ URL을 브라우저에서 연다. 포트 기본값은 0이므로 실제 할당된 주소를 사용한다. URL의 일회 연결 토큰은 이 로컬 인스턴스의 접속 권한이며 문서나 공유 로그에 복사하지 않는다. 서버 재시작 뒤에는 새 연결 URL로 인증한다.

file journal로 실습하려면 별도 폴더를 사용한다. 같은 폴더의 저장소 종류를 전환하는 명령이 아니다.

```sh
node dist/presentation/web.js --data-dir .data/web-learning-journal --state-backend file-journal
```

1. ‘문서 근거 확인’을 고르고 ‘접수 뒤 바로 실행’을 해제한 뒤 접수한다. 접수 안내는 보이지만 계획·도구 실행은 아직 시작되지 않는 것을 확인한다. 새로고침과 상세 열기만으로 완료되면 안 된다.
2. ‘실행’을 누른다. 근거가 포함된 결과와 ‘로컬 저장 확인’을 구분해서 읽는다. ‘관측 범위 확인’도 별도 업무로 접수·실행해 목록에서 두 업무를 오가 본다.
3. ‘질문에 답한 뒤 문서 확인’을 접수한다. ‘확인 내용’을 입력하고 ‘답변 저장’을 누른 뒤 **다시 ‘실행’을 눌러** 진행한다. 이 예제의 답변 저장은 명시적인 선택 확인이며 자연어 판단이 아니다.
4. 여러 질문을 추가한 합성 검수 업무에서는 하나를 해결한 뒤 명시 실행하면 남은 질문 묶음이 새로 준비된다. 새 질문이 나타나면 다시 답변 저장 → 실행 순서로 진행한다. 조회가 다음 질문을 준비하는 실행을 대신하지 않는다.
5. 실행 대기 업무의 목표/완료 조건과 진행 방식을 바꿔 본다. 다른 창이나 CLI에서 목표·모드를 바꾼 경우, 편집 중 입력은 남고 제출은 막혀야 한다. ‘입력 유지하고 최신 기준 읽기’로 새 기준과 보존할 진행 방식을 확인한 뒤 다시 제출한다.
6. ‘다른 대화의 업무 가져오기’에 동일 data directory의 CLI 업무 ID를 넣어 연결한다. 화면의 다른 대화 관찰 안내와 원래 CLI 전달 경로가 유지되는지 확인한다.

오래된 목표로 보낸 명령은 자동으로 새 목표에 적용하지 않는다. 일시 정지는 실행 재개가 가능한 상태이고 취소는 별도 명령이다. 취소/실패 업무의 목표·모드 편집과 완료 업무의 모드 변경·실행은 화면에서도 비활성화한다. 서버 종료 후 미완료 업무는 새 명시 실행으로 이어가며, 상주 worker가 백그라운드에서 계속 실행하는 구조는 아직 아니다.

## HTTP와 동시 처리의 경계

| 항목 | 현재 구현 값과 의미 |
| --- | --- |
| 수신 | `127.0.0.1` 고정. 정확한 Host/Origin 검사. 사내 SSO나 TLS 서비스 배포를 의미하지 않음 |
| 최초 연결/세션 | 10분 수명의 일회 fragment 토큰 교환, 인스턴스별 host-only HttpOnly/SameSite=Strict 쿠키, 메모리 세션 1시간 |
| 변경 요청 | 현재 세션과 CSRF 검사. body를 받은 뒤 명령 진입 직전에도 세션 재확인. 실제 수신 UTF-8 JSON 최대 32 KiB |
| 공개 조회 | 일반 목록/조회와 SSE polling이 실제 진행 중 읽기 슬롯 16개를 공유. 조회가 끝날 때 슬롯 회수 |
| SSE | 서버 전체 최대 4연결, 기본 2초 간격 직렬 조회, 연결 수명 최대 60초. 세션/권한 만료·disconnect·shutdown·전송 정체에서 종료 |
| 변경 요청/실행 | HTTP 변경 요청 동시 상한 12개. controller의 활성 실행은 profile당 최대 4개 업무. 같은 업무 실행 중복을 별도로 제한 |
| 중지·취소 | 실행 전체가 끝날 때까지 같은 잠금을 기다리지 않고 기존 코어 명령으로 처리 |
| 재전송 | 동일 요청은 내구성 있는 영수증을 확인. 같은 run ID를 재전송해 저장된 실행을 새 실행으로 바꾸지 않음 |

SSE의 `events` 경로는 공개 `view`/`unchanged`를 전달한다. 원시 실행 사건이나 재개 패킷 스트림이 아니다. 브라우저는 변경 신호를 받아 최신 GET을 합쳐서 요청하고, 현재 선택·세션·요청 세대가 맞는 응답만 적용한다. `unchanged` 신호로 별도의 GET을 계속 추가하지 않는다.

## 자동 검증 상태

고정 Node 24.20.0에서 마지막 비활성화 표시 수정까지 포함한 `npm run verify`가 exit 0으로 완료됐다. **1,483/1,483, 실패 0**, 시험 소요 시간은 132,417.966584ms였다. 코어 별도 타입 검사, 안쪽 계층 85파일/위반 0, 합성 4시나리오/22판정도 통과했다.

| 분모 | 최종 전체 통과에 포함된 시험 수 |
| --- | ---: |
| 앞선 공통 조회/CLI까지의 회귀 | 1,427 |
| 로컬 controller, 두 저장소 | 24 |
| 브라우저 상태/표시 규칙 | 21 |
| 독립 HTTP/세션/SSE | 9 |
| 실제 local profile과 HTTP 통합, 두 저장소 | 2 |
| 합계 | 1,483 |

[최종 전체 검증 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-verify.log) · [표시 수정 전 1,483개 통과 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-verify-before-control-display-fix.log) · [HTTP/통합 관련 11개 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-transport-3.log). 더 앞선 1,479개 전체 로그와 controller/UI 초기 32개 로그도 중간 증거로 남겼다. 단위시험 수에 아래 실제 브라우저 관측을 더해 같은 분모로 계산하지 않는다.

## 실제 브라우저에서 관측한 결과

주 작업이 SQLite 로컬 profile의 실제 브라우저에서 15개 검수 항목을 기록했다. file journal은 자동 controller/HTTP 통합 시험 범위이며, 아래 화면 관측을 두 저장소 모두의 브라우저 검수로 확대하지 않는다.

| 관측 | 결과 |
| --- | --- |
| 1280×720, 390×844, 320×640 | 문서 가로 넘침 0 |
| 문서·관측 예제 | 접수와 실행을 거쳐 현재 결과와 로컬 전달 상태 표시 |
| 질문 흐름 | 추가 질문을 포함한 합성 업무에서 답변 저장 → 명시 실행을 두 차례 거쳐 완료 |
| CLI 업무 Web 연결 | 다른 대화를 관찰한다는 안내 표시, CLI 주 답변 경로 유지 |
| 목표 폼을 연 상태에서 CLI 모드 변경 | 입력 draft와 초점 보존, 낡은 기준의 제출 비활성화. 최신 기준 읽기 뒤 fast 유지 성공 |
| 키보드 초점 | 질문 입력에서 Tab으로 답변 저장 이동, 목표 dialog를 닫으면 열었던 버튼으로 초점 복귀 |
| 종료 상태 표시 | completed의 실행/모드, cancelled의 목표/모드/취소 비활성화를 브라우저에서 확인. failed의 비활성화 규칙은 소스 확인만 수행 |
| 320×400에서 과거 대화 읽기 | `scrollTop=0`에서 새 질문 도착 뒤에도 0 유지. 새 답변 버튼 표시. 버튼 클릭 뒤 136.5로 이동하고 버튼 숨김 |

[브라우저 관측 15항목](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-browser-verification.json) · [데스크톱 화면](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-browser-desktop.png) · [390px 화면](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-browser-390.png) · [320px 화면](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-browser-320.png) · [목표 편집 충돌 안내](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-goal-stale.png) · [최종 DOM](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-browser-final-dom.txt) · [추가 질문 검수 구성](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-scroll-setup.json).

검수 후 임시 탭을 닫고 viewport를 1280×720으로 복원했으며, 로컬 서버는 SIGINT로 종료해 exit 0을 확인했다. 실제 OS 한글 IME 조합, screen reader, 모든 브라우저, failed 상태의 화면 조작을 검수한 것으로 주장하지 않는다.

## 조회 비용으로 확인한 것

[독립 SSE 읽기 측정](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-read-cost.json)은 SQLite의 완료된 합성 업무 1개를 사용했다. 기본 2초 polling에서 `view → unchanged → unchanged` 3개 frame을 관측했고, 연결 종료 후 2.1초 대기를 포함한 전체 시간은 6.183초였다.

| 측정 항목 | 관측값 |
| --- | ---: |
| WorkView 조회 | 3회 |
| artifact get / 읽은 bytes | 6회 / 1,422 bytes |
| 정본 commit / artifact put / 채널 발송 | 각각 0회 |
| 연결 종료 후 추가 읽기 | 0회 |
| 종료 후 stream / 실제 읽기 슬롯 | 각각 0개 |
| 업무 정본 | 변경 없음 |

내용이 그대로여도 현재 원본을 검증하므로 `unchanged`는 읽기 비용 0을 뜻하지 않는다. 이 측정에는 브라우저가 변경 이벤트마다 수행하는 추가 GET이 들어 있지 않다. 세 frame의 작은 관측이며 처리량·운영 규모·전체 화면 비용 벤치마크가 아니다.

목록은 최대 20개 카드다. 안정된 20개 페이지에서 `WorkView.read` 40회가 자동시험으로 확인됐다. 처음 확인한 20개가 모두 후보인 경우 최초 조회와 최대 3회 후보 재검사는 최대 80회다. 다만 권한 없는 항목을 건너뛰는 최초 탐색과 전체 업무 ID 목록 읽기는 이 80회 상한에 포함되지 않는다. 전체 목록 I/O가 80회로 제한됐다고 주장하지 않는다. 각 WorkView 내부의 원본/상태 재검사 비용도 별도다. 업무 간 권한 변화에 대비하는 제한된 재검사이며 전역 cross-work 트랜잭션을 제공하지 않는다. 최근 50개만 표시하는 진단도 현재 저장소 포트에서는 전체 사건 이력을 읽은 뒤 선별하므로 긴 이력의 tail 조회 개선은 남아 있다.

## 다음 단위에 남길 제한

P3-02 전체 상태는 **in_progress**, `local_contracts`는 **partially_verified**로 유지한다. 다음 독립 단위는 긴 이력 조회 I/O와 목표 편집의 원자적 control revision 경계를 보완하는 것이다. 현재 로컬 화면의 통과를 전체 외부 연결이나 사용자 명령의 모든 경합에 대한 완료로 확대하지 않는다.

- 현재 페이지에서 응답이 불확실한 접수를 다시 제출하면 같은 payload의 요청 ID를 재사용한다. 페이지 전체 reload 뒤의 미확정 접수 ID 자동 복원은 구현하지 않았다.
- 목표 편집 화면은 goal/control 변경을 관측하면 입력을 유지하며 다시 확인하게 한다. 목표 POST에 대해 control revision까지 같은 저장 트랜잭션에서 검사하는 원자적 계약은 아직 없다. 전송 중의 다른 모드 변경까지 전부 차단한다고 주장하지 않는다.
- 동일 업무 실행 중복과 활성 업무 수는 로컬 controller/profile 조정 범위다. 여러 서버·worker를 위한 분산 실행 조정이나 상주 scheduler를 이번 단위에서 구현한 것은 아니다.
- 고정 합성 사용자, loopback 세션, 선택된 예제는 사내 다중 사용자 인증·권한 이행·실제 모델·MCP·Knox·컴퓨터 유즈 연결의 검증을 대체하지 않는다.

이번 학습에서 확인한 핵심은 화면의 접속 수명, 명령의 요청 ID, 업무의 목표 revision, 근거의 현재성, 채널 전달 영수증이 각각 다른 역할을 한다는 점이다. 다음 연결에서도 이 구분을 유지하면서 실제 provider와 채널 계약, 인증과 장기 조회 비용을 별도 검증해야 한다.
