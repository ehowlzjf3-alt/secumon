# C09 A2A와 사건 대기 구현 진행

2026-09-08 기준 구현 중이다. 기존 업무·세션·시도·사용량 장부를 재사용하고, 상세 회귀와 실제 상대 시스템 연동은 이후 검증 단계에 둔다. 이 문서는 전체 C09 완료 보고가 아니다.

## 연결한 경로

`HostA2aRegistration`과 `HostMissionRegistration`은 호스트가 코드로 주입한다. 등록이 없으면 open이나 도구 활성화를 하지 않는다. 구성의 `features.a2a`와 `features.missions` 선택, 일반 프로필/CLI 조립은 별도 통합 위치다. 엔드포인트·인증 헤더·공급자·관측 callback을 사용자 원문이나 모델 입력에서 받지 않는다.

- [host-a2a.ts](../../runtime/src/presentation/host-a2a.ts)의 `openHostA2a(registration, context)`는 `peer`, `tools`, `sources`, `allowedTools`, `allowWrites`, `close`를 반환한다. `createJsonRpcA2aRegistration(options, {allowWrites})`로 JSON-RPC 공급자를 만든다. 기본은 읽기만 공개하며 명시 쓰기 허가가 있어야 송신·취소 도구를 공개한다. 실제 정책의 도구·라벨·목적지·쓰기 권한도 별도로 검사한다.
- [host-missions.ts](../../runtime/src/presentation/host-missions.ts)의 `openHostMissions(registration, context, {services}, additionalSources)`는 고정한 sources와 `MissionRuntime`을 제공한다. A2A의 reply sources를 추가할 수 있으나 그것만으로 missions가 활성화되지는 않는다. `mission.events`는 현재 업무의 임무 목록 또는 선택한 임무의 사건 원문을 읽는다. 관리자의 임무 등록·해제·드라이버 호출은 공개 클래스 API이며 모델 쓰기 도구로 가장하지 않는다.
- [mission-sources.ts](../../runtime/src/infrastructure/mission-sources.ts)는 예약 시각, 호스트의 관측 callback, A2A task 회신 세 종류를 제공한다. 예약이 밀렸을 때 최신 사건 하나와 건너뛴 횟수를 기록한다. 관측/회신은 원문의 지문 변화만 새 사건으로 반환한다. 같은 사건의 재관측 시 수신 시간을 바꿔 별개 사건으로 만들지 않는다.

## A2A 범위

[공식 A2A 1.0 명세](https://a2a-protocol.org/latest/specification/) 중 JSON-RPC `SendMessage`, `GetTask`, `CancelTask`와 text/data part를 지원한다. 요청 ID·응답 ID, task ID, 버전 헤더, 엄격한 반환 형식, 요청/응답 크기 및 시간을 확인한다. `SendMessage`는 즉시 task/message 반환을 요청한다. task 상태의 완료는 상대의 상태 보고이며 로컬 목표 완료나 검증된 Evidence로 변환하지 않는다.

자동 카드 탐색, 인증 획득, 파일 part, SSE·push·REST·gRPC, 확장 실행은 구현하지 않았다. 리다이렉트·버전 후퇴·자동 재전송도 없다. 쓰기 요청 후 결과를 알 수 없으면 기존 write 시도의 unknown/effect 조정 경로에 남는다. A2A 요청 ID만으로 상대의 중복 처리 방지나 외부 효과 영수증을 보장한다고 주장하지 않는다. 원격에서 확인된 늦은 쓰기 응답은 거짓 미실행으로 바꾸지 않고 기존 receive/adopt의 현재 권한 판단에 맡긴다.

[host-a2a-server.ts](../../runtime/src/presentation/host-a2a-server.ts)의 `openA2aRequestHandler`는 외부 요청을 받는 호스트용 handler다. 호스트가 먼저 인증한 callerId와 actor를 고정하고, caller별 peer 세션에 `SessionService`/`AgentTurnService`로 접수한다. payload에서 다른 담당·권한·임의 세션을 선택하지 못한다. 동일 messageId는 원문과 저장된 접수/명령 영수증을 대조한다. `SendMessage`는 `returnImmediately:true`인 부분집합만 지원하며 기존 작업에 대한 후속 입력 또는 단일 질문 답변도 저장한다. 접수는 모델 실행을 시작하지 않으며 호스트가 반환된 `run(taskId)`나 사건 driver를 호출한다. blocking SendMessage를 구현한 것처럼 조기 반환하지 않고 해당 요청을 명시 거절한다.

`GetTask`는 현재 결과 증명을 통과하고 해당 caller 경로로 이미 전달된 결과만 반환한다. 상태 조회로 모델을 실행하지 않는다. `CancelTask`는 원 소유자·목표 버전과 세션 명령 영수증을 유지한다. `a2aAgentCard`는 호스트의 실제 URL·인증 선언과 위 지원 범위를 담은 카드 객체를 만든다. HTTP listener, 인증 미들웨어, well-known 카드 게시나 네트워크 배포는 이 helper가 수행하지 않는다. handler 내부 오류는 호스트가 응답/로그 정책으로 처리하며 내부 오류 원인을 원격 본문에 자동 노출하지 않는다.

## 업무 안의 대기와 재개

[MissionRuntime](../../runtime/src/application/mission-runtime.ts)의 `register(workId, rule)`은 source/resource, polling 간격, 최대 재개·무진전·빈 관측 횟수를 명시적으로 받는다. 기존 SQLite/file-journal 업무 저장소의 subscription과 artifact/명령 영수증에 cursor, 최근 사건 원문, 중복 ID, 재개 횟수, claim을 저장한다. 새 DB나 개인 기억을 만들지 않는다. 대기 중 `tick`은 원천 관측만 하고, 새 사건이나 이미 진행 중인 continuation이 있을 때에만 기존 `WorkflowRuntime.run`으로 넘어간다. `drive`는 signal과 유한 maxTicks/interval/maxSteps를 받는다.

동일 업무의 다른 임무가 대기 중이라는 이유로 이미 도착한 사건까지 막지 않도록 공통 대기 의무를 사용한다. 사건 본문은 다른 자료처럼 현재 권한·목표·삭제 세대·artifact SHA와 checkpoint 영수증을 대조한다. 목표나 삭제 세대가 바뀌면 이전 구독을 닫고 원문을 새 목표로 넘기지 않는다. source 실패는 다음 polling 시각과 실패 횟수를 보존하며 원 오류를 다시 던진다. 정상 polling에서 아무 사건도 없으면 모델 호출은 없다.

claim은 동시 driver의 중복 진입을 줄이며 진행 단계마다 수명을 확인·갱신한다. 긴 단일 외부 호출이 claim 수명을 넘거나 프로세스가 죽는 경우 최종 중복 송신 경계는 기존 workflow의 시도·모델 호출 소유권과 영수증이다. 임무 claim만으로 전체 workflow를 원자화하거나 exactly-once 실행을 보장하지 않는다. driver signal은 다음 단계/대기를 중단하며 profile 수명 signal은 실제 호출 권한도 폐기한다. 전체 close/drain 원자화 보장은 추가하지 않는다.

## 담당 상시 드라이버와 남은 검증

위 `MissionRuntime`은 한 업무의 알림·대기·재개를 담당한다. 완료·실패·취소된 업무를 다시 열거나 새 사건을 기존 목표에 자동 합치지 않는다. 같은 담당/세션에서 다음 사건을 새 업무로 접수하는 상위 `resident-missions`와 host helper는 별도 담당이 구현·통합 중이다. 그 영속 descriptor/cursor와 `SessionService.accept` 연결이 있어야 담당의 상시 사건 처리 요구까지 구현됐다고 말할 수 있다.

현재 이 파일 작성 시점에는 통합 빌드와 상세 시험을 실행하지 않았다. 후속 검증은 기본 off, 명시 호스트 권한, 두 담당 분리, cursor 재시작·중복 사건·원문 변조, 기다리는 동안 모델 0호출, 무진전/횟수 제한, profile 종료 및 A2A 오류/크기 제한에 집중한다. 실제 상대 에이전트 상호운용·사내 시스템·실제 모델 의미 품질은 미검증이다.
