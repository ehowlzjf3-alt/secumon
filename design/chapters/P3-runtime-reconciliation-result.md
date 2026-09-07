# P3-04 명시 런타임 대조: 학습·결과

2026-09-06 · v0.35 · [단위 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-runtime-reconciliation-plan.md)

## 이번에 배운 개념

Save를 눌렀지만 응답을 받지 못했다. 같은 입력을 다시 보내기 전에, 원 operation의 영수증을 별도 읽기로 확인한다. 영수증이 applied면 그 입력이 적용됐다는 사실을 알 수 있다. 현재 화면의 값이나 전체 업무 완료를 알려주는 것은 아니다. 그래서 원 입력 시도는 unknown 이력으로 보존하고 효과 대조 의무만 별도 증명으로 닫는다. 이후 관찰과 완료 근거 수집이 필요하다.

앞 단계가 적용되고 마지막 단계가 not_applied여도 묶음 전체 효과는 confirmed다. 영수증 부재는 unknown이며, 입력이 없었다는 증거로 해석하지 않는다. 이 구분을 압축 요약·재시작·화면과 전달 단계까지 유지하는 것이 이번 단위의 핵심이다.

## 구현과 재사용

- 기존 ComputerUse의 checkpoint/observation 검증, driver lookup, ArtifactStore, 세 저장소의 CAS/command receipt, 예산·권한·knowledge 검사를 재사용했다. 코어는 TypeScript이고 PostgreSQL이나 Python에 의존하지 않는다.
- optional computerReconciliations 색인은 최대 1,000개다. 원 request/response/proof 본문은 artifact로 분리하고 source attempt/head/result를 고정한다. 새 기록 없이 과거 schemaVersion 1 상태도 읽는다. 새 필드를 모르는 구 reader와의 양방향 호환을 주장하지 않는다.
- reserve→running→received→settled/failed를 독립 저장한다. 현재 read authority와 남은 work/부모 grant 안에서 도구 호출 한 건을 예약하고 dispatch에서 소비한다. 이미 사용한 원 입력 예산과 deadline은 바꾸지 않는다.
- 원 입력 deadline과 조회 lease를 구별한다. 조회가 제때 응답을 저장했다면 조회 lease가 끝난 후 재시작해도 현재 업무 권한 안에서 저장 응답을 정산할 수 있다. dispatch 후 응답이 없으면 같은 명령을 자동 재조회하지 않는다.
- 동일 명령의 동시 호출은 합류하며 저장소의 command receipt로 중복을 판별한다. 다른 업무가 같은 명령 ID를 써도 취소 key는 충돌하지 않는다. 새 owner는 기존 미사용 예약을 실행할 수 없고 만료 후 별도 명령을 사용한다.
- 저장된 request/response/proof와 reserve/dispatch/receive/settle 영수증을 함께 검증한다. 이전 실행이 늦게 돌아와도 원 head/result를 덮어쓰지 못한다. 응답 commit 후 ACK 유실은 저장된 received 상태를 보존한다.
- 증명 유실·변조·정책/자료세대 변경·등록 계약 변경은 현재 실행·모델·완료·compact/restore·대화·Outbox·WorkView에서 검사한다. 화면은 동일 revision/cursor도 재검사하며 원문 action/receipt를 자동 표시하지 않는다.

## 작은 API 실습

아래는 이미 구성한 로컬 runtime과 미확정 source를 쓰는 호스트 API 예다. 일반 도구의 unknown 차단을 우회하는 model tool은 아니다.

```ts
const input = { attemptId: source.id, checkpointId: source.computerUse.head.id };
const record = await core.computerReconciliations.reconcile(
  workId, "explicit-lookup-1", actor, input,
);
// record.status === "settled"는 원 effect 의무의 정산이다.
// 원 Attempt의 채택, Evidence 생성, goal 완료는 별도다.
```

수명 단계별로 실험하려면 reserve, execute, settle를 순서대로 호출한다. inspect는 명시 기록을 읽고, current는 저장된 증명을 검증하며, refresh는 무효화·만료를 반영한다. 실제 UI 연결과 CLI/Web 명령 노출은 이 단위에서 추가하지 않았다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
node --test dist/tests/computer-reconciliation*.test.js dist/tests/effect-proofs.test.js
```

[런타임 실습 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/computer-reconciliation.test.ts)에서 원 결과/head, inputCount/saveCount, effect 의무와 Evidence를 비교한다. [강제 종료 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/computer-reconciliation-recovery.test.ts)은 별도 child를 실제 SIGKILL한 뒤 두 저장소에서 재개한다. [늦은 입력 결과·권한 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/computer-reconciliation-edges.test.ts)은 원 결과가 아직 null인 경우도 고정한다.

## 검증

최종 Node 24.20.0 `npm run verify` exit 0, **1,771/1,771·실패 0**, 191351.012708ms다. 관련 시험 115/115, 코어 타입 검사·안쪽 계층 96파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 계약 11, 런타임 16, compact/restore 16, 공통 효과 경계 16, 실제 SIGKILL 8, ACK/제어 6, 화면 6, 전달 18, 출처 10, 늦은 실행·권한 8개다.

첫 관련 59/59와 두 번째 97/97 이후, 세 번째는 113/115였다. 두 실패는 부모 예산 회수 시 기존 budget_child_draining 오류를 budget_grant_inactive로 기대한 차이였고 실제 거절·환불은 유지됐다. 기대를 기존 계약에 맞춘 뒤 최종 115/115와 전체 시험을 수행했다. 모든 중간 로그는 보존한다. 독립 마지막 읽기 감사에서는 새 확정 correctness blocker를 찾지 못했다.

[최종 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-runtime-reconciliation-local-verification.json) · [전체 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-runtime-reconciliation-verify.log) · [관련 시험 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-runtime-reconciliation-targeted-4.log)

## 한계와 다음 단위

이번 검증은 합성 driver와 로컬 저장소에 한정한다. 실제 모델/API·사내 MCP·Knox·운영 GUI를 실행하지 않았다. 성능·비용을 새로 측정하지 않아 과거 수치를 현재 버전의 성능으로 인용하지 않는다. 호스트의 driver/저장소 영수증을 신뢰하며 실제 GUI의 exactly-once, 여러 프로세스 간 UI 소유권, 전원 차단의 원자성까지 보장하지 않는다.

원 source artifact가 이미 일반 commit의 필수 참조에 들어 있는데 물리 유실되면, 의무 재개를 저장하는 commit도 거절될 수 있다. 이 경우 오류로 차단하며 정산·완료했다고 처리하지 않는다. 자료의 복원/보관·1,000개 색인 정리 정책과 운영 대조 권한은 후속이다.

P3-04 전체는 partially_verified/in_progress이며 전체 완료 작업은 9개다. 다음은 정확한 원 head/proof를 소비하는 단일 successor, 이미 적용된 단계의 반복 금지, 새 관찰과 현재 사후 조건 확인이다. 이어 실제 로컬 합성 Web driver를 연결한다. 전체 P0–P6 목표는 계속 활성이다.
