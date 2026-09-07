# P2-04 첫 구현 단위 — 재사용·합류·도구 목록

2026-09-05 · v0.22 · 첫 구현 단위 로컬 검증 완료 · 챕터 전체 진행 중

## 이번에 공부할 구분

같은 자료를 다시 읽는 것, 저장된 결과를 다시 쓰는 것, 이미 진행 중인 실행을 기다리는 것은 다르다. 실제 호출을 줄였다고 새로운 근거가 생기지는 않는다. 따라서 실행 시도·원 관측·소비자를 분리해 기록한다.

- **저장 결과 재사용:** 업무·목표·주체·정책·정확한 도구 계약·입력이 같고, 신뢰된 read 도구가 immutable sourceVersion 또는 TTL을 선언한 경우에만 허용한다. task의 `freshness: fresh`는 실제 새 호출을 요구한다. 과거 근거 ID·시각·lineage를 유지하며 원본 무결성과 현재 근거·기억 출처를 다시 검사한다.
- **진행 실행 합류:** 같은 프로세스의 같은 ExecutionJoin 인스턴스를 이용하는 work/attempt caller들이 한 대기를 공유한다. caller 취소는 자기 대기만 끝낸다. owner·lease·deadline·재시작 후 영수증은 기존 업무 상태에 남는다. 다른 인스턴스의 진행 실행에는 저장 상태를 읽어 waiting을 반환한다.
- **도구 목록 갱신:** 제공자의 모든 페이지를 수집하고 동일 revision·중복·명세를 검증한 뒤 목록을 교체한다. 실패한 수집은 이전 목록을 유지한다. 검색 cursor는 현재 질의·권한·snapshot과 결합되며 모델에 필요한 페이지와 정확한 명세만 전달한다.

## 코드 연결

- [재사용 판단과 검증](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-result-reuse.ts), [실행 루프](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts), [실행 직전 검사](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts).
- [합류와 caller 취소](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-join.ts), [도구 목록 갱신](/Users/seunghanee/Documents/secumon/runtime/src/application/provider-tool-snapshot.ts), [페이지 검색](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-catalog.ts).
- [호출·비용 집계](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-execution-usage.ts), [원출처 조회](/Users/seunghanee/Documents/secumon/runtime/src/application/work-resources.ts), [컨텍스트 조립](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts).

예약에 정확한 tool definition digest를 고정한다. 명세가 바뀌면 실행 전 거부하고 예약을 정리한다. 재사용 후보도 기존 dispatch/receive/adopt 흐름을 따르며, 결과 저장과 채택 commit 직전에 출처를 재검증한다. 결과의 원본 연결은 호출 이력·복사·컨텍스트에서도 검사한다.

논리 시도 예산 `toolCalls`는 유지한다. `Attempt.execution`에는 실제 구현 진입 여부와 adapter가 보고한 transport/내부 연산/이미지 bytes/대기 시간을 별도로 저장한다. 보고하지 않은 비용은 null이다. dispatch 뒤 프로세스가 끝나 결과와 계측을 저장하지 못했다면 실제 진입 여부도 unknown이다. 재사용 소비자에게 원 실행 비용을 다시 더하지 않는다.

`composeRuntime`의 `executionJoin.execute(workId, attemptId, signal)`은 내부 실행 조정용이다. 사람의 권한 확인을 대신하는 공개 API가 아니며 기존 raw `runtime.execute`를 직접 호출한 caller까지 합류한다고 주장하지 않는다. received를 settled로 반환해도 업무 채택·완료는 별도다.

## 현재 검증 기록

최종 `npm run verify`는 Node 24.20.0에서 **669/669 통과, 실패 0**이다. 코어 별도 타입 검사, 안쪽 계층 57파일/의존성 위반 0, 합성 4시나리오/22판정도 통과했다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-efficiency-local-verification.json)에 현재 소스 hash와 [전체 실행 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-efficiency-verify.log)를 보존한다.

추가 시험은 148개다. 카탈로그 수명 35, 재사용 판단 39, 합류 18, 실행·비용·컨텍스트 통합 26, Broker 갱신 경계 16, 호출 복사본의 registry 갱신 14개를 포함한다. 문서/관측 두 업무군과 SQLite/파일 저널에서 세 번의 논리 시도에 원 구현 호출 1회·재사용 2회·근거 1개를 확인했다. 중간 close/reopen 뒤에도 같았다. 합성 adapter의 보고 비용은 transport 2회·내부 연산 3회·이미지 512 bytes·대기 4ms가 한 번만 집계됐으며 실제 API 측정값이 아니다.

첫 targeted 실행은 109개 중 106개 통과, 3개 실패였다. 두 건은 기존 예약 만료 상태를 cancelled로 잘못 기대한 신규 시험, 한 건은 schema 변경 시험의 strict Ajv 명세 오류였다. 기존 동작에 맞게 시험을 수정했다. 이후 648개 전체 시험 통과 뒤 동적 registry 경계를 추가 검토했고, 최종 669개로 다시 검증했다. 권한을 잃은 과거 복사본을 참조로 유지하는 기존 두 회귀도 보존했다.

독립 검토는 재사용 조회 중 기억 출처 변경, digest가 없는 과거 attempt의 계약 갱신, 새 오류 코드의 예약 정리, 미실행 예약의 비용 집계를 지적했다. 마지막 호출 직전 재검사와 기존 상태의 보수적 해석을 추가하고 각 경로를 검증한다.

목록을 실행 중 교체할 수 있게 되면서 원본 읽기와 반환 사이에도 계약이 바뀔 수 있다. 호출 이력은 읽은 원 도구·카탈로그 대상·지침 manifest를 반환 직전에 다시 검사한다. 재사용 find/validate도 마지막 await 뒤 명세를 확인한다. 컨텍스트의 observation에는 원 도구 계약 참조를 붙여 활성 도구 명세에서 원 도구가 빠져도 전송 직전 검사한다. 유효성을 확인할 수 없는 과거 복사본은 본문을 보내지 않고 참조로 남긴다. 저장된 예전 모델 입력의 observation에 계약 참조가 없으면 그대로 전송하지 않는다.

## 이어서 구현할 범위

이번 단위로 [전체 P2-04 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-efficiency-plan.md)을 완료하지 않는다. 단일 read attempt의 batch/page/증분 checkpoint, 지침 목록과 본문 수명, 내부 파싱·receipt 조회 재사용, 실제 I/O까지 포함한 통합 비용 평가가 남아 있다. 제공자 catalog 페이지 수집은 업무 데이터의 페이지 진행 계약을 대신하지 않는다.

카탈로그 cursor는 유실돼도 다시 검색 가능한 프로세스 메모리다. 기본 composition은 Clock/ID를 주입해 만료와 재시작 시 무효화를 적용한다. 이것을 영속 업무의 재개 cursor로 사용하지 않는다. 동일 명세로 callback 구현을 바꾸면 content digest로 구별되지 않으므로 제공자가 구현 의미에 맞는 version/sourceRevision을 관리해야 한다.

현재 재사용은 동일 업무 안에서 원 호출로 직접 연결하며 복사된 hit를 다시 원본으로 승격하지 않는다. 64 KiB를 넘는 결과는 보수적으로 miss 처리한다. 새 도구와 이전 시도에 명시적 계약·실제 구현 진입 기록이 없으면 miss다. 이 단위는 원본 I/O 절감이나 실제 모델 판단 품질 향상을 입증하지 않는다.

실제 모델/API·사내 MCP·Knox·컴퓨터 유즈 시험은 실행하지 않는다. 전체 P0–P6 목표와 실제 모델 미검증 조건을 유지한다.
