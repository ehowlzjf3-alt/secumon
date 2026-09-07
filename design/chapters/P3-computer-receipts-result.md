# P3-04 입력 영수증과 읽기 대조: 학습·결과

2026-09-06 · v0.34 · [계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-reconciliation-plan.md)의 첫 종속 단위

## 이번에 배운 개념

Save를 누른 직후 프로세스가 끝났다고 하자. 화면에 원하는 내용이 있다는 사실만으로 이번 Save가 실행됐다고 단정할 수 없다. 이전에 저장한 내용일 수도 있다. 반대로 입력 영수증을 못 찾았다는 이유로 실행되지 않았다고 단정할 수도 없다. 기록이 없거나 조회할 수 없을 수 있기 때문이다.

따라서 세 질문을 분리했다. **특정 입력이 적용됐는가**, **현재 업무 조건을 만족하는가**, **남은 입력을 실행해도 되는가**다. 이번 구현은 첫 질문에 필요한 증명을 만든다. 나머지는 런타임 대조 정산과 continuation에서 다룬다.

## 구현한 흐름

원 work/attempt/session/epoch/surface/operationId, 화면·초점 revision, 대상 ref와 typed action을 하나의 identity로 고정한다. 합성 앱의 변경과 `applied` 영수증을 같은 파일에 쓰고 fsync→rename→directory fsync가 끝난 뒤 응답한다. 입력 전 거절이 확정되면 `not_applied` 영수증을 쓴다. 입력 응답이 unknown이어도 영수증은 이미 저장돼 있을 수 있다.

새 `ComputerDriver.lookup`은 선택 포트다. 현재 lease와 현재 읽기 권한을 await 전후 검사하며, 같은 work의 새 attempt/epoch가 원 입력 identity를 조회할 수 있다. 원장이 없거나 identity가 다르면 unknown이고, 조회는 입력·원장·화면을 바꾸지 않는다. 일반 모델 도구나 미확정 효과 차단을 해제하는 경로로 등록하지 않았다.

| 상황 | 조회 결과 | 다음 판단에 필요한 것 |
|---|---|---|
| 적용과 함께 저장된 원 영수증이 일치 | found / applied | 현재 사후 조건과 남은 단계 판단 |
| 입력 전 거절이 명시적으로 기록됨 | found / not_applied | 현재 권한과 새 실행 계획 |
| 호출 전 종료·과거 v1 파일·기록 부재 | unknown | 별도 대조 근거 |
| 다른 identity·권한 변경·파일 손상 | unknown | 유효한 현재 권한/원본 |
| 저장 후 응답 유실 | 영수증이 있으면 applied 조회 | 중복 입력 없이 결과 정산 |

driver 버전과 앱 파일은 v2다. v1의 앱 내용/계수는 읽되 과거 입력 영수증을 만들어내지 않는다. 한도는 영수증 기본/최대 256개, 대기·완료 operation 슬롯 256개, 진단 기록 최근 256개다. 진단에서 빠진 개수는 별도 계수로 표시한다. 영수증이 가득 차면 새 입력 전에 거절하고 기존 증명은 보존한다. 명시 보관·정리 정책은 후속 운영 범위다.

재시작한 파일의 epoch와 상태를 이전 인스턴스가 덮어쓰거나 새 관찰처럼 반환하지 못하게 검사한다. 지연 Search callback이 저장 실패를 만나도 시계 진행을 중단하지 않고 이전 waiter를 종료한다. rename 뒤 directory fsync가 실패하면 새 입력·관찰을 막고, 파일에 남은 영수증은 읽어 대조할 수 있다.

## 코드와 실습

- [도메인 계약](/Users/seunghanee/Documents/secumon/runtime/src/domain/computer-operation.ts): 입력 identity·영수증·조회 결과.
- [검증 계약](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-operation-contracts.ts): strict schema와 detached identity 생성.
- [합성 driver](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/synthetic-computer-driver.ts): 적용/영수증 저장과 현재 소유권 검사.
- [직접 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/synthetic-computer-receipts.test.ts): 권한·한도·충돌·대기·재시작.
- [저장 실패 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/synthetic-computer-storage.test.ts)과 [SIGKILL 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/computer-operation-recovery.test.ts): 기록과 응답 사이의 실패.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
node --test dist/tests/computer-operation-contracts.test.js dist/tests/synthetic-computer-receipts.test.js dist/tests/synthetic-computer-storage.test.js dist/tests/computer-operation-recovery.test.js
```

위 실습은 합성 파일·시계·child 프로세스를 사용한다. SIGKILL은 생성한 시험 child에만 보낸다. 시험 임시 폴더는 종료 후 정리한다. `receipt-durable` 사례에서는 Save와 영수증 저장 후 응답 전에 종료하고, 재시작 뒤 원 identity의 applied 영수증과 저장 1회를 확인한다. `before-input` 사례는 Save 호출 전 종료하여 영수증 부재를 unknown으로 보존한다.

## 검증 기록과 남은 범위

최종 `npm run verify` exit 0, **1,656/1,656·실패 0**, 153716.278625ms다. 관련 targeted 120/120, 코어 타입 검사·안쪽 계층 92파일/위반 0·합성 4시나리오/22판정도 통과했다. 전체 수치와 source/build 연결은 [검증 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-receipts-local-verification.json)과 [전체 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-receipts-verify.log)를 기준으로 한다. 신규 시험은 계약 5·직접 driver 16·저장 장애 3·실제 프로세스 종료 2개, 총 26개다. 첫 targeted의 오류 코드 호환 실패와 이후 수정 기록은 그대로 보존했다.

P3-04는 부분 검증/진행 중이다. 다음은 현재 목표·주체·정책·예산과 원본 head에 연결된 **명시 런타임 대조 예약·정산**이다. 그다음 단일 successor로 남은 단계만 이어가며, 적용된 단계는 반복하지 않고 현재 사후 조건을 다시 확인한다. 이때 이전 사용량과 시간 상한을 초기화하지 않는다.

앱과 영수증을 같은 파일로 저장하는 보장은 합성 앱에 한정된다. 실제 GUI의 exactly-once나 다중 프로세스 소유권을 보장하지 않는다. 실제 로컬 Web driver와 선택 환경 검증이 남았다. 이번 단위에서 호출 성능은 새로 비교하지 않았으므로 v0.33의 비용 기록은 이전 구현의 관측으로 유지한다. 실제 모델/API·사내 서비스 연결 시험은 실행하지 않았다.
