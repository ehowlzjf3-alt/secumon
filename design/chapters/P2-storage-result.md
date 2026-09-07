# P2-01 — 저장소를 바꾸어도 같은 업무를 이어가는가

2026-09-05 · 로컬 영속 적합성 검증 완료 · 실제 모델 선행 조건은 미충족

[계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-storage-plan.md)에 따라 SQLite와 파일 저널에 같은 저장 계약과 업무 흐름을 적용했다. Node 24.20.0에서 전체 **232개 시험**, 코어 별도 타입 검사, 안쪽 계층 34파일·의존 위반 0, 합성 4시나리오·22개 판정이 통과했다. [실행·소스 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-storage-local-verification.json)

## 이번에 배운 구분

저장소 독립성은 인터페이스의 메서드 이름을 맞추는 것만으로 성립하지 않는다. 예를 들어 업무 상태는 완료인데 답변 발송 의도가 저장되지 않거나, 재시도한 명령이 다시 적용된다면 저장 구현 교체가 업무 의미를 바꾼 것이다. 두 adapter가 상태·사건·outbox·명령 영수증을 같은 경계에서 저장하고 충돌·중복·재개에도 같은 결과를 반환하는지 확인했다.

코어의 domain/application **34개 파일은 P1-07 기록과 hash가 모두 같다.** 새 저장 구현과 선택은 바깥 계층에만 추가했다. `typecheck:core`는 이 두 계층을 Node 전역 타입과 바깥 adapter 없이 검사한다. Zod 등 기존의 순수 JavaScript 검증 의존성은 유지하며, 이를 모든 런타임/DB 환경의 이식성 보장으로 확대하지 않는다.

## 파일 저널의 커밋 경계

[FileJournalStateRepository](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-journal-state.ts)는 한 work의 revision마다 전체 CommitRequest를 불변 record로 저장한다. 후보 파일을 동기화하고, 해당 revision 이름을 배타적으로 공개해 승자를 결정한다. 공개 전에 실패하면 현재 업무에 포함하지 않는다. 공개 후 응답이나 동기화가 실패하면 완료 여부 불명으로 보고하고 같은 명령 영수증으로 확인한다.

조회도 공개된 기록과 경로를 검사하고 필요한 디렉터리 동기화를 마친 뒤 반환한다. 다른 프로세스가 기록을 먼저 읽어 다음 행동을 시작하는 경우까지 고려하기 위해서다. 같은 명령의 중복 응답은 최신 상태가 아니라 최초 커밋 당시 상태를 반환한다. command ID는 같지만 내용 digest가 다르면 중복 성공으로 처리하지 않는다.

이 구현은 로컬 POSIX 파일 시스템의 제한된 적합성 profile이다. 기본 저장소는 SQLite다. 파일 저널은 조회 때 이력을 다시 읽고 상태를 복사하므로 큰 이력·처리량에 유리하다고 주장하지 않는다. 색인·이력 정리·백업·버전 이행은 후속 단계다. hash chain은 중간 누락이나 내용 변경을 확인하지만 마지막 record 또는 전체 work directory 삭제를 외부 기준 없이 판별하지 못한다. 같은 UID의 악의적 rollback을 막는 인증 경계도 아니다.

## 실제로 실행한 시험

| 시험 범위 | 개수 | 확인한 내용 |
|---|---:|---|
| 공통 영속 저장 계약 | 22 | 두 구현의 원자적 내용, 영수증, 복제, 범위 분리, event cursor, runnable 상태, 다중 프로세스 경합·재개 |
| 파일 저널 장애·무결성 | 20 | 공개 전후 실패/SIGKILL, 쓰기 응답 전 조회, 동기화 실패, 동시 append, chain/형식/경로 오류 |
| 두 저장소 × 단순/복잡 두 업무군 | 8 | 저장된 모델 대역 응답 수락, 근거·가설·계획 변경, 답변 전달, 재재개 시 추가 효과 없음 |
| 두 저장소의 업무 강제 종료 | 18 | 문서/관측 각 네 구간 및 저장되지 않은 합성 쓰기 효과의 unknown 유지 |
| CLI profile 선택·실패 정리 | 9 | 프로세스 간 선택 유지, 기존 SQLite 채택, 잘못된 전환/metadata 거부, 초기화 실패 시 저장소 닫기 |

위 시험 중 기존 업무 강제 종료 9개를 유지하고 다른 저장소의 9개를 더했다. 전체 suite의 증가분은 **68개**, 이전 164개를 포함한 최종 합계는 232개다. 시험 수를 실제 업무 성공률이나 추론 품질로 해석하지 않는다.

강제 종료 후 원천 호출은 실행 전 1회, 읽기 응답 저장 전 2회, 저장 후 수락 전 1회, 수신 채널 저장 후 1회였다. 두 저장소 모두 결과 발송은 각 1회였다. 합성 쓰기 효과가 발생했으나 응답이 저장되지 않은 사례는 재재개해도 호출 1회·결과 발송 0회·effect=unknown을 유지했다. 프로세스를 실제 SIGKILL했으며 전원 차단은 시험하지 않았다.

모델 대역 전체 흐름은 저장소를 닫고 새 인스턴스로 다시 열어 수신 응답을 수락했다. 단순 업무는 모델 대역 1회/도구 1회, 복잡 문서는 4회/3회와 replan 1회, 복잡 관측은 3회/2회였다. 문서의 늦은 반증은 가설을 refuted로, 관측의 허가 근거는 supported로 갱신했다. 각 업무의 접수와 결과는 각각 1회였다. 제안은 합성 입력에 따른 결정적인 코드이므로 실제 모델의 가설 생성 능력을 검증한 것이 아니다.

독립 검토와 재현으로 조회 중 동시 append를 손상으로 오인하던 경합, revision 0 파일의 조용한 무시, 채널 초기화 실패 시 열린 저장소를 닫지 않던 문제를 수정했다. 해당 회귀 시험을 포함해 최종 전체 검증을 다시 실행했다.

## CLI에서 선택해 보기

빌드 뒤 별도 데이터 폴더에서 실행한다. 실제 모델이나 외부 채널은 호출하지 않는다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
node dist/presentation/cli.js demo --scenario documents-simple --state-backend file-journal --data-dir .data/journal-lesson
node dist/presentation/cli.js messages --data-dir .data/journal-lesson
```

`profile.json`이 선택을 기억하므로 이후 같은 폴더에서는 옵션을 생략할 수 있다. 같은 폴더에 `--state-backend sqlite`를 지정하면 전환을 거부한다. 이는 저장소 간 자료 이행 기능이 아니다. 교체되는 것은 **업무 StateRepository**이며, 로컬 채널과 시험용 효과 원장은 여전히 SQLite를 사용한다.

읽는 순서는 [공통 계약 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/state-conformance.test.ts) → [업무 흐름 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/persistent-workflow.test.ts) → [강제 종료 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/workflow-crash.test.ts) → [저널 장애 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/journal-fault.test.ts)이다. 정상 완료보다 중복 요청과 응답 유실에서 어떤 상태를 반환하는지 먼저 살펴보면 저장 계약의 이유를 이해하기 쉽다.

## 남은 조건과 다음 학습

실제 모델/provider, SIEM/EDR/Knox, 컴퓨터 유즈 호출은 이번 작업에서 0회다. NFS/Windows/다중 호스트, 전원 상실, 처리량·장기 저장 비용, 백업 복원은 미시험이다. 이전 단계의 제한된 actor 실행, 누락된 정본 artifact에 대한 제어/복구 한계도 그대로 남는다.

P2-01의 로컬 적합성은 검증했지만 P1-06/07의 실제 모델 조건이 남아 전체 작업 상태는 in_progress로 유지한다. 총 검증 완료 작업은 9개다. 다음 독립 로컬 작업은 **P2-02 기억·근거 수명과 조회**다. 현재 업무 상태, 직접 읽는 근거, 검색 색인, 개인/공유 기억을 구분하고 정정·삭제·권한 철회가 파생 자료에 반영되는 과정을 구현한다.
