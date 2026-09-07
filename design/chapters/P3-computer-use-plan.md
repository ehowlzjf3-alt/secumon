# P3-04 첫 단위: 합성 관찰·행동·확인

2026-09-06 · 개념 → 작은 계획 → 구현 → 정상/실패/복구 검증 → 학습 기록

## 목표와 기존 코드의 연결

클릭 입력이 전달된 사실과 원하는 업무 결과가 확인된 사실을 구분한다. 관찰 원본을 저장하고, 해당 관찰의 대상이 지금도 유효할 때 최대 3개의 typed action을 실행한다. 각 단계의 실행 의도와 적용/확인 결과를 저장하여 프로세스 종료 뒤 같은 입력을 자동 반복하지 않는다.

기존 reserve→dispatch receipt→ToolBroker→result artifact→adopt/recover·예산·권한·outbox를 재사용한다. Broker는 도구 진입 전까지 검사하므로, 묶음 내부의 현재성은 작은 computer runner가 맡는다. 읽기 전용 ReadCollections의 checkpoint 패턴은 참고하되 write 효과를 readResume으로 위장하지 않는다. [통합 조사](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-use-integration-review.md)를 참고한다.

## 구현 범위와 책임

1. **계약:** session/epoch/surface/view/focus revision에 결합한 관찰, 유일한 role/name 대상과 ref, fill/click, element_value/fact_equals 조건, 제한된 관찰·대기·사용량을 정의한다. 화면 본문은 자료이며 실행 권한을 부여하지 않는다.
2. **도구와 runner:** 등록된 binding마다 observe(read)와 act(write)를 제공한다. 관찰 원본을 먼저 보존하고 work/goal/policy/driver/자료 세대에 결합한다. act는 현재 소유권·goal·task/contract·정책·자료·기한을 관찰/대기/입력 경계마다 검사한다. 초기 관찰 ref의 원본·현재성·소유 업무를 검증한다.
3. **영속 진행:** 기존 Attempt에 선택적 computer progress/head만 추가하고 단계별 intent→response/새 관찰→checkpoint를 기존 ArtifactStore+WorkState CAS로 저장한다. 실패 진단은 error ToolResult의 미검증 ref로 숨기지 않는다. 추가 저장소나 SQL 의존성을 코어에 넣지 않는다.
4. **결과 수락:** 등록 도구에 선택적인 결과 검증 callback을 보존해, computer 결과가 현재 committed checkpoint와 관찰 원본에서 재계산한 결과와 일치하는지 수신/채택 때 검사한다. 기존 도구는 그대로 동작한다. 전체 성공은 모든 행동과 사후 조건이 확인된 경우만 허용한다.
5. **합성 driver:** Query/Search/Note/Save를 가진 작은 자료 모델로 대상 교체·중복·초점 변경·늦은 준비·적용 후 불명확 응답·사람 인계·세션 재시작을 재현한다. 입력 직전 session fencing과 관찰/대상 의미를 한 동기 구간에서 확인한다. 선택적 파일은 합성 앱 상태와 입력 수를 보존하며 실제 다중 프로세스 전역 lease를 보장하지 않는다.
6. **복구와 조회:** 저장 결과 채택은 재입력하지 않는다. 실행 중 종료나 미확정 효과는 기존 unknown/effect_reconciliation 의무로 차단한다. 읽기 전용 진단으로 committed 진행을 확인할 수 있다. 단계별 자동 재개나 unknown 의무 해소는 이번 단위의 임의 추정으로 구현하지 않고 후속 명시 대조 계약으로 남긴다.

최대 3개 행동, 최대 12개 관찰, 관찰당 최대 40개 요소/32KiB와 30초 이내의 설정 상한을 둔다. 실제 원 deadline은 요청·binding·attempt lease·업무 deadline의 최소값이며 각 단계에서 다시 시작하지 않는다. 조건 대기는 같은 기한 안에서 제한된 횟수로 진행한다. 실패한 첫 입력 전에는 none, 적용된 부분은 confirmed, 전송 후 미확정은 unknown으로 기록한다.

## 검증 계획

- 세션/관찰/대상 혼동, 원본 유실·변조, 중복 이름·재렌더·초점/창 변경 때 실제 입력 0을 확인한다.
- 단계 사이 정책/목표 변경·취소·사람 인계·기한 소진 후 추가 입력이 없고 이미 발생한 효과가 지워지지 않는지 확인한다.
- 조건이 늦게 준비되거나 거짓인 경우 입력 성공을 업무 성공으로 처리하지 않는지 확인한다.
- 두 영속 backend에서 단계 intent/head, 부분 효과와 unknown 의무, 저장 결과 재채택을 확인한다. child 프로세스 종료 전후 합성 앱 입력 수를 비교한다.
- 동일 검색/저장 목표의 단일 행동 호출과 짧은 묶음에서 결과·입력 수·도구 호출·driver 내부 호출·본문 bytes·가상 대기를 구분해 관측한다. 합성 수치를 실제 모델/driver의 p50/p95 성능으로 표현하지 않는다.
- 관련 targeted 이후 고정 Node의 전체 verify와 원본 1,973파일·lock·이전 기록·source/build 대응을 확인한다. 루트만 emitting build를 실행한다.

## 남는 전체 요구

P3-04 전체 범위를 유지한다. 첫 단위 통과 시 status=in_progress, local_contracts=partially_verified다. 이후 실제 로컬 합성 Web driver와 그에 대한 관측/행동/확인, 원본 정책·세션 복구·효과 대조, 이미지/좌표/창 환경과 기준선 비교를 증거에 따라 연결한다. OS/앱/브라우저·기존 driver 선택과 사내 화면의 G-DATA, 운영 동시 소유권은 실제 연결 단계의 조건이다.

실제 모델/API 시험 중단을 유지한다. 이번 단위는 실제 회사 화면·MCP·Knox·운영 컴퓨터 입력·배포를 실행하지 않는다. 범용 typed 계약과 교체 가능한 driver를 만들며 보안 업무에 특화한 코어 분기를 추가하지 않는다.
