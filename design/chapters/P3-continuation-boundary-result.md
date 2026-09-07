# P3-04 후속 작업 계약과 근거 소비 경계

2026-09-06 · v0.36 · 로컬 선행 단위 검증 완료 · 전체 P3-04는 부분 검증/진행 중

이 단위는 [단일 후속 작업 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-continuation-plan.md)의 선행 단계다. 현재 원 작업과 후속 작업을 연결하는 저장 계약과 근거 소비 경계를 구현했다. 실제 `.continue/.verify` runner와 v2 checkpoint는 다음 종속 단위이며 아직 등록하거나 실행하지 않는다.

## 이번에 공부할 개념

컴퓨터 입력의 영수증을 확인해도 남은 단계를 자동으로 실행할 권한이 생기지는 않는다. 부모당 하나의 후속 시도를 예약하고, 어떤 원 checkpoint와 증명을 바탕으로 예약했는지 고정해야 한다. 두 요청이 동시에 같은 부모를 이어가려 해도 하나의 claim과 하나의 도구 예산 예약만 저장해야 한다.

원본의 증명은 이후에 만든 결과와 기억의 수명에도 영향을 준다. 예를 들어 업무 W의 입력 증명으로 만든 기억 M이 있을 때, 증명이 유실됐는데 M만 계속 읽을 수 있으면 정보가 복사를 통해 검증 경계를 벗어난다. 원 증명이 실패 상태로 바뀌어도 이 의존성은 남는다. 같은 원본을 새로 대조한 유효한 정산으로 복구할 수 있으며, 과거 실패 기록은 고치지 않는다.

기억 검사와 효과 검사를 서로 호출하면 W에서 만든 M을 W가 다시 읽는 과정이 끝나지 않을 수 있다. 효과 원본 검사는 receipt와 artifact만 인증한다. 기억의 계보와 현재 읽기 권한은 별도 검증한다. 이것은 원본 인증, 기억의 유효성, 실행 권한이 서로 다른 책임이라는 예다.

반대로 W가 다른 기억 K를 참고해 만든 M이라면 K가 철회될 때 M도 계속 사용할 수 없어야 한다. W의 상태 갱신이 아직 실행되지 않았다는 이유로 오래된 입력을 유효하게 취급하면 안 된다. 한 번의 검증에서 관련 기억과 업무를 제한된 크기로 모으고, 방문 집합으로 중복 순환을 끊으며, 전체 버전의 안정성을 확인하는 방식으로 다룬다.

## 구현한 경계

- `computerResume`에는 부모 attempt/head와 선택적 정산 id/proof id만 들어간다. 실제 action과 다음 offset을 호출자가 정하지 않는다. 기존 작업에 필드가 없으면 예전 task digest와 저장 모양을 유지한다.
- immutable claim은 새 reserved Attempt 및 도구 예산 증가와 같은 CAS에 들어간다. 같은 부모의 형제 추가·claim 제거·부모 head/result 교체를 거절하고, 자식이 취소돼도 예약 이력은 남는다.
- context에는 명시한 metadata와 허용된 원본 참조를 보존한다. v1 checkpoint/result에서 필요한 observation 참조를 제한된 크기로 읽으며 원 action을 과거 결과에서 자동으로 다시 넣지 않는다. 사용자가 명시한 현재 계획의 입력까지 삭제하는 기능은 아니다.
- 리소스·공개·기억·전송에서 원 효과 증명을 다시 검사한다. 본문을 읽는 중 증명이 철회되면 이미 읽은 내용을 반환하거나 전달 완료로 저장하지 않는다. 현재 주체의 좁은 읽기/전송 권한과 원본을 인증하는 정본 정책은 각각 검사한다.
- 과거 `settled`가 `failed`로 바뀌어도 proof 참조가 남으면 검사 대상이다. 동일 source/head/result/operation/계약/목표/정책/세대/결론을 현재 정산이 다시 증명해야 소비를 허용한다. 반복 조회가 실패 이력을 계속 고쳐 쓰지는 않는다.
- 실행 지원 전에는 `computerResume`가 있는 계획 제출·예약·dispatch·broker 호출을 거절한다. 도구 metadata의 형태가 맞다는 사실을 실제 이어가기 지원으로 취급하지 않는다.

## 검증 범위

최종 Node 24.20.0 `npm run verify` exit 0, 1,853/1,853·실패 0, 207453.42025ms다. 신규 82개와 최종 관련 197/197, 코어 타입 검사·안쪽 계층 97파일/위반 0·합성 4시나리오/22판정을 통과했다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-boundary-local-verification.json). 중간 실패 로그는 그대로 보존한다. SQLite와 파일 저널을 사용하며 계약 CAS에는 메모리 구현도 포함한다.

| 신규 시험 | 개수 |
|---|---:|
| claim·CAS·도구 계약 | 14 |
| compact·원본·복원·늦은 부모 결과 | 20 |
| 지원 전 계획·예약·dispatch·broker 거절 | 8 |
| 자료·공개·기억 소비 및 재대조 복구 | 12 |
| 과거 실패 proof의 전송·마지막 저장 | 8 |
| 외부 기억 변경·자기 참조·권한·수집 한도 | 20 |

최종 관련 시험 로그는 [targeted](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-boundary-targeted-final.log), 전체 로그는 [verify](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-boundary-verify.log)다. 실제 모델·사내 서비스·Knox·GUI 호출은 실행하지 않았다.

주요 확인 사례는 한 부모의 동시 예약, 취소 후 claim 보존, 원본 변경 거절, 다섯 번 compact와 저장소 reopen, 원본 유실/변조, 잘못된 늦은 부모 응답, proof checker 부재, 원본 I/O 중 철회, 과거 실패 후 소비 차단, 명시 재대조 후 복구다. 실제 successor를 실행하다 SIGKILL하는 시험은 아직 없는 runner의 다음 검증 항목이다.

## 코드 읽기와 실습

1. [claim 전이](/Users/seunghanee/Documents/secumon/runtime/src/domain/computer-continuation.ts)에서 같은 부모에 두 자식이 연결되는 것을 막는 조건을 읽는다. [계약 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/computer-continuation-contracts.test.ts)의 동시 CAS 결과와 비교한다.
2. [원 효과 인증](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-reconciliation.ts)의 `proofsCurrent`와 `current`를 비교한다. 영수증 원본 인증과 기억 검사 중 어떤 부분을 분리했는지 확인한다.
3. [소비자 회귀](/Users/seunghanee/Documents/secumon/runtime/src/tests/effect-source-consumers.test.ts)에서 유효한 읽기, 실패 처리 후 거절, 저장소 재시작 후 거절, 같은 원본의 새 정산 후 복구를 따라간다. UI 입력 횟수는 늘어나지 않아야 한다.
4. [context 회귀](/Users/seunghanee/Documents/secumon/runtime/src/tests/computer-continuation-context.test.ts)의 보호된 index와 원본 참조를 본다. 조회용 metadata를 만들 수 있어도 실행용 resume은 거절될 수 있다.
5. [기억 원출처 회귀](/Users/seunghanee/Documents/secumon/runtime/src/tests/knowledge-effect-custody.test.ts)에서 외부 K를 고친 뒤 W의 상태는 그대로 두고 M을 읽어 본다. M의 조회와 캐시가 오래된 내용을 거절하는 이유를 [원장 수집 코드](/Users/seunghanee/Documents/secumon/runtime/src/application/knowledge-service.ts)의 방문 집합·버전 비교와 연결한다.

## 다음 구현 단위와 한계

다음은 v2 checkpoint의 원 action deadline·누적 관찰/입력 시도·후속 깊이를 영속화하고, 실제 단일 successor 예약과 runner를 연결하는 작업이다. 이미 적용된 단계는 반복하지 않고 마지막 적용 단계의 현재 조건을 확인한다. 남은 입력이 없는 경우는 읽기 verify로 검증한다. 구 v1의 누락된 카운터를 0으로 추정하지 않는다.

현재 claim과 tool marker는 저장/검증 계약이며 실제 실행 기능이 아니다. 원본과 저장소 receipt는 신뢰하는 host의 증거로, 실제 GUI의 exactly-once나 전원 손실 보장을 증명하지 않는다. 이번 단위의 성능·모델 추론 품질·청구 비용은 새로 측정하지 않았다. 중단한 모델/API 실험은 재개하지 않는다.

현재 독자의 기억 읽기 권한과 직접 의존성의 actorDigest 검사는 유지한다. 내부 custody 검사는 다른 기억의 본문을 공개하지 않고 tenant/owner/scope/labels와 author 또는 검토된 공유 상태, 원본/버전의 정합성을 확인하는 범위다. 기존 포트로는 다른 원작성자의 최신 namespace/reviewer 권한을 조회할 수 없다. 과거 digest에서 권한을 역산하거나 이 정합 검사를 원작성자의 현재 권한 재인증으로 표시하지 않는다.

custody 수집의 256개 항목·4MiB 상한은 원출처 업무 하나의 closure당 적용된다. 여러 원출처를 묶은 조회 전체의 공유 예산이나 캐시를 구현한 것은 아니다. 원출처 의존성이 없는 기억 조회의 기존 I/O 경로는 회귀로 확인한다. 일반 기억 원본의 물리 blob 검증도 새로 추가하지 않았으며 기존 원장 metadata 범위를 유지한다. 컴퓨터 효과 증명의 artifact/receipt 읽기 검증과 구분한다.
