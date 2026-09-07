# P3-02 목표 변경의 제어 revision 원자 검사

## 문제와 구현 계획

Web 편집기는 현재 요청 모드를 유지하고 제출 전에 최신 화면을 조회한다. 그러나 조회 직후 다른 채널이 모드를 바꾸면, 목표 명령은 이전 모드를 다시 저장할 수 있었다. UI 재조회만으로는 이 경합을 닫을 수 없다.

목표 명령에 `expectedGoalRevision`과 `expectedControlRevision`을 함께 요구한다. `ExecutionRuntime.command`의 같은 상태 mutator 안에서 두 값을 검사하고, 저장소 CAS 충돌 후 재시도에서도 다시 읽은 상태를 기준으로 검사한다. CLI와 Web이 이 입력을 실제 런타임까지 전달하도록 연결한다. 기존 명령 영수증과 digest 기반 중복 처리 순서는 유지한다.

## 저장한 변경

- `UserCommandSchema`와 `WebCommandSchema`의 goal 입력에 양의 안전한 정수 `expectedControlRevision`을 필수로 추가했다.
- goal mutator는 `executionControl(state)`를 목표 수정 전에 읽고, revision 불일치 시 `stale_execution_control`로 거절한다. 성공하면 같은 상태 변경에서 목표와 제어 revision을 각각 한 번 증가시킨다.
- CLI `change-goal`에 `--control-revision`을 필수로 요구한다. 누락·잘못된 revision은 profile을 열기 전에 거절한다. CLI가 현재 값을 추정해서 채우지 않는다.
- Web UI는 편집 당시 저장한 `draft.controlRevision`을 실제 goal POST에 넣는다. 진행 방식 유지 표시, 편집 입력 보존, stale 안내와 명시 재조회는 이전 구현을 유지한다.
- root 담당 `local-workbench.ts`의 전달부도 goal 호출에 `expectedControlRevision: input.expectedControlRevision`을 전달하도록 연결했다.
- 기존 goal 시험 호출부는 해당 fixture의 제어 revision을 명시하도록 좁게 변경했다. 저장소 조회 포트의 병렬 변경은 이 단위에서 수정하지 않았다.

## 회귀 설계

새 `runtime/src/tests/goal-control-atomic.test.ts`는 SQLite/file-journal 각각 다음 8개 시험과 Web strict schema 1개, 총 17개 시험을 추가한다.

1. 다른 채널의 모드 변경 뒤 오래된 goal 요청은 목표·제어·사건·전달 상태를 바꾸지 않으며 영수증도 생성하지 않는다.
2. goal commit 직전에 모드 변경을 주입하여 실제 CAS 충돌을 만든다. 재시도는 최신 control을 확인하고 기존 모드를 덮어쓰지 않는다.
3. control을 바꾸지 않는 다른 commit의 CAS 충돌에서는 같은 명령을 정상 재시도하고 control revision을 한 번만 증가시킨다.
4. 성공한 goal 영수증은 이후 모드 변경과 재시작 뒤에도 동일 요청으로 재확인된다. 같은 ID에 다른 control revision을 넣으면 digest 충돌로 거절한다.
5. 누락·문자열·null·0·음수·소수·안전 범위 초과 및 추가 권한 필드를 거절하고 상태를 보존한다. goal revision도 계속 검사한다.
6. executionControl이 없는 이전 상태도 명시적인 초기 revision 1을 요구한다.
7. 실제 CLI 프로세스 경로에서 양 revision, stale 거절, 최신 값 성공 및 동일 영수증 재확인을 검사한다.
8. 로컬 HTTP → Web strict 입력 → Workbench → core 경로에서 누락/잘못된/추가 필드와 stale 모드를 거절하고 최신 요청·재확인을 검사한다.

별도의 schema 시험은 Web 입력의 숫자 타입과 범위를 검사한다. 모두 합성 자료를 사용한다. 작성된 HTTP 시험은 loopback 서버만 사용하며 외부 API·모델·MCP 호출을 포함하지 않는다.

## 검증 상태와 호환성

이 하위 작업은 emitting build와 시험 실행을 하지 않았다. 마지막 `tsc --noEmit`은 병렬 작업 중인 저장소 조회 wrapper의 새 메서드 누락만 보고했다. Web 전달부 누락은 연결 후 사라졌고 새 원자성 시험 파일 자체의 타입 오류는 그 출력에 없었다. 전체 타입 검사와 실제 17개 시험 통과 여부는 통합 뒤 root의 최종 검증 기록을 따라야 한다.

root의 첫 통합 targeted 실행은 97개 중 93개 통과, 4개 실패였다. 이 단위의 2개 실패는 두 저장소 CLI 음수 입력 구간에서 `invalid_control_revision` 대신 parser 단계의 일반 오류 `cli_request_failed`를 관측한 것이다. revision 값 검증을 시험하려는 목적에 맞춰 잘못된 값들을 `--control-revision=-1`처럼 `=`으로 결합해 전달하도록 시험 문법을 수정했다. `--control-revision -1`의 옵션 해석 오류를 제품의 revision 검증 실패로 잘못 기대하지 않는다. 제품 코드는 바꾸지 않았으며 수정 후 실행은 root의 후속 기록으로 확인한다. 나머지 2개 diagnostics fixture 기준값 수정은 별도 root 작업이다.

goal 요청의 입력 계약은 의도적으로 엄격해졌다. 필드 없는 이전 클라이언트 요청은 거절하며, 저장된 과거 요청에 현재 revision을 자동 보충하지 않는다. 새 계약으로 저장한 동일 요청은 목표·제어 revision 증가 후에도 기존 영수증으로 재확인된다. 과거 필드 없는 영수증에 필드를 덧붙이면 digest가 달라 충돌한다. 이는 원래 없던 사용자의 동시성 조건을 추정해 넣지 않기 위한 경계다.

이 변경은 목표·제어 명령의 원자성 계약을 다룬다. 실제 모델 품질, 분산 배포, 외부 메신저 전달이나 사람의 읽음 확인을 검증한 결과가 아니다.

## 최종 통합 결과 연결

이 문서의 작성·소스 검토·중간 검사 시점 이후 루트의 최종 통합 검증은 1,536/1,536 통과, 실패 0이었다. 신규 53개(저장 조회28·원자 제어17·공개 조회8), 코어 타입 검사·계층 검사·합성 fixture도 통과했다. 최신 SQLite schema는 v3이며 v1/v2의 이행을 검증했다. 이 문서의 중간 상태를 최신 결과로 해석하지 않고 [학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-result.md)와 [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-local-verification.json)을 따른다.
