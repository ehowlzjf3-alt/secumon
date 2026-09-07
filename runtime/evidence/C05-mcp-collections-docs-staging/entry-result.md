# C05 — MCP 수집 일반 입구 재개 결과

@@MARKER@@
@@INTRO@@

## 이번에 확인한 흐름

@@ENTRY@@

일반 프로필의 `createMcpHostTools`에 `collectionBindings`를 연결했다. 같은 endpoint/provider의 단순 읽기와 수집 등록은 한 online 발견 session을 사용하고, 명시 `stored_only` 등록은 peer를 만들거나 발견하지 않는다. 같은 C01의 state·artifact·계약·원문 저장소를 재사용하며 별도 DB나 복구 전용 task schema를 만들지 않았다.

재개는 저장 수집 응답의 reconciliation과 정산을 필요한 compact·첫 문맥 복원보다 먼저 처리한다. 원 부모의 실패 상태·owner·원문·이전 사용량은 보존한다. 복구된 complete checkpoint는 부모 성공이나 목표 완료가 아니다. 모델이 실제 입력의 `stored_complete` 안내와 원 query를 보고 기존 `TaskSpec.readResume`로 후속 시도를 명시해야 한다. 실행기는 원 parent/head/query/계약/현재 권한과 원문을 다시 확인한 뒤 같은 `ReadCollections`의 로컬 소비를 정상 reserve/dispatch/receive/adopt로 연결한다. 별도 permit 장부나 모델이 부여하는 실행 권한은 없다.

완전한 결과의 로컬 소비는 논리 `toolCalls` 1회이며 원격 fetch는 0회다. 일반 `Tool.execute`나 collection fetch를 우회 호출하지 않는다. 모델이 공개된 근거 ID를 사용해 수행하는 `core.evidence.find/get`과 답변·compact 호출은 각각 기존 예산과 회계를 따른다. online 프로필에서도 정확한 complete 후속 소비의 의미는 같다.

미완료 수집은 현재 checkpoint에서 다음 요청이 가능한지 확인한 뒤 `connection_required`로 기다린다. 반복 재개만으로 새 예약·원격 호출을 만들거나 자동 online 전환을 하지 않는다. 명시 online 재열기는 원 snapshot/cursor를 잇는 다음 페이지 또는 실제 실패 항목만 요청한다. 기다리는 수집과 관계없는 진행 가능한 업무까지 일괄 차단하지 않는다.

## 문맥과 저장 근거 조회

@@IMPROVEMENTS@@

문맥 선택의 inspect/prepare가 선택 후보의 실제 byte 크기를 기준으로 다음 선택 폭을 줄이도록 고쳤다. 빈 byte 여유가 많아 같은 전체 후보를 반복하거나, 한도에 들어오는 선택 항목까지 모두 잃는 반례를 막는다. 필수 항목·유한 선택 횟수·최종 송신 요청 측정·출처 현재성 검사는 유지한다. 최적 선택이나 실제 tokenizer 정확도를 증명한 것은 아니다.

원근거 조회의 준비 진전은 현재 목표·범위·허용 정책에 맞는 실제 `core.evidence.find/get` 채택에서만 생긴다. 표시 ID·locator·시각을 바꾼 동일 내용이나 파생 복사본을 새 진전으로 세지 않는다. 성공적으로 반환된 최초 원근거 카드와 읽을 수 있는 본문의 준비 진전을 구분하며, 부족한 응답·임의 수정 입력·거절 결과로 진전을 만들지 않는다. 새로운 사실을 확인했거나 사용자의 목표를 달성했다는 뜻은 아니다.

complete 안내는 모델에게 보낼 packet에만 선택적으로 붙인다. 원래 수집 문맥의 네 필드와 progress의 정확한 비교, 구형 marker 없는 저장 입력과 수신 proof는 보존한다. 원문이 사라진 legacy 입력을 조용히 marker 없는 입력으로 취급하지 않는다. 같은 검증 단계에서 이미 읽은 checkpoint/frontier를 재사용하고 최종 실행·채택 단계의 현재 증명은 다시 확인한다.

## 증거와 보존한 실패

@@EVIDENCE@@

[최종 로컬 선택 기록](@@ROOT@@/runtime/evidence/C05-mcp-collections-local-final1.json)은 native 실행 전의 실제 로컬 결과다. 최종 proof와 별개인 [초기 통합 기록](@@ROOT@@/runtime/evidence/C05-mcp-collections-local-integration-result.json), [문맥 수렴 반례](@@ROOT@@/runtime/evidence/C05-context-selection-convergence-staging/result.md), [준비 진전 호환 교정](@@ROOT@@/runtime/evidence/C05-evidence-recall-progress-compatibility1.json)도 원본과 해시를 보존한다. 추가 보존 파일은 updater 출력의 `retainedCandidateEvidence`에 기록하며 proof.files에 포함된 근거로 가장하지 않는다.

실패했던 로컬 실행은 당시 source와 실제 집계를 남겼다. 최종 통과로 원로그나 미확정 원인을 바꾸지 않는다.

@@HISTORY@@

@@NATIVE_HISTORY@@

선행 [단순 읽기 offline proof](@@ROOT@@/runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json)의 수치와 소스는 역사적 별도 검증이다. 이번 묶음에 더해 총계로 보고하지 않는다. 문맥 반례와 조회 진전 교정 역시 제품 전체 성능 측정이 아니다.

## 남은 범위

@@NEXT@@

collection의 응답이 전송 뒤 도착할 때 현재 본문 사용 권한이 철회된 경우, 원응답 보관과 known usage 정산을 분리하는 경계는 이번 complete 복구 인수로 완료됐다고 볼 수 없다. 이미 구현·검증한 단순 읽기 custody와 별개인 collection 페이지별 필수 후속이다. sent 표시는 실제 원격 실행이나 과금 증명이 아니며 알려지지 않은 값을 추정해 채우지 않는다.

원문 전체 재검증·상태 조회는 여전히 비용이 든다. [조회 비용 검토](@@ROOT@@/design/chapters/C05-context-cost-review.md)에 남긴 중복 경로를 현재성 경합과 함께 측정해야 한다. 이번에는 새로운 물리 I/O·지연·처리량·실제 토큰 절감률을 측정하지 않았다. 별도 wait/collection 전체 인수와 실제 외부 서비스 연결을 일반 입구 5사례가 대신하지 않는다.

@@REMAINING@@ 실제 SIGKILL은 관측한 중단 경계의 증거이며 전원 장애나 모든 파일 시스템의 내구성 보장은 아니다. HTTP 시험은 네이티브 요청 인수이고 브라우저 화면 검증은 별도다.
