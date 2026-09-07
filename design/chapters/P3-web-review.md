# P3-02 로컬 Web 독립 검토: 경계와 수용 기준

2026-09-06 · 구현 전 계약 검토 및 구현 중 독립 검토 기준

이 문서는 로컬 HTTP/세션/SSE와 Web 업무 화면을 위한 수용 기준이다. 아래 행렬은 요구되는 시험이며 통과 기록이 아니다. 이 검토에서는 제품 소스 수정, 빌드, 시험 실행, HTTP 요청, 브라우저 조작을 하지 않는다. 실제 모델·MCP·Knox·사내 서비스의 검증 결과로 확대하지 않는다.

기존 [업무 조회 계획](P3-work-view-plan.md), [첫 단위 결과](P3-work-view-result.md), [공개 화면 계약](../../runtime/src/domain/work-view.ts), [공통 조회 서비스](../../runtime/src/application/work-view-service.ts)를 기준으로 한다. 첫 단위의 CLI 조회와 이번 Web/브라우저 검증은 별도 결과로 남긴다.

## 1. 보존할 데이터와 실행 경계

- Web 목록과 업무 본문은 현재 `WorkViewService`의 등록 대화·소유권·읽기 권한·목적지 `screen` 공개 검사를 통과한 투영을 사용한다. 목록도 내부 work ID 목록이나 원시 상태를 그대로 반환하지 않는다. 진단은 별도 신뢰 권한과 `log` 공개 정책을 모두 적용한다.
- 기본 화면에는 접수, 현재 질문/답변, 작은 진행 상태만 표시한다. 상세 카드와 사건 메타데이터는 명시 선택이다. 원문, artifact bytes, 도구 입출력, 모델 입력, 내부 event payload, 세션/CSRF 값은 응답·오류·화면 로그에 넣지 않는다.
- 같은 업무의 `snapshot`으로 화면을 교체하는 행위와 새 대화 메시지를 추가하는 행위를 구분한다. 메시지는 ID로 중복을 제거하고, 현재 snapshot에서 빠진 과거 답변은 현재 답변 영역에서 제거한다.
- 화면 열기, 목록·상세 조회, 재접속, SSE polling은 `workflow.run`, 접수/attach, 상태 commit, artifact put, 발송/읽음 처리, checkpoint 저장을 호출하지 않는다. 원본 무결성 확인을 위한 읽기는 허용된다. 저장소 생성자의 로컬 메타데이터 쓰기까지 없다고 주장하지 않는다.
- 화면에서 읽었다는 사실은 기존 주 답변 채널의 전달 영수증을 변경하지 않는다. prepared/pending, sending/unknown, delivered, failed를 구별하고, 별도 연결에서 읽더라도 주 답변 경로를 자동 변경하지 않는다.
- 가설 평가의 원본이 사라지면 목표 criterion 자체의 근거가 남아 있어도 현재 평가/결과 준비를 보류한다. 첫 단위에서 추가한 공통 `reviewRequired` gate를 Web에서 다시 계산하거나 우회하지 않는다.

## 2. HTTP와 세션의 최소 계약

| 경계 | 수용 기준 | 놓치기 쉬운 부분 |
|---|---|---|
| 수신 주소 | 실제 listen 주소가 `127.0.0.1`이며 선택한 port를 정확히 사용한다. | `0.0.0.0`, 임의 hostname, 다른 인터페이스까지 열어 놓고 localhost URL만 안내하지 않는다. |
| Host/Origin | Host는 서버가 생성한 origin과 정확히 대응한다. 변경 요청은 정확한 Origin, 기존 세션, CSRF를 함께 검사한다. | POST `/api/session`도 Host/Origin 검사의 예외가 아니다. 접속 토큰을 세션으로 바꾸는 최초 요청만 기존 세션/CSRF 대신 초기 토큰으로 인증한다. |
| 초기 연결 | 충분히 무작위인 일회 토큰을 fragment로 전달하고, 클라이언트는 교환 시도 전에 `history.replaceState`로 제거한다. | URL query, 서버 access log, local/session storage, 오류 본문에 토큰을 남기지 않는다. 같은 토큰을 두 번 교환하거나 만료 후 교환하지 못한다. |
| 기존 세션 | GET session은 이미 유효한 세션의 identity/config/필요한 재접속 정보를 복원한다. | GET으로 새 인증을 발급하거나 work를 접수·실행하지 않는다. 프로세스 재시작 후 이전 메모리 세션은 다시 인증해야 한다. |
| 쿠키/만료 | HttpOnly, SameSite=Strict, host-only, 제한된 Path/수명과 서버 측 만료를 사용한다. | 쿠키는 port별로 격리되지 않는다. 여러 로컬 인스턴스를 허용한다면 cookie 이름 또는 인스턴스 구분을 고정하고 서로의 세션으로 인증되지 않는지 확인한다. HTTP loopback을 TLS나 사내 인증으로 표현하지 않는다. |
| CSRF | 세션에 묶인 CSRF를 JS 메모리에 보관하고 변경 요청의 지정 header로 전달한다. | 재접속 시 복원 방식과 만료 의미를 고정한다. body의 actor/권한/진단 허용 값은 받지 않는다. |
| body와 경로 | strict JSON schema, 허용 Content-Type, UTF-8 byte 기준 32 KiB 상한, 정확한 route/method를 적용한다. | Content-Length 선언값만 믿지 말고 실제 수신 바이트도 제한한다. 임의 파일 경로나 원문 조회 URL을 받지 않는다. header/body 수신에도 유한한 timeout을 둔다. |
| 정적 자산 | HTML/CSS/client JS의 정확한 allowlist와 고정 content type을 사용한다. | 범용 디렉터리 서버를 열지 않는다. CSP, no-store, nosniff, frame-ancestors none과 안전한 오류 응답을 적용한다. |

로컬 서버의 고정 synthetic 사용자와 부트스트랩 토큰은 이번 profile의 권한 모델이다. 서로 다른 회사 사용자 인증이나 같은 OS 사용자에게서 로컬 파일을 보호하는 모델의 대체물이 아니다.

## 3. SSE와 현재성

SSE는 공개 `snapshot`/`unchanged`/`unavailable`만 전달한다. 원시 event log나 실행 재개 패킷을 스트림에 넣지 않는다. cursor는 work·주체·등록 대화·수준·현재 허용 내용에 묶인 불투명 값이다. 문자열 정렬이나 숫자 revision으로 cursor의 선후를 추정하지 않는다.

- 한 연결 안의 polling은 직렬로 수행한다. 이전 조회가 끝나기 전에 다음 조회를 겹치지 않는다. 기준 polling 간격, 최대 연결 수 4, 연결 수명 60초의 적용 범위를 서버 전체/세션별 중 무엇인지 명시한다.
- 연결 제한은 인증과 연결 수명/해제까지 포함해 실제로 적용한다. timeout, 클라이언트 disconnect, 인증 만료, shutdown, backpressure에서 타이머와 연결 카운트를 회수한다. 전송이 막히면 무한 queue 대신 연결을 닫는다.
- 새 연결마다 인증하고, 연결 유지 중에도 각 공개 조회의 현재 권한을 검사한다. 세션 만료가 60초 연결 갱신까지 무조건 유예되지 않도록 만료 검사 주기를 명시한다.
- `Last-Event-ID`나 query cursor는 조회 최적화 힌트일 뿐이다. 다른 업무/수준의 cursor는 최신 전체 snapshot으로 처리하고, 권한 거절은 `unchanged`로 돌리지 않는다.
- `unavailable`은 현재 본문을 계속 보여도 된다는 신호가 아니다. 클라이언트는 기존 결과/상세를 현재 답변 영역에서 내리고 재확인 필요 상태를 표시한다. 서버가 오류 종류를 내부 경로·근거 ID로 설명하지 않는다.
- 같은 revision에서 원본 또는 기억의 유효성이 바뀔 수 있다. 이 경우 바뀐 snapshot을 받아야 하며, revision이 같다는 이유로 UI가 버리면 안 된다.

첫 단위 서비스는 여러 차례 정본과 원본을 다시 읽는다. 2초 polling × 연결 수에 따라 원본 읽기 비용이 증가하므로, 실제 polling 횟수·artifact get/읽기 bytes·연결 종료 후 추가 조회 수를 측정한다. 출력 카드 20개/진단 50개 제한만으로 조회 I/O가 제한됐다고 보고하지 않는다. 같은 값의 검증을 건너뛰는 지속 캐시는 이번 계약의 대안이 아니다.

## 4. 명령, 중복, 늦은 실행 결과

| 동작 | 보존할 계약 |
|---|---|
| accept | 명시 사용자 제출만 접수한다. 정해진 scenario/목표/모드 범위를 검증한다. command/request ID를 재시도 동안 보존하여 ACK 유실 뒤 중복 업무가 생기지 않는다. |
| attach | 명시 연결 동작으로 처리한다. 조회나 재접속의 부수 효과로 실행하지 않는다. 현재 actor/목적지 권한과 원래 주 답변 경로를 보존한다. |
| run | 명시 실행 요청만 시작한다. 동일 업무의 중복 요청은 실행에 합류하거나 명시 `in_progress`로 응답한다. 도구 attempt 단위 `ExecutionJoin`만으로 전체 planning/workflow 중복이 막혔다고 가정하지 않는다. |
| pause/cancel | 진행 중 run을 제어할 수 있어야 한다. run 전체를 감싼 mutex를 끝까지 기다려서 제어가 무력화되지 않게 한다. 진행 중 호출의 lease/unknown 효과·사용량 정산은 기존 런타임 규칙을 유지한다. |
| 목표/모드/resolve | 서버가 정한 actor와 클라이언트가 본 expected goal/control revision을 런타임 명령에 전달한다. stale 요청은 충돌로 돌리고 자동으로 새 revision에 재적용하지 않는다. |
| 재시도 | 같은 command ID와 같은 의미의 body는 기존 영수증을 확인한다. 같은 ID의 다른 body는 충돌이다. UI가 timeout마다 새 ID를 생성하거나 네트워크 응답 유실을 성공/미실행으로 단정하지 않는다. |
| 늦은 완료 | HTTP run 응답에 포함된 과거 snapshot을 취소·목표 변경 뒤 그대로 덮어쓰지 않는다. 현재 선택/세션/명령 세대가 맞는지 확인하고 최신 공개 조회로 상태를 맞춘다. |

SSE 접속 제한과 별도로 활성 run/변경 요청의 업무별·서버 전체 한도를 정한다. 브라우저 탭을 닫는 것은 자동 취소가 아니며, UI는 이 의미를 설명한다. 서버 프로세스가 내려갔을 때 실제 실행이 지속되는 범위도 저장된 상태/worker 수명에 맞춰 안내한다.

## 5. 화면의 오래된 본문, 초점과 스크롤

- work 선택, session 교체, 조회 수준 변경, 권한 거절/만료에 요청 세대를 부여한다. 이전 work의 느린 응답, 이전 details 요청, 이전 SSE 연결은 새 화면에 적용하지 않는다.
- 특히 `unavailable` 후 먼저 시작한 details 요청이 늦게 성공하는 순서를 검증한다. Abort만으로 해결됐다고 보지 않고 응답 적용 시 세대/선택 대상을 다시 비교한다. 기본 스트림에서 내용 cursor가 바뀌거나 현재 결과가 무효해지면 열린 상세의 유효성도 다시 확인한다.
- 조회된 문자열은 text node로 렌더링한다. 질문·claim·locator·오류 문자열을 HTML이나 실행 가능한 링크로 해석하지 않는다. CSP는 안전한 렌더링을 대신하지 않는다.
- polling/unchanged 수신 때문에 입력 DOM을 재생성하지 않는다. 한글 조합 입력, 커서 선택, Tab 초점, 입력 중 draft가 보존돼야 한다. 업무별 draft를 유지한다면 잘못된 업무로 제출되지 않게 선택 대상을 함께 보존한다.
- 대화 하단을 보고 있을 때만 새 메시지로 자동 스크롤한다. 이전 내용을 읽는 중에는 위치를 유지하고 새 항목 안내를 제공한다. 상세 열기/닫기 후 초점을 원래 버튼으로 되돌린다.
- 좁은 화면에서 업무 선택·현재 상태·입력·전송/중지 제어에 접근할 수 있어야 한다. 가로 overflow, 긴 ID/원문 길이, 키보드 전용 사용, 버튼의 접근 가능한 이름을 실제 브라우저에서 확인한다.
- 준비된 답변, 주 채널 전달 여부, 실행 대기/진행 중, 사용자 확인 필요, 권한/접속 문제를 구분한다. 성공 toast나 녹색 완료 표시는 HTTP 200이나 화면 표시만으로 만들지 않는다.

## 6. 고정 수용 시험 행렬

| 계층 | 필수 정상 대조군 | 필수 실패·복구·경합 |
|---|---|---|
| HTTP/session | 일회 교환, 기존 session 복원, 허용 자산/route, 정상 CSRF 명령 | 잘못된 Host/Origin/session/CSRF, 토큰 재사용·만료, 임의 actor 필드/초과 body/잘못된 method, 프로세스 재시작 후 이전 session 거절 |
| 목록/조회 | 같은 사람의 두 업무군, 등록된 다른 연결, 3개 조회 수준 | 다른 사람·미등록 대화·screen/log 권한 철회, 목록에서 비공개 업무 식별자/제목 제외, 같은 revision의 원본/가설 basis/기억 유실 |
| SSE | snapshot→unchanged→변경 snapshot, cursor 재접속, 4개 접속 | 상한 초과, 세션/권한 만료, 조회 중 취소·목표 변경, 느린 writer, disconnect/60초 종료 뒤 카운트·timer 회수, polling 중복 없음 |
| 명령 | accept→명시 run→질문/결과→주 채널 전달 구분 | 동일 ID ACK 유실 재시도/다른 body 충돌, stale goal/control revision, 중복 run, run 도중 pause/cancel/목표 변경, 늦은 응답이 새 상태를 덮지 않음 |
| readonly | 목록·대화·상세·재접속만 반복해도 동일 정본/영수증/사용량 | state.commit/artifacts.put/tool/model/sink 호출 카운터 모두 0. 실패한 조회와 unavailable 경로도 포함 |
| 브라우저 | 두 업무군 선택, 접수/실행/명시 제어, 정상 상세/재접속 | 입력·한글 조합 중 polling, 다른 업무의 늦은 응답, unavailable 후 늦은 details, 스크롤 유지, 좁은 화면, 키보드 초점, 새로고침 후 인증 복원 |

저장·실행·재시작·명령 정합성 시험은 SQLite와 file journal 두 backend에 적용한다. HTTP 순수 parsing/세션 검사는 저장소와 독립적으로 추가할 수 있다. 실제 브라우저 결과에는 사용한 backend, viewport, 동작, 기대/관측, 실패 또는 미검수 항목을 기록한다. 단위시험 통과만으로 실제 브라우저 초점/스크롤 동작을 검증했다고 표시하지 않는다.

## 7. 결과 기록과 현재 검토 상태

새 결과 문서에는 실행한 명령/Node 버전, source/build pin, 시험 수와 실패 수, 두 업무군·두 backend 범위, 실제 브라우저 증거, 원본/lock/이전 기록 보존, 남은 제약을 기록한다. HTTP 명령 시험·SSE 시험·브라우저 사용성 시험·실제 외부 계약 시험의 분모를 합치지 않는다. 새로 실행한 모델/API/MCP/Knox 호출은 이번 로컬 범위에서 0이어야 한다.

2026-09-06 최초 검토 시에는 Web 서버/controller/client 파일이 아직 저장되지 않았다. 위 항목은 확인된 소스 결함 목록이 아니라 구현 전 수용 기준이다. 구현 저장 후 중요한 경계만 읽고 확인 결과를 별도로 덧붙인다. 첫 단위에서 수정된 가설 평가 현재성과 읽기 포트 분리는 유지돼야 한다.

## 8. 구현 중 소스 검토에서 전달한 경계

[서버 계획](P3-web-plan.md)과 [HTTP adapter](../../runtime/src/presentation/web-server.ts)의 첫 저장본을 읽었다. loopback 고정, 정확한 Host/Origin, strict 요청 계약, 인스턴스별 쿠키, 공개 view만의 SSE, poll 전후 세션 만료, 안전한 오류 allowlist, 자산 allowlist를 확인했다. 아래 항목은 구현 담당자에게 전달했으며 최종 소스/시험 결과에서 해소 여부를 확인해야 한다.

1. **세션 확인과 명령 진입의 순서:** body 수신을 기다리기 전에 세션을 검사한 뒤 명령을 실행하면, 수신 중 만료/DELETE된 세션으로 작업이 변경될 수 있다. 응답 직전 검사만으로 이미 실행된 명령을 되돌릴 수 없다. body parse 뒤 명령 진입 직전 검사와 반환 전 공개 검사 둘 다 필요하다.
2. **닫힌 SSE의 진행 중 조회:** 연결 카운트를 즉시 회수해도 이미 시작한 비동기 원본 조회는 끝나지 않을 수 있다. 정기 poll의 실제 in-flight 작업은 연결 수와 별도이며, 만료/재접속이 반복되면 누적될 수 있다. 일반 view GET과 SSE poll이 공유하는 조회 슬롯을 실제 await 완료까지 유지하고 지연 조회 시험으로 상한을 확인해야 한다.

브라우저의 순수 상태 모듈은 snapshot 수락 시 세대를 바꾸고 오래된 generation 응답을 무시하며 unavailable 때 이전 본문/커서를 지우는 구조를 확인했다. 이는 실제 DOM, EventSource 연결 관리, 입력 초점/스크롤 검수 결과가 아니다. 해당 연결 코드와 실제 브라우저 관측은 별도 확인 대상이다.

HTTP adapter의 다음 저장본에서는 body parse 뒤 `currentSession`, 응답 직전 세션 검사, 일반 GET/list/SSE가 공유하는 `readBounded` 슬롯을 확인했다. 슬롯은 실제 비동기 조회 완료까지 유지되고 shutdown도 진행 중 읽기를 기다린다. 위 두 서버 지적의 소스 수정은 확인했으며, 시험은 구현 담당자가 실행한다.

[LocalWorkbench](../../runtime/src/presentation/local-workbench.ts)의 첫 저장본에서는 별도 run Map, 동일 command Promise 합류, durable `web_run_requested` 영수증을 확인했다. pause/cancel은 run 잠금을 기다리지 않으며 같은 run 영수증의 재전송은 조회만 수행한다. 추가로 아래 두 경계를 담당자에게 전달했다.

3. **시작 전 목표 변경:** g1 run intent commit 뒤 ACK가 늦는 동안 g2 목표 변경이 끝나면, 최신 상태를 다시 읽는 fixture plan이 g2를 계획·실행할 수 있다. 아직 시작하지 않은 실행이 승인된 `expectedGoalRevision`을 벗어나지 않게 최초 계획/실행 진입까지 전제를 유지해야 한다.
4. **목록의 업무 간 현재성:** A의 view를 모은 뒤 B를 기다리는 동안 A의 공개 권한이나 원본이 철회되면, 최종 목록에 A의 예전 제목/준비 상태가 남을 수 있다. 반환 후보 전체를 제한된 횟수로 재검사하고, B 조회 중 A의 screen 권한을 철회하는 회귀를 포함해야 한다. 모든 저장소에 걸친 전역 원자성을 주장하는 요구는 아니다.

다음 controller 저장본에서 `fixturePlan`과 workflow 최초 진입의 목표 revision 고정, 목록 반환 후보의 최대 3회 재검사를 확인했다. 두 저장소 회귀에는 지연된 run intent ACK 중 목표 변경과 목록 B 조회 중 A의 권한 철회가 들어 있다. 이 기록은 소스와 시험 정의를 읽은 결과이며 시험 실행 결과가 아니다.

## 9. 클라이언트 연결 코드의 확인 사항

[브라우저 client](../../runtime/src/presentation/web/client.ts)는 SSE payload를 바로 렌더링하는 대신 최신 GET 신호로 사용하도록 변경됐다. GET을 직렬화하고, work 선택/세션/요청 generation이 바뀌면 늦은 응답을 버리며 명령 응답의 과거 view를 직접 적용하지 않는다. text node 렌더링, 메시지 ID별 DOM 보존, 입력 중 draft와 기존 스크롤 위치를 다루는 코드도 확인했다. 실제 한글 조합·focus·scroll·좁은 화면은 담당자의 브라우저 검수로 확인해야 한다.

클라이언트 첫 저장본에서 아래 보완을 전달했으며 최종 검증 기록에서 해소 여부를 확인해야 한다.

- accept는 매 제출마다 새 request ID를 생성하면 commit 뒤 응답만 유실된 경우 수동 재제출로 업무가 중복된다. 미확정 접수의 동일 payload/ID를 보존하고, 사용자가 내용을 바꿨을 때만 새 요청으로 구분한다.
- 열린 연결의 `session_expired` 이벤트와 달리, 단절 중 만료된 세션의 EventSource 재연결은 HTTP 401과 `error`만 올 수 있다. 오류 시 제한된 세션/공개 조회를 수행해 401/403을 관측하면 기존 본문을 제거해야 한다.
- 업무의 unavailable/권한 거절 때 목록 응답의 generation도 무효화한다. 먼저 시작된 목록 응답이 나중에 도착해 제거된 업무의 제목을 다시 넣지 않아야 한다.
- 저장 status가 completed여도 `resultReady=false`이면 현재 결과 재확인이 필요하다는 상태를 함께 표시한다. 이전 실행의 완료와 현재 원본을 통과한 결과를 구분한다.

frontend 동결 알림 뒤 최신 저장본을 다시 읽어 위 네 항목의 수정을 확인했다. `BrowserRequestIdentity`는 같은 화면에서 미확정 접수의 동일 payload/ID를 유지하고, SSE error는 합쳐진 최신 GET으로 세션/권한 실패를 확인한다. `invalidate`는 목록 epoch도 바꾸며, 목록과 본문 모두 `needsResultRecheck`를 사용한다. 조회는 enqueue 시 queue/선택/세션 epoch와 실행 시 snapshot generation을 검사한다. 대응 helper 시험 정의 17개를 읽었으며 직접 실행하지 않았다. 접수 ID 보존은 현재 JS 메모리 범위이고, 페이지를 완전히 다시 연 뒤의 미확정 접수 자동 복구까지 검증한 것으로 확대하지 않는다.
