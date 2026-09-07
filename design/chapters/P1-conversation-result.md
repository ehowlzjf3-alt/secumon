# P1-05 — CLI와 대화/전달: 학습·구현 결과

2026-09-05 · 로컬 합성 경로 검증 완료

[계획](/Users/seunghanee/Documents/secumon/design/chapters/P1-conversation-plan.md)의 접수·대화 연결·상태/목표 변경·취소·답변 전달을 구현했다. 이번 단위는 사람과 장기 업무 사이의 대화 경계다. 실제 모델의 자연어 이해와 Knox 연결은 후속 작업이다.

## 이번에 구분한 네 가지

| 상태 | 무엇을 확인했는가 | 아직 보장하지 않는 것 |
|---|---|---|
| 접수 | 목표·업무 ID·접수 응답 의도를 같은 저장 트랜잭션에 기록 | 계획의 적합성, 업무 완료 |
| 분석 준비 | 현재 목표의 근거·조건과 추가 확인 의무를 판정 | 사람이 읽을 답변의 준비/전달 |
| 결과 준비 | 근거 ID·digest·목표 revision에 연결된 답변 원본과 전달 의도 저장 | 실제 채널 전달 |
| 전달 확인 | 이 로컬 채널의 수신 저장소에 동일 메시지가 있음을 확인 | 실제 메신저 수락, 사람의 읽음 |

전달이 완료 기준인 업무에는 별도 delivery 의무가 있다. 도구 실행과 근거 수집은 먼저 끝낼 수 있고, 답변 전달이 확인돼야 업무를 완료한다. `--analysis-only`로 접수하면 분석 완료와 미전달 상태를 함께 표시한다. 이것은 후속 P2의 빠르게/깊게 모드 선택과 다른 옵션이다.

## 화면과 명령

기본 사람용 출력은 접수 안내, 필요 질문, 근거가 있는 결과다. 합성 예제 실행에서 접수 안내를 먼저 출력하고 이후 TTY는 같은 상태 줄을 갱신한다. 비TTY에서는 중간 상태나 ANSI를 출력하지 않는다. `--json`은 stdout에 결과 JSON 하나를 내보내며 오류는 stderr와 종료 코드 1로 구분한다. 내부 사건은 명시적 `events` 조회에 종류/번호만 표시한다.

`conversationId`는 대화의 주소이고 `workId`는 지속되는 업무의 주소다. 한 대화에 여러 업무를 접수하거나 다른 대화에서 기존 업무를 `attach`할 수 있다. 연결 추가가 기존 답변의 수신 대화를 자동 변경하지는 않는다. `disconnect`는 상태를 바꾸지 않고 `pause`, `resume`, `cancel`, `change-goal`은 명시적 업무 명령이다. 목표 변경에는 현재 목표 revision을 지정한다. 질문 해결로 전달/효과 대조 의무를 임의 해제할 수 없다.

현재 CLI에는 상주 worker가 없다. 프로세스가 종료되면 저장된 업무 ID로 `run`을 다시 실행한다. SIGINT는 업무 취소 명령을 만들지 않는다. 자연어 계획 대신 명시적인 plan JSON 또는 합성 예제 계획을 사용한다.

## 직접 실행

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
node dist/presentation/cli.js demo --scenario documents-simple --request-id lesson-docs
node dist/presentation/cli.js demo --scenario observations-simple --request-id lesson-observations
node dist/presentation/cli.js list --json
node dist/presentation/cli.js messages
```

기본 데이터 폴더는 `runtime/.data/cli`다. 격리 실습은 `--data-dir`로 지정한다. 같은 요청 ID와 같은 입력의 재접수는 동일 업무를 반환한다. 요청 ID만 같고 입력이 바뀌면 충돌을 알린다. `demo-plan`은 fixture의 명시 계획이며 모델이 추론한 계획으로 해석하지 않는다.

## 실패에서 배운 점

전달 요청을 보내기 전에 outbox의 sending 상태와 owner·lease·시도 번호를 커밋한다. 두 dispatcher가 같은 메시지를 동시에 선택해도 커밋에 성공한 하나만 실제 발송한다. 응답을 잃으면 unknown으로 기록하고, 지원되는 sink의 영수증 조회를 먼저 사용한다. 미확인 상태의 재전송은 멱등 지원과 부재 확인이 있을 때만 이후 flush에서 허용한다. 재시도 상한이 지나면 failed 상태를 남긴다. 발송/조회 timeout도 무한 대기하지 않는다.

수신 저장 성공 직후 SIGKILL을 주입한 시험에서 업무 DB는 sending, 채널 DB는 수신 완료 상태로 남았다. 두 DB를 다시 열고 lease가 지난 뒤 영수증으로 delivered를 복원했다. 추가 발송은 0회였다. 전달 실패/재조회 동안 원천 도구는 다시 실행하지 않았다.

취소·목표 변경·권한 철회 전에 아직 보내지 않은 결과는 전달하지 않는다. 발송 도중 목표가 바뀌었어도 실제 확인된 이전 메시지는 이력으로 남기며 새 목표의 전달 의무를 충족시키지 않는다. 이전 메시지의 효과가 불명확하면 unknown을 보존한다. 취소가 이미 전달된 내용을 회수하거나 외부 동작을 강제 중지한다는 의미는 아니다.

긴 결과/질문은 화면에서 줄였다는 사실과 전체 산출물 참조를 표시하고, 전체 본문은 artifact에 남긴다. 준비한 결과에는 근거 ID·출처·관측 시각이 포함된다. 권한이 복원됐을 때 한 번도 발송하지 않은 응답은 다시 준비할 수 있지만, 이미 발송을 시도한 불명확한 응답은 이를 근거로 재생성하지 않는다.

## 검증과 읽는 순서

- `npm run verify`: **87개 시험 통과**, 안쪽 계층 26개 파일/위반 0, 두 업무군의 4시나리오·22개 완료/제어 판정 통과.
- 새 대화 검사 17개와 CLI 별도 프로세스 검사 4개가 포함된다. CLI 접수/상태/연결/정지·재개/취소/목표 변경, JSON/오류/조용한 출력, 중복 전달·동시성·강제 종료 복구를 확인했다.
- 실제 PTY에서 합성 문서 업무를 실행해 접수→같은 줄 상태 갱신→근거 결과의 순서와 종료 코드 0을 확인했다. 접근성 전체 적합성이나 사용자 가독성 연구를 대체하지 않는다.

코드 읽기: [대화 계약](/Users/seunghanee/Documents/secumon/runtime/src/domain/conversation.ts) → [접수/결과 준비](/Users/seunghanee/Documents/secumon/runtime/src/application/conversation-service.ts) → [전달 제어](/Users/seunghanee/Documents/secumon/runtime/src/application/outbox.ts) → [로컬 채널](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-channel.ts) → [CLI](/Users/seunghanee/Documents/secumon/runtime/src/presentation/cli.ts). [대화 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/conversation.test.ts)과 [프로세스 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/cli.test.ts)을 함께 읽는다.

[검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P1-conversation-verification.json)은 시험 범위와 당시 소스 hash를 저장한다. 과거 P0/P1-04 기록은 그 당시의 증거로 보존한다.

## 다음 단위와 한계

P1-05만 추가 완료한다. 현재 전체 31개 작업 중 9개가 검증 완료이며 P1 전체는 진행 중이다. 다음은 P1-06의 모델 호출 계약·사용량·가설/반증에 따른 계획 변경이다. 중단한 API 키 탐색과 실제 모델 시험은 재개하지 않는다. 독립적인 코드/대역 검증을 진행하되 실제 모델 품질의 미검증 상태를 유지한다.

이 CLI는 synthetic/learner 로컬 프로필이다. 실제 인증·사내 권한·Knox 수신/발송·읽음 확인·운영 보존/삭제·전용 worker는 아직 연결하지 않았다. 오래된 unknown 전달의 운영자 대조, 실패한 전달의 운영 복구, 원본 유실 복원은 실제 채널/복구 작업에서 이어 검증한다. 전송 결과를 모든 시스템에서 exactly-once로 보장한다고 주장하지 않는다.
