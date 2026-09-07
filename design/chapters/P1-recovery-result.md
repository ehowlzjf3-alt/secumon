# P1-07 — 재개 패킷과 첫 전체 흐름: 로컬 결과

2026-09-05 · 로컬 계약 검증 완료 · 실제 모델 선행 조건은 미충족

[계획](/Users/seunghanee/Documents/secumon/design/chapters/P1-recovery-plan.md)에 따라 저장 상태에서 재개 입력을 만들고, 접수→계획/실행→근거→결과 준비→전달→완료를 공통 WorkflowRuntime으로 연결했다. Node 24.20.0에서 전체 **164개 시험**, 안쪽 계층 34파일·위반 0, 두 업무군 4시나리오·22개 완료/제어 판정이 통과했다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P1-recovery-local-verification.json)

## 대화를 잃어도 무엇이 남는가

| 저장물 | 역할 | 잃거나 오래된 경우 |
|---|---|---|
| WorkState와 사건 이력 | 목표·계획·가설·의무·호출/사용량·현재 상태 | 이번 구현은 정상 저장소에서 읽는다. 백업 복원은 P6 |
| 원본/도구 결과/모델 입력·응답 artifact | 실제 수집·호출 근거 | 없는 참조 ID를 오류로 보고하고 실행 시작을 거부 |
| 내부 ResumePacket | 같은 revision의 재개용 구조화 자료 | 현재 상태와 비교 후 재생성 가능 |
| 모델 ContextPacket | 이번 계획/평가 호출에 필요한 허용 자료 | 호출마다 현재 상태에서 구성하고 전송 한도 검사 |
| outbox와 채널 영수증 | 준비한 답변·발송 의도·전달 확인 | 불명확하면 대조하고 허위 완료/무조건 재발송을 막음 |

ContextRecovery는 state→events/outbox→state의 revision을 맞추고 사건 sequence/revision 연속성을 확인한다. 원본 참조의 존재/무결성, 현재 권한, 도구 명세 digest를 확인한 뒤 파생 패킷을 저장한다. 이전 패킷 전체를 현재 재구성 내용과 대조하므로 일부 목표·예산을 위조하거나 오래된 취소 전 패킷을 넘겨도 현재 상태를 덮어쓰지 않는다.

패킷 저장은 업무 commit을 만들지 않는다. 같은 상태에서는 같은 content reference를 재사용하며 패킷을 state.artifacts에 누적하지 않는다. 새 프로세스는 workId만으로 재구성할 수 있고, 이전 패킷 참조는 비교/진단에 사용할 수 있다. 저장 중 상태가 바뀌면 제한된 횟수로 다시 확인한다. 원문·이벤트 payload·outbox 메시지 본문은 내부 패킷에 복사하지 않는다. 현재 사실, 가설이 인용한 허용된 과거 근거, 원본 위치/참조와 미확정 호출/전달 상태는 보존한다.

모델 입력에는 현재 목표의 시도 장부, 예산, 기한, 가설 평가 기준을 추가했다. 실행용 패킷 전체를 모델로 보내지 않는다. 권한이 철회된 시도 artifact metadata와 가설 평가의 근거 ID가 새 모델 입력에 남는 경로를 독립 검토에서 찾아 차단했고 회귀 시험을 추가했다.

## 어디서 종료됐는지가 재개 행동을 결정한다

아래는 명시적 합성 계획으로 실제 child process를 SIGKILL하고 업무/원본/수신 채널 저장소를 다시 연 결과다. 원천 호출과 발송 횟수는 별도 SQLite 원장으로 확인했다. 문서·관측 두 업무군에 각각 같은 네 구간을 적용했다.

| 강제 종료 구간 | 재개 후 원천 호출 누계 | 결과 발송 누계 | 확인한 동작 |
|---|---:|---:|---|
| 도구 예약 후 실행 전 | 1 | 1 | 만료 예약을 정리하고 한 번 실행 |
| 읽기 응답 수신 후 저장 전 | 2 | 1 | 저장되지 않은 읽기는 허용된 재시도 수행 |
| 응답 저장 후 수락 전 | 1 | 1 | 저장한 응답 수락, 원천 재조회 없음 |
| 수신 채널 저장 후 outbox 확인 전 | 1 | 1 | 영수증 대조, 추가 결과 발송 없음 |

별도 합성 쓰기 시험은 효과 발생 후 응답 저장 전에 종료했다. 재개와 재재개 뒤에도 원천 호출 1회, 결과 발송 0회, effect=unknown과 미해결 대조 의무를 유지했다. 이 시험은 로컬 합성 효과의 복구 보장이며 실제 시스템의 exactly-once 보장이 아니다.

모델 대역 경로는 두 업무군에서 응답 수신 뒤 runtime 인스턴스를 바꾸고 이전 패킷을 전달했다. 저장된 제안을 수락해 모델 대역 1회·원천 도구 1회·접수/결과 각각 1회로 완료했다. 이는 실제 provider process/통신 시험과 구분한다. 기존 P1-06의 SQLite 모델 응답 재개 시험도 전체 검증에 포함된다.

## 사용자에게 보여주는 상태도 함께 맞춘다

WorkflowRuntime은 단계 상한과 대기에서 제어를 반환한다. unknown 전달은 다음 명시 실행에서 제한된 대조를 수행한다. unknown→unknown 사건으로 revision이 늘었다는 이유로 계속 재조회하지 않는다. 종료 패킷 저장 중 목표가 바뀌면 이전 목표의 complete를 반환하지 않는다.

CLI는 공통 workflow를 사용하며 합성 명시 계획을 기본으로 유지한다. 모델이 없는 실행은 plan_required로 반환한다. 상태·채널 메시지·outbox를 같은 revision으로 맞춰 보여주고, 새 반증으로 무효화된 과거 결과나 취소 후 과거 답변을 현재 결과로 재표시하지 않는다. 업무 실행 결과와 화면 snapshot 사이에 변경이 있으면 state_changed를 표시하고 checkpoint의 상태/목표 버전을 별도로 반환한다.

## 실행해 보기

빌드 뒤 다음 명령은 합성 자료와 로컬 채널만 사용한다. 실제 업무 ID는 accept 결과에서 확인한다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
node dist/presentation/cli.js accept --request-id recovery-lesson --json
node dist/presentation/cli.js demo-plan <work-id>
node dist/presentation/cli.js checkpoint <work-id> --json > /tmp/secumon-checkpoint.json
node dist/presentation/cli.js run <work-id> --resume-file /tmp/secumon-checkpoint.json
node dist/presentation/cli.js status <work-id>
```

직접 파일을 넘기지 않아도 run은 저장 상태에서 재개한다. checkpoint는 백업 파일이 아니므로 업무 DB와 원본 artifact를 대신할 수 없다. 모델 키 탐색/연결 시험은 재개하지 않았다.

읽는 순서: [ContextPacket 구성](/Users/seunghanee/Documents/secumon/runtime/src/application/context-packet.ts) → [재개 검증](/Users/seunghanee/Documents/secumon/runtime/src/application/context-recovery.ts) → [전체 실행 흐름](/Users/seunghanee/Documents/secumon/runtime/src/application/workflow-runtime.ts) → [강제 종료 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/workflow-crash.test.ts).

## 검증 중 보완과 남은 조건

- 신규 시험은 재개 12, workflow 8, 강제 종료 9, 화면 정합성 4, CLI 1로 총 34개다. 처음 타입 검사에서 optional 속성 계약 오류를 수정했고, 통합 후 단계 상한을 wait로 바꾸던 회귀를 수정했다. 최종 전체 검증은 164/164 통과다.
- P1 실행 진입은 전체 업무 권한을 가진 소유자 역할에 한정한다. 제한된 actor의 도구/등급 상한을 dispatch까지 고정하는 구현이 없으므로, 명시 제한을 가진 actor는 현재 정책과 같더라도 실행을 거부한다. 제한된 조회 view와 위임/외부 공개 경계는 P2에서 다룬다.
- 내부 재개 view는 과거 참조까지 포함하므로 현재 권한으로 모두 볼 수 없는 이력은 보수적으로 거부한다. 일부 이력만 안전하게 투영하는 기능은 이번 결과로 대체하지 않는다.
- 필수 자료를 조용히 잘라내지 않으며 기본 1MiB 재개 패킷 한도를 넘으면 명시 오류를 반환한다. 고급 compact, 미사용 도구 명세 퇴거, 메모리 계층·GC·검색 최적화는 P2에 남아 있다.
- 원본 유실은 복구 오류 반환이며 work.status=blocked를 저장했다는 뜻이 아니다. 기존 commitWithArtifacts가 과거 원본 전체를 검사하므로 이 경우 일반 상태 변경/취소도 실패할 수 있다. 손상된 저장소의 제어/복구 정책은 후속 보완이 필요하다.
- 자동 상주 worker나 delivery 전체 스캔을 구현하지 않았다. 명시 workId의 재개만 검증했다. 실제 모델/API/SIEM/EDR/Knox/컴퓨터 유즈 호출은 0회다.

P1-06/P1-07은 실제 모델 선행 검증이 남아 in_progress를 유지한다. 총 검증 완료 작업 수는 9개다. 다음 독립 로컬 단위는 P2-01의 두 번째 영속 adapter이며, 같은 코어와 저장 계약을 다른 구현에 적용해 PostgreSQL/SQLite 종속 여부를 확인한다.
