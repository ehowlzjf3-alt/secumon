# P2-04 내부 조회 비용과 증분 checkpoint

2026-09-05 · 기준선 v0.24, 842개 로컬 시험

이전 단위는 호출 intent·원응답·영속 재개와 원본 검증을 구현하고 실행 증거를 남겼으므로 진전이다. 이번에는 검증 강도를 유지하면서 본문 저장과 반복 읽기 비용을 줄인다. 전체 P0–P6 목표, 실제 모델/API 시험 중단, 원본 보존을 유지한다.

## 개념과 구현 계획

1. 기존 v0.24 dist를 별도 임시 경로에 보존한다. 같은 합성 fixture를 두 업무군·두 영속 backend에서 실행하고 API 호출수, 실제 파일 본문/metadata 읽기·hash bytes, 영수증/상태 조회·commit, 결과와 근거의 의미를 구분해 측정한다. 기존 코어에 관찰용 FileArtifactStore 계측만 적용한 비교도 원 기준선과 구분한다.
2. 저장 checkpoint를 start/resume/intent/settle/stop 변경 기록으로 표현한다. 각 기록은 이전 head와 논리 상태 digest를 포함한다. 원 페이지 본문은 기존 raw artifact에 한 번 저장하고, 논리 ReadCheckpoint API는 그대로 재구성한다. 기존 v1 snapshot의 읽기와 재개도 유지한다.
3. 복원은 깊이·누적 bytes·원본 참조·정책으로 제한한다. base 누락/변조·분기/순환·요청/원응답 불일치·logical digest 불일치가 있으면 거부한다. decoder 성공과 dispatch/현재 권한/부모 소유권 검증을 별개로 유지한다.
4. 한 번의 검증 안에서 exact-ref 읽기와 JSON 파싱을 제한적으로 공유한다. 반환 전 원본/정책/기억/계약 검사는 유지한다. 프로세스를 넘어 유효성을 추정하는 exists=true 캐시는 만들지 않는다.
5. WorkResources의 원문 get과 결과 복사/ContextCompiler materialization에서 중복 처리를 줄인다. 검증된 내부 정보를 재사용하되 모델에 보내는 결과의 근거 ID·관측 시각·새 관측 여부를 바꾸지 않는다.

첫 동일 adapter 비교에서 문서 16page의 본문 읽기는 약 57MB→7.9MB로 줄었지만 복원 CPU 비용 때문에 대부분의 실행 시간이 증가했다. 이를 근거로 결정적인 논리 복원 결과만 64개 head/직렬화 논리 bytes 16MiB 이내에서 재사용한다. 같은 ArtifactStore 인스턴스 안의 가속 수단이며, head와 모든 입력 artifact를 현재 정책/인덱스로 다시 읽어 무결성을 확인한 뒤 사용한다. writer가 주장한 미검증 상태는 넣지 않고 decoder로 확인한 상태만 저장한다. 권한·원본 유효성 결과를 캐시하는 방식과 구분하며 재시작 시 없어져도 같은 동작이어야 한다.

## 검증과 완료 조건

- 4/8/16개 page와 충분한 합성 본문을 두 업무군×두 backend에서 동일하게 실행한다. collect·checkpoint 읽기·과거 호출 조회·context·재시작의 비용을 구분한다.
- 비교 결과/근거/관측 시각/사용자 의미와 source 호출 수가 같아야 한다. checkpoint ID처럼 저장 형식 변화로 달라지는 참조는 비교에서 명시적으로 구분한다.
- 실제 FileArtifactStore readFile/hash에 들어간 bytes와 상위 get/exists 카운트를 별도로 보고한다. OS 캐시/물리 디스크 I/O/실제 모델 과금 절감으로 확대하지 않는다.
- v1→v2 재개, partial/unknown/완료 orphan, base/raw 유실, 손상·초과 크기·현재 권한/계약·기억 변경, 반복 compact 및 원본 검증 회귀를 통과해야 한다.
- 저장소 adapter 변경 없이 동작하고 안쪽 계층은 Node에 의존하지 않는다. 전체 repository verify와 원본/링크/JSON/소스 검증 후 학습 결과와 새 기록을 저장한다.

## 이번 단위의 한계

원본을 매번 다시 검증하는 비용과 work 전체의 CAS 인덱스 크기는 남을 수 있다. 감소율은 실제 측정 범위에만 적용한다. 증분 기록은 추론 품질·외부 도구 exactly-once·분산 source-to-effect 원자성·사내 모델/Knox/MCP 연동을 증명하지 않는다. 로컬 효율 조건을 충족해도 실제 모델 조건이 남은 P2-04 전체는 완료 처리하지 않는다.
