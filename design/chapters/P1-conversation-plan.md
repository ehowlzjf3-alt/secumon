# P1-05 — CLI와 접수·전달 의미

2026-09-05 · 구현 전 작성한 계획 · 현재 로컬 검증 완료, [결과 기록](/Users/seunghanee/Documents/secumon/design/chapters/P1-conversation-result.md) 참조

이번 단위는 저장된 업무와 사람이 보는 대화를 연결한다. 내부 도구/재시도 사건을 말풍선으로 복제하지 않고 접수·필요 질문·결과를 남기며 상태는 명시 조회 또는 TTY의 같은 줄에서 보여준다.

## 구현 범위

1. 접수: 인증된 주체와 채널/대화/원본 요청 ID를 받아 중복 없이 work를 만들고 접수 응답 의도를 같은 commit에 저장한다. 저장 실패를 접수 완료로 표시하지 않는다.
2. 대화 수명: conversation/work ID를 구분하고 한 대화의 여러 업무, 새 대화에서 기존 업무 연결을 지원한다. CLI 연결 종료는 취소를 만들지 않고 명시 pause/cancel/goal 변경만 코어 명령으로 보낸다.
3. 준비/완료/전달: 근거 충족으로 검증된 템플릿 답변과 artifact를 준비한다. 전달이 완료 기준이면 별도 delivery 의무를 둬 준비 후 보내고 확인 뒤 완료한다. 질문도 현재 의무에 묶어 한 번 준비한다.
4. outbox: 목표/수신자/정보 등급/출처를 묶은 응답, 발송 의도·lease·시도·delivered/unknown/실패를 기록한다. 외부 효과가 불명확하면 맹목적으로 재전송하지 않는다. 지원되는 sink의 멱등/영수증 조회로 대조하며 이전 목표의 늦은 전달이 새 목표를 완료시키지 않는다.
5. CLI: accept/status/plan/run/pause/resume/cancel/change-goal/resolve/attach/disconnect/messages 명령과 JSON 출력을 제공한다. 기본 출력에는 도구 로그를 넣지 않는다. TTY만 상태 줄을 갱신하고 비TTY에는 ANSI를 쓰지 않는다. 종료 코드와 stdout/stderr를 구분한다.
6. 검증: 저장 실패·중복 입력·다중 업무/대화·원본 목표 변경/취소·질문 중복·전달 실패/unknown·동시 dispatcher·재시작 대조·CLI 별도 프로세스 실행을 확인한다.

코어의 상태/원본/시도·완료 판정, P1-04 composition과 조회를 재사용한다. 대화/전달 필드는 기존 schemaVersion 1 레코드를 읽을 때 기본값을 주어 이전 P0/P1 저장 시험을 유지한다. 저장소 port는 의미 중심으로 확장하고 SQL은 adapter에 둔다.

CLI의 최초 실행 profile은 합성 fixture와 로컬 저장 채널이다. 계획은 명시 JSON 또는 합성 예제에서 제공하며 자연어 이해/새 모델 추론을 가장하지 않는다. 실제 모델의 가설·계획 갱신과 토큰 정산은 P1-06, Web/Knox의 인증·송수신·UI 실연동은 P3에서 이어 검증한다.

로컬 채널의 delivered는 로컬 수신 저장소 기록 확인이다. 실제 Knox API 수락·사람의 읽음 확인과 동일하다고 해석하지 않는다. 작업을 닫아도 백그라운드에서 무조건 실행된다고 표시하지 않고 현재 worker가 없는 경우 저장 상태에서 다시 실행할 수 있음을 설명한다.
