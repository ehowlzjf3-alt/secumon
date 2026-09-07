# P2-04 영속 조회 실행 계획

이 단위는 조회의 진행 지점을 대화 기억과 분리해 실행 장부에 저장한다. 기존 순수 batch/page 검증기를 실제 실행·재시작·결과 조회·compact 경로에 연결한다. 학습 순서는 개념 → 완료 조건 → 구현 → 정상/실패/복구 검증 → 학습 기록이다.

## 배울 개념

- 논리 tool attempt, 내부 요청 intent, 수신한 원응답, 채택한 page는 서로 다른 사실이다. 응답이 없는 intent는 성공으로 간주하지 않는다.
- cursor는 다음 조회 위치이며 완료 증명이 아니다. source snapshot, 요청 항목, 남은 호출 예산과 원응답을 함께 검증한다.
- checkpoint는 정본 실행 장부가 가리키는 artifact다. 모델은 원 cursor를 편집하지 않고 attempt/checkpoint ID로 명시 재개를 요청한다.
- compact는 진행 지점의 작은 참조를 유지한다. 원응답과 근거 ID/관측 시각은 원본 저장소에 남긴다.

## 구현 순서

1. 읽기 전용 collection 계약, TaskSpec.readResume, Attempt.readProgress와 ToolResult.collection proof를 추가한다. 같은 task ID의 의미 변경과 fresh+resume 조합을 거부한다.
2. 호출 intent와 checkpoint를 work CAS에 먼저 저장한 뒤 source adapter를 호출한다. 응답 크기·형태·snapshot·근거/원본·현재 정책을 확인하고 원응답/진행 지점을 함께 게시한다.
3. 완전한 page만 다음 page로 진행한다. 부분 결과와 실패는 멈추고, terminal attempt의 최신 head를 명시 재개한다. 부모 head에 단일 successor를 CAS로 기록해 분기와 예산 초기화를 막는다. 응답 없는 이전 intent도 호출 예산에 포함한다.
4. 현재 정책/목표/수명/계약, dispatch 영수증, 부모 계보와 원응답 replay로 checkpoint와 최종 projection을 검증한다. receive/adopt/과거 조회/모델 전송 경계에 같은 검증을 연결한다.
5. compact와 복구에서 미완료 tip과 완료 후 결과 미채택 tip을 보존한다. 호출 본문/페이지 cursor는 context에 직접 넣지 않는다.

## 완료 조건과 시험

- 두 영속 backend와 두 합성 업무군에서 여러 page, 부분 항목 재개, 실제 close/reopen 후 이어가기를 확인한다.
- source 오류·timeout/취소·응답 없는 intent·예산 소진·중복 재개·부모 변경·정책/목표/계약/근거 수명 변경을 검증한다.
- 성공 항목은 재요청하지 않고 원근거와 시각을 유지한다. 내부 실패/unknown도 maxCalls에 포함하며 이전 attempt의 보고 비용을 새 attempt에 중복 합산하지 않는다.
- 위조/손상/삭제된 checkpoint와 원응답은 결과·과거 조회·모델 입력에서 거부한다. 원응답 자체의 외부 진실성은 제공자 계약의 한계로 남긴다.
- 전체 repository verify를 고정 Node 24.20.0에서 실행하고 학습/검증 로그·source hash를 새 기록으로 저장한다. 이전 780개 검증 기록은 보존한다.

## 범위와 후속

WorkState.artifacts는 결과 채택 전에도 영속 진행에 필요한 원본의 인덱스로 사용한다. Evidence의 업무 채택은 기존 최종 결과 경로에서 수행한다. 부분 collection의 개별 근거가 목표를 충족할 수 있으므로 collection 완료와 목표 criteria 충족을 구분한다. 전체 수집을 요구하는 목표는 그에 맞는 criteria를 설정해야 한다.

read-only 재개는 새 요청 ID를 사용하며 외부 서버의 exactly-once를 보장하지 않는다. 보수적인 전체 정책/목표/수명 일치와 bounded checkpoint를 먼저 구현한다. 누적 checkpoint 인덱스의 I/O 절감 및 증분 비용 평가는 다음 단위다. P2-04 전체와 실제 모델 조건은 이 단위의 로컬 통과만으로 완료 처리하지 않는다. 실제 모델/API/사내 서비스 호출 없이 합성 자료로 검증한다.
