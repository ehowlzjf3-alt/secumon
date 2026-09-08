# C09 순차 검증 준비 — A2A·사건 재개·상시 담당

2026-09-08. C08 잔여 인수와 병렬로 작성한 **정적 코드 확인·검증 준비**다. 읽기 시작 기준 HEAD는 `3d75c031f53e4c62a244832b2f4b21043429805f`이며, C08 후속 변경이 진행 중이므로 다음 실행에서는 최종 source/build를 다시 고정한다. **이 문서 작성 중 제품·시험 수정, 빌드, 시험, 모델/API, 외부 통신은 실행하지 않았다.** C09 통과 수나 완료 판정을 만들지 않는다.

요구는 [이행 계획의 C09](../03-migration-plan.md), [V09-01~05와 통합 추가 항목](C06-C10-verification-plan.md), [통합 구현 결과](C06-C10-implementation-result.md), [배치 예제](../../runtime/examples/missions-a2a.md)를 따른다. 이전 [A2A 구현 노트](C09-a2a-missions-progress.md)의 “일반 프로필/상시 driver 통합 중” 문장은 작성 당시 이력이다. 현재 연결을 다시 만들지 않는다.

## 현재 구현과 실제 미확인 연결

| 경계 | 현재 소스에서 확인한 연결 | 아직 동작 인수로 확인하지 않은 것 |
| --- | --- | --- |
| 일반 프로필·선택 기능 | [agent-turn-profile.ts](../../runtime/src/presentation/agent-turn-profile.ts)는 `features.a2a`와 `features.missions`를 별도로 선택한다. A2A는 발신 등록 또는 명시 `a2aInbound:true`, missions는 source 등록이 필요하다. 후자는 조립 뒤 `mission.events`를 실제 tool catalog에 등록한다. | off에서 등록 getter/open·도구·대기 실행이 없는지, on+미등록 거절, inbound만/발신만/missions만/조합, 부분 open 실패·close 중 진행 호출 정리. 등록됐다는 이유로 driver나 listener가 자동 시작되는 것으로 보지 않는다. |
| A2A 발신 | [host-a2a.ts](../../runtime/src/presentation/host-a2a.ts) → [a2a-json-rpc.ts](../../runtime/src/infrastructure/a2a-json-rpc.ts). 호스트가 endpoint·인증·상대·목적지를 고정한다. 기본 get만, 명시 쓰기 등록은 send/cancel을 추가한다. 현재 구현이 선택한 부분은 A2A 1.0 JSON-RPC SendMessage/GetTask/CancelTask와 text/data다. | strict 입력·응답/ID/task ID·버전·크기·시간·중단, 일반 모델 도구 호출과 실제 송수신 연결. remote ACK/completed를 로컬 Evidence·목표 완료로 올리지 않는지, 미확정 write를 자동 재송신하지 않는지. |
| A2A 수신 | [host-a2a-server.ts](../../runtime/src/presentation/host-a2a-server.ts)의 handler를 `profile.openA2aHandler`로 연다. 호스트 인증 후 caller/actor를 고정하고 caller·tenant·principal별 peer 세션을 연다. `handle('1.0', request)`의 접수/조회와 명시 `run(taskId)`를 분리한다. | 새 일반 profile에서 최초 접수→ACK→명시 실행→현재 전달 결과 조회, 같은 messageId 재전달, 기존 task 후속 입력/질문 답변, 취소, 다른 caller/담당의 접근 거절, handler 재열기·close. 지원 부분을 실제 상대와 상호운용했다는 판정은 별도다. |
| 한 업무의 대기 | [mission-runtime.ts](../../runtime/src/application/mission-runtime.ts)의 register/refresh/tick/drive가 현재 업무의 subscription·원문 artifact·command receipt·cursor·claim을 사용한다. [mission-sources.ts](../../runtime/src/infrastructure/mission-sources.ts)는 예약/관측 callback/A2A 회신 source다. | 빈 poll/기한 전/중복에 모델 호출 0, source 오류 이후 cursor 보존, 새 사건 또는 저장 continuation만 재개, 권한·goal·삭제 세대 변경, idle/resume/no-progress 제한과 claim 경합. 종료 업무를 자동 재개하는 기능이 아니다. |
| 같은 담당의 다음 사건 | [resident-missions.ts](../../runtime/src/application/resident-missions.ts) + [host-resident-missions.ts](../../runtime/src/presentation/host-resident-missions.ts). `profile.createResidentMissions(defaults).register(...)`는 별도 paused 제어 work와 사건용 지속 세션을 연결한다. 제어 work 예산은 0이며 각 사건은 일반 `AgentTurnService`/`SessionService.accept`로 새 work를 만든다. | 사건 A 종료 후 사건 B는 같은 세션·다른 work/목표/계획/근거/사용량인지, compact/reopen 뒤 이어지는지, 제어 설정/ACK가 사건 대화에 섞이지 않는지. 최근 512개 목록 밖의 중복도 원 intake/accept 영수증으로 건너뛰는지, 중단·늦은 사건에도 사건별 경계가 유지되는지. |
| 게시판과 조합 | [compose-runtime.ts](../../runtime/src/application/compose-runtime.ts)는 기존 BoardWatch와 mission notifications의 current/refresh를 합성한다. 게시판 구독은 기존 `boardWatch` API다. | board+missions를 함께 켰을 때 서로의 알림을 무효로 보거나 빈 mission 때문에 도착한 board 사건을 막는지 좁게 확인한다. 게시판 전용 MissionEventSource나 자동 source 변환이 이미 있다고 가정하지 않는다. |

임무의 “대기”와 프로세스 상주, 모델 호출, 사건 업무의 수명은 별개다. Resident driver는 기다리거나 yield한 사건 work를 다음 poll마다 무조건 재실행하지 않는다. 이 work의 명시 재개 또는 per-work MissionRuntime 연결을 확인한다. 원문 접수 도중 stop이 들어오면 이미 저장된 접수 사실은 남을 수 있지만, stop 확인 뒤 새 workflow 실행을 허용해서는 안 된다.

## 먼저 재사용할 기존 시험과 fixture

이번 정적 검색에서 `A2aJsonRpcPeer`, `openHostA2a`, `openA2aRequestHandler`, `MissionRuntime`, `ResidentMissions`, `compareCollaboration`을 직접 인수하는 기존 `src/tests` 시험은 찾지 못했다. `a2a`라는 disclosure surface 또는 feature false를 검사한 시험을 A2A 구현 인수로 세지 않는다.

| 재사용 파일 | 이미 있는 판정/재료 | C09에서 새로 붙일 부분 |
| --- | --- | --- |
| [agent-deployment-entry.test.ts](../../runtime/src/tests/agent-deployment-entry.test.ts), [fixture](../../runtime/src/tests/agent-deployment-entry-fixture.ts), [host-tool-entry-fixture.ts](../../runtime/src/tests/host-tool-entry-fixture.ts) | 임시 디렉터리·host registry, 일반 등록 모델, 독립 담당/세션·기억, off 상태. | C09 등록·입구를 추가한 별도 fixture에서 재사용한다. 기존 시험은 missions/a2a off이며 실제 사건 접수를 확인하지 않는다. CLI/Web/Knox 전체에 같은 조합을 복제하지 않는다. |
| [sqlite-sessions.test.ts](../../runtime/src/tests/sqlite-sessions.test.ts), [agent-turn-flow.test.ts](../../runtime/src/tests/agent-turn-flow.test.ts), [helpers](../../runtime/src/tests/agent-turn-flow-helpers.ts), [conversation.test.ts](../../runtime/src/tests/conversation.test.ts) | route별 세션, 원 입력/명령 영수증, 접수·질문·응답·전달, 중복 및 소유자 경계. | 실제 A2A caller route와 resident 사건 messageId가 기존 접수/명령 경로를 이용하는지 확인한다. 세션 저장 알고리즘의 전체 행렬은 다시 작성하지 않는다. |
| [session-context-runtime.test.ts](../../runtime/src/tests/session-context-runtime.test.ts), [session-compact-runtime.test.ts](../../runtime/src/tests/session-compact-runtime.test.ts) | 다음 업무의 문맥, 원문 참조, compact 수신/게시 복구, 목표·권한 변화와 usage 보존. | 같은 resident 세션에 사건 둘과 compact/reopen을 한 번 끼운 인수로 연결한다. 제어 세션과 사건 세션의 비합침도 함께 확인한다. |
| [board-wake-runtime.test.ts](../../runtime/src/tests/board-wake-runtime.test.ts), [board-change-store.test.ts](../../runtime/src/tests/board-change-store.test.ts), [board-deployment-entry.test.ts](../../runtime/src/tests/board-deployment-entry.test.ts) | 게시판 cursor·누락 wake·중복 활동 0·권한/goal/세대 변경·compact·독립 profile. | 기존 게시판 의미는 재사용하고 board+mission notifications 조합 한 사례를 추가한다. 기존 BoardWatch 시험을 새 MissionRuntime의 claim·source·resume 인수로 합산하지 않는다. |
| [recovery.test.ts](../../runtime/src/tests/recovery.test.ts), [agent-sqlite-recovery-process.test.ts](../../runtime/src/tests/agent-sqlite-recovery-process.test.ts), [effect-proofs.test.ts](../../runtime/src/tests/effect-proofs.test.ts) | 기존 시도/소유권·미확정 효과·재시작/프로세스 정리의 기반. | C09의 checkpoint 저장→일반 접수→사건 work 연결 사이 중단에만 새 재현점을 둔다. 다른 기능의 SIGKILL 통과를 C09 프로세스 중단 통과로 간주하지 않는다. |
| [execution-evaluation.test.ts](../../runtime/src/tests/execution-evaluation.test.ts), [collaboration-evaluation.ts](../../runtime/src/application/collaboration-evaluation.ts) | 전자는 고정 oracle·유용한 답변/목표 완료·지연·unknown 사용량 판정. 후자는 비교 구현이며 전용 시험은 아직 없다. | 같은 문제의 단독/협업 결과와 모든 참여 work의 원 사용량 집계, 후원 장부 중복 합산 제외, 누락 참여자/진행 중 호출/unknown이면 비용 미완전 판정을 추가한다. |

## 새 인수 단위와 권장 순서

아래 파일명은 **작성할 후보이며 아직 생성하거나 실행하지 않았다.** 필요한 공통 helper를 재사용하고, 첫 실패의 제품 경계가 확인되기 전에는 전체 장애 행렬을 확장하지 않는다.

1. **A2A 등록·왕복부터 확인한다(V09-01/03).** 후보 `a2a-json-rpc.test.ts`, `a2a-entry.test.ts`, `a2a-entry-fixture.ts`. 실제 일반 profile 두 개와 유한 구조화 모델 대역을 사용하고, client의 주입 `fetch`를 수신 handler에 연결해 JSON-RPC 원 요청/응답을 검사한다. 실제 HTTP listener 없이 in-process transport를 썼음을 기록한다. 발신 send/get/cancel, 수신 최초 SendMessage의 모델 0회 ACK→명시 run→전달된 결과 GetTask, caller별 격리·동일 messageId/different body 충돌·reopen·질문 답변·취소를 잇는다. metadata/data로 endpoint·actor·session을 선택하지 못하게 한다. 일부만 도착하거나 송신 후 응답 유실이면 기존 unknown/의무를 유지하고 자동 재송신은 0이어야 한다. 크기·지원하지 않는 버전/형식·잘못된 ID·timeout/abort는 전송 계약 시험으로 좁힌다.
2. **사건 원문과 업무 재개를 확인한다(V09-02/03/04).** 후보 `mission-sources.test.ts`, `mission-runtime.test.ts`, `resident-missions-entry.test.ts`와 fixture. fake clock으로 예약 지연은 최신 사건 하나·건너뛴 횟수, 관측/회신 동일 원문은 새 사건 0, cursor 역행·같은 ID 다른 원문은 거절을 확인한다. 이어 실제 일반 profile의 `missions.register/tick`과 모델이 호출하는 `mission.events`를 연결한다. 사건 본문을 읽는 행위 자체는 Evidence나 개인 기억을 만들지 않는다. 빈 source 하나와 새 사건 source 하나를 함께 두어 필요한 업무만 재개하고, board+mission 합성도 기존 BoardWatch 경로에 연결한다. 반복 조회/의미 없는 재개에 기본 무진전 한도를 높이지 않는다.
3. **지속 담당의 사건별 분리와 복구를 확인한다(V09-03/04).** 위 entry fixture에서 `createResidentMissions→register→tick/drive→status/stop`을 실제로 호출한다. 독립 디렉터리·DB·agentId/scope의 담당 둘에 같은 rule/event ID를 주어 서로의 업무·단기 문맥·개인 기억을 읽거나 덮지 않는지 확인한다. 같은 담당에서는 사건 A/B가 같은 세션을 잇되 work별 상태는 분리한다. compact/reopen, 대기 사건의 명시 재개, 완료/취소 사건 재전달, 최근 목록에서 제거된 옛 사건의 원영수증 조회를 확인한다. 옛 원문/receipt 변조·소실은 새 work 생성으로 우회하지 않는다. 중단 지점은 우선 **source page checkpoint 이후**, **사건 접수 완료/제어 checkpoint 반영 전**, **workflow 완료/대기 목록 제거 전**으로 한정한다. 장애 주입과 실제 자식 프로세스 SIGKILL을 구분하고, 후자는 새 프로세스에서 동일 controller/session/cursor로 복구했을 때만 통과다. 동시에 두 driver의 claim, stop/close 중 poll·접수·run, drive 종료 후 store close 순서를 유한 gate와 finally 정리로 확인한다.
4. **비교 집계는 연결 인수 뒤 수행한다(V09-05).** 후보 `collaboration-evaluation.test.ts`. 기존 oracle을 재사용해 동일 문제/모드/정답 조건의 단독·협업 결과를 비교한다. 참여 work를 owner 주소로 구분하고 원 `budget.used`만 합산하며, 같은 원장 snapshot 중복·상충 snapshot·빠진 참여자·미확정 usage를 검사한다. C08의 실제 로컬 profile fixture 결과를 활용할 수 있지만 C08의 반환/재배정·활성 grant compact·peer 접수 중단 시험을 C09에서 재작성하지 않는다.

첫 실행 범위는 1번의 off/on 등록과 최초 왕복·재전달·caller 격리다. 이것이 정상으로 연결된 다음 2→3→4를 진행한다. 위 표의 기존 시험은 해당 제품 경계가 변하거나 실제 실패가 나타난 경우에만 관련 묶음을 다시 실행한다. 각 단위는 writer 동결→root 빌드→선택 실행으로 묶고 source/build 지문, 명령, 원로그, terminal exit, 고유 사례와 재실행 수를 구분한다.

## 완료로 표시하지 않을 범위

실제 모델/API 시험 중단은 유지한다. 로컬 유한 모델 대역의 단독/협업 점수·지연·사용량은 해당 합성 문제의 기록이며, 사내 모델의 의미 판단 품질이나 실제 운영 비용을 입증하지 않는다. 외부 A2A 상대 상호운용, 인증·HTTP listener·AgentCard 게시, 사내 MCP/Knox/관측 source, PostgreSQL 실환경, 현재 Linux/native Windows와 OS service 설치·장기 운영은 이 준비 문서의 검증 대상이 아니다. streaming·push·file part·자동 discovery나 인증 획득은 현재 구현의 지원 부분에 포함되지 않는다.

장기간 checkpoint/artifact 보존·용량 관리, rule 교체와 운영 명령/UI는 [상시 담당 구현 노트](C09-resident-driver-implementation.md)의 잔여 범위로 남긴다. 로컬에서 확인 가능한 첫 실행·재전달·격리·중단 복구를 외부 환경 부재 때문에 미루지 않되, 로컬 통과를 전체 C09 또는 운영 배포 완료로 승격하지 않는다.
