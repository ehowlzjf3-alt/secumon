# C09 상시 담당의 사건별 업무 접수

2026-09-08. 구현 우선 단위이며 실행·장애·협업 품질을 검증했다는 결과가 아니다.

`application/resident-missions.ts`의 `ResidentMissions`는 기존 `MissionEventSource`와 상태/원문 저장 포트를 사용한다. `register`는 호스트가 지정한 담당·주체·세션·source·instruction·policy·사건별 limits를 고정한다. 명시적으로 생성한 별도 제어 work의 subscription/checkpoint artifact와 원 command receipt에 커서, 다음 poll, 대기 사건, 사건→work 매핑을 기록한다. 새 DB나 개인 장기 기억을 만들지 않는다.

제어 work는 사건용 세션과 다른 deterministic 내부 peer/local 세션에 접수한다. 내부 설정 원문·접수 ack·호스트 질문이 사건용 대화나 compact 문맥에 섞이지 않는다. 처음 접수할 때부터 호스트 소유 pending obligation과 tool/model/token/replan 예산 0을 가진다. 첫 checkpoint 이후 paused 상태여서 일반 runnable 자동 재개 목록에서 빠진다. 제어 work의 수명과 개별 사건의 deadline은 별도다. driver는 이 work를 workflow나 outbox flush에 전달하지 않는다.

`tick`은 정해진 시각에만 한 source page를 poll하고 그 원 사건을 먼저 checkpoint에 저장한다. 이후 사건의 고정 messageId로 기존 `AgentTurnService`→`SessionService.accept`를 사용한다. 중간 중단 뒤 재접수하더라도 원 intake 영수증이 같은 workId로 수렴한다. 고정 instruction과 정확한 사건 JSON은 일반 원문으로 저장하되 외부 관측이 권한 부여나 검증된 Evidence라고 표시하지 않는다. 같은 담당/session을 유지하고 사건별 목표·근거·계획·예산은 서로 다른 work에 속한다. 완료 사건의 재전달은 workflow를 다시 호출하지 않는다.

한 tick은 대기 사건 하나에 대해 실제 `workflow.run`을 수행한다. 입력이 없는 대기·중복·poll 기한 전에는 모델 호출이 없다. 기다리거나 step 한도로 yield한 사건 work는 일반 명시 재개/기존 per-work MissionRuntime 경로에 남긴다. driver가 새 사실 없이 무한 재개하는 기능은 넣지 않았다. source page 32개, checkpoint 512KiB, rule의 idle 한도는 유지한다. seen은 최근 512개 cache이며 자동 종료 조건이 아니다. 오래된 중복은 deterministic messageId로 기존 SessionRepository.input과 권한 검증된 commandContext, conversation.accept 원영수증을 다시 읽어 원문·payload·digest를 대조하고 workflow 없이 건너뛴다. 원 사건/work/영수증/과거 checkpoint를 삭제하지 않는다. 원 영수증이 손상됐거나 접근할 수 없으면 사건을 새 업무로 간주하지 않고 명시 거절한다.

`presentation/host-resident-missions.ts`의 `createHostResidentMissions(dependencies, defaults)`는 같은 host binding의 session alias를 열고 `register/status/tick/drive/stop`을 제공한다. `OpenedHostMissions.sources`를 빌려 사용하며 source close 소유권을 옮기지 않는다. `drive(controller,{signal,maxTicks?,intervalMs?,maxSteps?,onStep?})`는 명시 호스트 호출 후 프로세스 안에서 tick을 계속 수행한다. 기본 최소 간격 1초와 다음 poll/claim 기한을 지키고, 대기는 모델 없는 abortable timer이다. pending page의 나머지 사건은 poll 주기를 다시 기다리지 않고 최소 간격 뒤 처리한다. maxTicks 생략 시 stop/abort/idle 종료까지 계속된다. 오류는 임의 자동 재시도로 숨기지 않는다. close는 driver signal과 timer를 중단하고 진행 중 API/drive가 정리될 때까지 기다린다. 원격 source와 저장소의 종료는 기존 profile 소유자가 그 뒤 수행한다.

미검증/잔여: 실제 timer/A2A→일반 입력의 프로세스 재시작·중복 경합·권한 변경·SIGKILL 인수, 장기간 checkpoint/artifact 용량 관리와 명시 rule 교체, UI/CLI 운영 명령과 OS service 설치, 단독/협업 품질·비용 비교. C09 전체 완료 또는 상시 운영 배포로 표시하지 않는다. 제어 checkpoint와 세션 intake는 기존 두 저장 경계의 receipt로 이어지므로 원문 접수 중 stop이 경합하면 이미 접수된 업무가 보존될 수 있다. 재확인/abort 이후 새 workflow 실행은 하지 않으며 접수 사실을 소급 삭제하지 않는다. 별도 drive signal은 source poll·대기·워크플로 단계 사이에서 적용되며, 이미 시작된 모델/도구 호출은 원 runtime의 유한 호출 수명과 profile close 정책으로 정리한다. controller의 고정 100년 wallTime 예산은 같은 설정의 재접속 intake digest를 유지하며 모델/도구 예산은 0이다.
