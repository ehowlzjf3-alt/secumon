# P2-04 — 지침 수명과 묶음 조회 계약

2026-09-05 · v0.23 · 이번 단위 로컬 검증 완료 · 전체 챕터 진행 중

## 배운 내용과 이번 변경

지침은 본문·현재 적용 방법·실행 권한을 구분한다. 같은 본문을 재사용해도 현재 목표, 업무 종류, 선택 이유와 필수 규칙을 다시 확인해야 한다. 원본이 바뀌거나 삭제되면 과거 호출 결과와 compact된 컨텍스트도 그 지침을 계속 사용하면 안 된다.

지침 목록은 모든 페이지와 revision·중복·상한을 검증한 뒤 교체한다. 실패한 새 목록으로 이전 목록을 지우지 않는다. 선택적으로 `maxBytes`/`cursor`를 지정하면 업무·목표·권한·snapshot에 묶인 페이지를 반환한다. byte 상한은 `ToolResult.output`에 들어가는 페이지 전체 JSON 기준이다. 기존 kind/limit 호출은 목록과 방법 선택을 함께 반환한다.

본문 캐시는 개수·총 bytes 상한 안에서 사용하며, 정확한 원본을 검증할 수 있는 제공자만 hit를 허용한다. hit에서도 원본 검사와 artifact 무결성 검사는 수행한다. 저장된 본문만으로 지침의 현재 유효성을 확인하지 않는다. 검증 API가 없는 기존 제공자는 새 원본과 완전한 새 목록을 읽어 검증하며 비용을 별도로 기록한다.

원본 검사 경로를 `core.guidance.load`, 과거 호출 및 중첩 복사 조회, 컨텍스트 조립, 저장된 모델 입력의 전송 직전에 연결했다. 비동기 읽기 뒤 현재 업무·권한·목표·기억 출처를 다시 확인하고 마지막에는 도구와 지침 명세를 동기로 대조한다. 모델 전송 전 원본 검증 대기도 실행 lease의 남은 시간으로 제한한다.

## 묶음·페이지의 순수 계약

새 `ReadCollectionState`는 수락한 페이지와 미완료 페이지를 구분한다. 신뢰된 batch 기대 집합 및 각 항목의 ID/입력 digest를 실제 응답과 대조한다. 페이지 snapshot·cursor·전체 항목 수, 중복/누락, accepted request ID 재사용, 호출/페이지/항목/byte 상한을 검사한다. 일부 항목만 성공한 상태를 전체 완료로 바꾸지 않는다.

명시적 다음 요청은 성공한 항목을 보존하고 미완료 항목만 다시 요청한다. 재시도 불가 오류는 멈춘다. 이 reducer는 모델이나 도구를 호출하지 않으며, 직렬화한 상태를 읽을 때도 구조와 누적 상한을 검증한다.

아직 영속 runner와 연결하지 않았다. 따라서 실제 호출 의도 저장, page와 cursor의 원자적 게시, lease 소유권, 현재 정책·근거/기억 수명, 명시적 후속 attempt, 프로세스 재시작 복구는 다음 단계다. 수락된 응답 수와 실제 dispatch 수는 다르며 실패/unknown 호출 예산도 이후 runner가 보존해야 한다. 미완료 항목을 최종 응답으로 교체하기 전에 각 원응답을 artifact 이력으로 저장해야 중간 partial의 관측을 잃지 않는다.

## 코드와 검증

- [지침 목록·본문·원본 검사](/Users/seunghanee/Documents/secumon/runtime/src/application/guidance.ts)와 [파일 제공자 및 실제 읽기 계수](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-guidance.ts).
- [도구 경로](/Users/seunghanee/Documents/secumon/runtime/src/application/resource-tools.ts), [과거 결과·복사본 출처](/Users/seunghanee/Documents/secumon/runtime/src/application/work-resources.ts), [컨텍스트](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts), [모델 전송 전 검사](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts).
- [조회 상태 타입](/Users/seunghanee/Documents/secumon/runtime/src/domain/read-collection.ts)과 [순수 수락·다음 요청 검증](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collection-validation.ts).

첫 targeted 실행은 112/115였다. 원본을 다시 검사하면서 달라진 기존 읽기 계수 기대 두 건과 더 이른 원본 변경 거부 코드를 반영하지 못한 신규 기대 한 건을 수정했다. 두 번째 targeted 실행은 94/94 통과다. 최종 Node 24.20.0 npm run verify는 **780/780 통과, 실패 0**이며 코어 타입 검사·안쪽 계층 60파일/위반 0·합성 4시나리오/22판정도 통과했다. [새 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-guidance-collections-local-verification.json)에 소스 146파일 hash와 전체 실행 로그 참조를 보존했다.

추가한 시험은 111개다. 지침 수명 27, 도구 경로·두 업무군 통합 14, 두 영속 저장소의 과거 복사본 원본 검사 8, 원본 검증·모델 입력/전송·재시작 27, 순수 묶음·페이지 계약 35개다. 원본 검증이 응답하지 않는 경우도 남은 lease로 중단하고 실제 대역 전송이 없었음을 확인한다.

중간 전체 778개 통과 후 별도 검토에서 source probe 중 저장 artifact가 사라지는 경합을 확인했다. 기존 build의 로컬 대역 실증에서는 본문이 모델로 넘어간 뒤 결과 저장만 실패했다. 새 경로는 probe 뒤 artifact의 접근·hash/크기·존재/무결성을 검사한다. 추가 두 회귀에서 모델 전송은 0회지만 결손 artifact 때문에 취소 영수증도 저장할 수 없음을 확인했다. 저장소를 복구한 후 명시적으로 정산을 재개하며, 결손 상태를 정상 정산 완료로 표시하지 않는다.

FileGuidanceSource 합성 시험에서 cold load는 원본 본문 read와 최종 probe로 2회, hot load는 probe로 1회 원본을 읽었다. artifact put과 본문 decode는 cold 1회, hot 0회이고 hot artifact 검사는 1회다. 검증용 24-byte 본문의 원본 읽기 bytes는 48→24였다. 두 업무군의 runtime 통합에서도 같은 구분을 확인했다. 이는 작고 통제된 합성 관찰이며 전체 runtime I/O나 운영 지연의 절감률은 아니다.

## 남은 범위

다음 구현은 page 응답/진행 checkpoint를 실제 read attempt 장부와 연결하고 두 영속 backend에서 실패·중단·재개를 검증하는 것이다. 그다음 receipt/parse 및 원본 무결성 검사까지 포함한 내부 I/O를 계측해 최적화한다. 제공자가 선언한 snapshot/전체 수의 진실성, 서로 다른 저장소 간 원자성, 실제 모델 품질과 API/MCP/Knox/컴퓨터 유즈 연동은 이번 로컬 검증의 범위를 넘는다.

[전체 P2-04 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-efficiency-plan.md)과 [이번 상세 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-guidance-collections-plan.md)을 유지한다. 중단한 키 탐색/실제 모델 시험은 재개하지 않았으며, 이전 [669개 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-efficiency-local-verification.json)을 덮어쓰지 않는다.
