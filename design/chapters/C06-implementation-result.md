# C06 구현 연결 결과

2026-09-08. **CLI/Web/Knox의 대화 입구와 최소 설치·담당 배치 연결을 구현했고 최종 빌드가 통과했다. 기능 인수·실제 연동·운영체제별 검증은 아직이다.** 전체 기능 구현 우선 정책에 따라 다음 구현은 C07이다.

## 재사용과 변경

- 지속 세션, 원문 이력, compact, 접수/질문/결과 발신함, 업무 상세 보기, 모델/도구 등록은 기존 구현을 재사용했다. 새로운 에이전트 루프나 대화 DB를 만들지 않았다.
- CLI에 초기 저장 방식 선택을 연결했다. 기본 SQLite와 선택 file-journal을 첫 setup 기록에 저장하고 중단 후 같은 선택으로 복구한다. 기존 담당에 다른 방식을 지정하면 임의 전환하지 않는다. 일반 chat에 pause/cancel과 명시 일시정지 해제를 추가했다. 같은 입력 ID 재전달은 상태만 보여주고 모델 실행을 다시 시작하지 않는다.
- Web은 기억/원문 최신성 오류를 권한 오류와 구분하고, 이전 본문을 숨긴 상태에서 기억 관리 경로를 제공한다. 해결된 조회/연결 안내를 정리하고 같은 담당·지속 대화의 선택 작업 ID를 재접속 때 다시 조회한다.
- Knox는 신뢰된 호스트가 등록하는 전송 어댑터와 범용 대화 입구를 추가했다. 접수 후 기존 발신함으로 안내하고 실제 실행은 별도 호출한다. 상태/이력 조회는 읽기만 수행하며 제어 지시는 기존 영속 명령으로 처리한다.
- 실제 전달이 확인된 외부 응답은 기존 채널 SQLite와 세션 이력에 한 트랜잭션으로 저장한다. 발신함의 unknown(전달 여부 미확인), 원격 조회, 동일 요청 재전송 가능성을 재사용한다. 로컬/Knox 경로별 재시도 보장을 구분하고 단순 서버 수신을 사람의 읽음으로 표시하지 않는다.
- 패키지에 빌드된 제품 계층, 기본 실행 fixture, Web HTML/CSS, guidance, 배치 예제를 포함하도록 지정했다. [두 담당 배치 예제](../../runtime/examples/two-agents.md)는 공통 엔진 밖의 담당별 디렉터리·설정·기억을 사용한다.

## Knox 연결 방법

공개 연결 입구는 runtime/src/presentation/agent-knox.ts의 openAgentKnox다. 기존 실행 호스트의 models/tools 등록과 함께 knox.destination 및 knox.transport를 전달한다. transport는 사내 MCP의 실제 도구명·인증·요청/응답 형식을 이 작은 계약에 매핑한다. 여기서 사내 규격을 추측하거나 접속하지 않았다.

- send는 안정된 idempotencyKey(같은 메시지의 중복 전달을 막는 식별자), conversationId, recipientId, text, kind를 받는다. 전달 확인 시 externalId를 반환한다.
- lookup은 선택 기능이다. 해당 키의 원격 전달 상태를 확인할 수 있어야 absent를 반환한다. 단순 검색 누락·일시 장애·확인 불가는 unknown이다.
- capabilities.idempotentSend는 실제 공급자가 같은 키로 중복 전송을 막을 때만 true다. 지원하지 않으면 전달 여부 미확인 메시지를 자동 재전송하지 않는다.
- 호스트가 인증한 tenantId/principalId와 대화 ID로 인스턴스를 연다. 인증 주체는 실행 profile의 주체와 일치해야 한다. 메시지 본문으로 담당/수신자/실행 모듈을 선택하지 않는다.

호출 순서는 openAgentKnox → conversation.accept → 새 접수인 경우 conversation.run이다. accept는 모델을 호출하지 않고 지시를 저장·접수 안내한다. 같은 messageId 재전달은 accepted=false이며 run을 자동 호출하지 않는다. 중단 후 기존 sessionId로 다시 열고 status/history로 확인한 뒤 명시 run으로 이어간다. 후속 입력은 followUp, 목표 변경은 changeGoal, 일시정지/재개/취소는 control을 사용한다. 이 공개 API들을 기존 MCP 수신 루프에 연결하는 배포 코드와 인증 매핑은 사내 연결 조건에 따른 잔여다. 예약·사건에 따른 자동 깨우기는 C09 범위다.

CLI 제어 예: secumon-agent chat pause --directory 담당경로 --provider registered --work 업무ID --message-id 새입력ID --goal-revision 현재버전 --text '잠시 멈춰'. 취소는 cancel, 명시 일시정지 해제는 resume에 같은 종류의 옵션을 준다. 작업 취소가 담당의 대화나 장기기억을 초기화하지 않는다.

## 확인한 범위와 남은 검증

최종 npm run build는 macOS의 Node 24.20.0에서 actual exit 0이다. [최종 로그](../../runtime/evidence/C06-build4.log). 최초 빌드의 WorkView 인자 및 공통 profile의 sink 타입 오류를 교정했고 실패 로그도 남겼다. 이후 빌드2/3도 통과했으며 마지막 CLI 제어 연결까지 포함한 결과는 build4다. 빌드 성공은 동작 시험 통과를 뜻하지 않는다.

[별도 검증 목록](C06-C10-verification-plan.md#c06)에 실제 채널 중복/재개/취소, 세션 격리, Web 표시, 패키지 생성·격리 설치, Linux/native Windows 및 Knox 실제 연결을 남겼다. 추가 상세 시험·브라우저·npm pack·설치·SSH·실제 모델/API·사내 접속·배포는 실행하지 않았다. 모델/API 중단과 C01~C05 남은 범위도 유지한다.

세부 변경 기록: [설치/초기화](C06-install-progress.md), [Web 표시](C06-web-notices-progress.md), [대화 연결 계획](C06-channels-plan.md). 다음은 기존 게시판·아카이브 기반을 담당별 선택 설정과 일반 실행 입구에 연결하는 C07이다.
