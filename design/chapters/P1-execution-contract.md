# P1 실행 루프의 세부 계약

P1-03 구현 기준이다. 결정적 코어 구현과 로컬 검증을 완료했으며, 실제 범위와 남은 연결은 [결과·학습 기록](/Users/seunghanee/Documents/secumon/design/chapters/P1-execution-result.md)을 따른다.

- 시도는 reserved → running → received → succeeded/partial/failed/cancelled/unknown으로 구분한다. received는 결과 원본을 저장했지만 근거/목표 판단에 수락하기 전이다.
- 예약 시 budget 예약과 owner/lease·goal/plan revision·입력 digest를 저장한다. dispatch 전에 최신 상태·목표·취소·소유권·기한을 재검사한다.
- 결과 수신과 근거 수락은 별도 커밋이다. attempt.resultArtifact와 resultId로 재시작 후 수신 결과를 읽을 수 있고, 채택 여부는 adopted로 구분한다.
- 결과는 인증된 도구 실행과 attempt에 연결한다. model의 제안을 ToolResult나 사용자 Goal/Policy 변경으로 취급하지 않는다. tenant/scope/labels·근거 ID 충돌·파생 참조·결과 schema를 검사한다.
- 늦은 결과도 시도 이력으로 남기되 현재 목표/작업 계약이 바뀌면 채택하지 않는다. 변경되지 않은 task의 결과는 근거/계약을 확인해 재사용한다. 같은 task ID를 다른 입력/도구/효과 계약으로 재사용하지 않는다.
- running 상태에서 프로세스가 사라지면 읽기와 쓰기를 구분한다. 읽기는 허용된 재시도/예산 안에서 다시 시도할 수 있다. 쓰기는 효과를 대조하기 전 재실행하지 않고 effect_reconciliation 의무로 남긴다.
- 취소는 먼저 상태에 커밋하고 실행 중 signal로 전달한다. 이후 늦게 도착한 결과가 취소를 되돌리거나 새 목표를 완료시키지 않는다.
- Controller는 계속할 유효 작업이 있으면 그대로 배정한다. 계획이 없거나 현재 방식으로 남은 조건을 충족하지 못하면 변경 사유와 함께 제한된 replan을 수행한다. 큐가 비어도 완료 기준·반증·의무를 확인한다.
- 대기 조건이 있으면 wakeKey/dueAt를 저장하고 모델을 계속 호출하지 않는다. budget 소진·기한 초과·불명확 효과·해소할 수 없는 권한 문제는 이유가 있는 blocked로 남긴다.
- P0의 expectedControl을 실제 루프와 연결하되 제어 규칙 시험과 실제 모델의 가설/추론 품질을 구분한다. 실제 모델 API를 요구하는 P1-06은 별도 통과 조건이다.

P1-02까지의 저장 시험은 예약/수신/미채택 상태와 결과 원본의 재조회·중복 방지를 확인한다. 스케줄러·dispatch·수락·재계획·취소 의미의 통합 확인은 P1-03에서 수행해야 한다.

## 이번 구현 단위의 범위

P1-03은 한 work 안에서 한 도구 시도를 배정하는 결정적 코어로 시작한다. DAG 의존성은 검증하되 병렬 처리량 확장은 후속 작업이다. planner를 부를 시점은 `replan` 제어 결과로 반환하고, 실제 모델 호출·토큰 정산은 P1-06에서 연결한다. 계획 제출만으로 모델을 실제 호출했다고 기록하지 않는다.

- 계획 수락: 현재 revision, DAG, 도구/버전/권한, JSON Schema 입력, 완료 기준 참조, 기존 task ID 계약을 검사한다. 다른 계획으로 넘어갈 때만 replan 예산을 차감한다.
- 실행: 예약 → dispatch → 결과 보관 → 근거 수락을 분리하고 각 단계에 CAS를 적용한다. 저장된 결과가 있으면 재호출 없이 수락 단계부터 이어간다.
- 제어: continue/replan/wait/blocked/complete와 사용자 pause/cancel/goal 변경을 저장 상태에서 판정한다. 완료는 근거·미해결 의무·진행 중 효과를 확인한다.
- 경계: 임의 도구 출력은 목표·정책을 바꾸지 않는다. 유효하지 않은 결과 원문은 사용자에게 노출되는 artifact로 보관하지 않고 고정 오류와 효과 불확실성을 남긴다.
- 검증: 두 업무군 정상 실행, 낡은 계획/순환 의존성/입력 오류, 수신 후 재시작, 취소/목표 변경 중 늦은 결과, 예산·기한, 읽기와 쓰기의 lease 만료 차이를 실행한다.

JSON Schema 검증은 주입 포트 뒤의 Ajv adapter로 제공한다. 등록 시 컴파일한 validator를 재사용하고 입력 변환은 하지 않는다. 최초 지원은 JSON Schema draft-07이며 다른 dialect는 명시적으로 거부한다. 참고: [Ajv 컴파일·캐시 지침](https://ajv.js.org/guide/getting-started.html), [검증 옵션](https://ajv.js.org/options.html).
