# P2-04 다음 구현 단위 — 지침 수명과 묶음 조회 계약

2026-09-05 · 669개 전체 시험 기준선 · 전체 챕터 진행 중

[학습 방식](/Users/seunghanee/Documents/secumon/design/04-learning-guide.md)에 따라 개념·상세 계획·구현·검증·기록을 이어간다. 앞 단위의 재사용/합류/도구 목록 검증 기록은 당시 소스와 함께 보존한다.

## 이번에 구분할 개념

지침 본문은 같아도 현재 업무에 적용할 방법과 권한은 달라질 수 있다. 본문 재사용은 원본의 현재 유효성을 검사한 뒤 수행하고, 업무별 선택 이유·필수 규칙·방법 판단은 다시 계산한다. 페이지 응답을 받았다는 사실도 전체 조회가 끝났다는 뜻은 아니다. 항목별 성공/일부 결과/오류/미실행과 전체 범위를 따로 검증한다.

## 구현과 통합 순서

1. 지침 제공자의 모든 목록 페이지를 같은 revision으로 모은 뒤 원자적으로 교체한다. 실패·취소·중복은 이전 목록을 유지한다. 검색 cursor는 업무/목표/권한/목록 snapshot과 결합하고 반환 JSON 전체에 byte 상한을 적용한다.
2. 정확한 manifest와 원본을 검증할 수 있는 제공자에만 크기 제한 본문 캐시를 적용한다. 원본 검증, artifact 검사, decode/put 비용을 구분한다. 파일 제공자의 검증도 실제 읽기를 하므로 이를 I/O 0회로 표현하지 않는다.
3. composeRuntime과 core.guidance.find/load를 연결한다. 비동기 load 뒤 현재 업무·권한·목표를 확인하고, 과거 호출 복사 및 모델 컨텍스트의 지침 유효성 경계도 검토한다. 기존 목록 호출 형식과 선택적 로딩은 유지한다.
4. 묶음/페이지 조회의 순수 계약을 추가한다. 신뢰된 batch 기대 집합, 항목 ID/입력 digest, snapshot/cursor, 누락/중복, 미실행·부분 실패, 명시적 미완료 항목 재시도, 호출/페이지/항목/byte 상한을 검증한다. 완료한 항목은 재시도에 포함하지 않는다.
5. 합성 정상·실패·경합 시험과 기존 전체 검증을 실행하고 변경 파일·명령·결과·한계를 새 기록에 저장한다. 원본 1,973파일 및 기존 검증 자료를 보존한다.

## 다음 연결 단계와 완료 기준

순수 조회 상태의 직렬화/복원 검사는 영속 실행 재개 기능과 구분한다. durable runner는 호출 의도를 먼저 저장하고, 수락한 page와 cursor를 같은 work CAS로 게시해야 한다. lease/소유권·정책/목표·정확한 도구 계약·출처 snapshot·근거/기억 수명 검사를 매 호출과 commit 직전에 연결한다. 명시적 후속 attempt는 마지막 수락 checkpoint에서 미완료 항목만 이어간다. 호출 의도만 남은 read의 결과는 unknown이며 이를 성공으로 승격하지 않는다.

이번 기록에서 durable runner를 연결하지 않았다면 batch/page의 실제 실행·프로세스 재시작 복구는 미검증으로 남긴다. 전체 P2-04의 내부 조회 비용 평가와 실제 모델 완료 조건 역시 별도로 유지한다. Python·새 의존성·실제 모델/API·사내 서비스·컴퓨터 유즈를 사용하지 않는다.

## 후속 내부 I/O 분석 메모

독립 소스 검토는 개선 후보 두 곳을 찾았다. 아직 구현하거나 성능을 측정한 결과는 아니다.

- `WorkResources.original`의 텍스트 경로는 exists 다음 get을 호출하며 FileArtifactStore에서는 둘 다 본문 읽기·해시 검사를 수행한다. 검증된 get 한 번으로 존재/무결성/본문을 확인하고 전후 현재 상태 검사를 유지하는 방향을 시험한다. reference-only는 별도로 다룬다.
- ContextCompiler의 copy/reuse 관측은 결과 get/parse 뒤 WorkResources에서 같은 결과·dispatch receipt를 다시 읽는다. 현재 권한/출처 검증을 완료한 result/task/receipt 묶음을 내부에서 전달해 중복 materialization을 줄이는 방안을 시험한다. compiler의 강한 dispatch/effect/input 검사를 공통 경로로 옮기고 reference-only 회귀를 유지해야 한다.

두 업무군×두 영속 backend에서 실제 get/exists/bytes/hash·receipt/get·decode/parse 계수와 동일 출력/근거 ID/관측 시각을 비교한다. 중간 원본 삭제·손상·권한/기억 변경 거부도 검증한다. 현재 ContextCompiler.sourceReads는 중첩 WorkResources 조회를 포함하지 않으므로 전체 I/O 분모로 쓰지 않는다. commitWithArtifacts는 이미 한 commit의 중복 참조를 묶으며, commit 사이의 exists=true 캐시는 원본 삭제/손상을 놓칠 수 있으므로 적용하지 않는다.
