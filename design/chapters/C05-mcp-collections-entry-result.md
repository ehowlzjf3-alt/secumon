# C05 — MCP 수집 일반 입구 재개 결과

<!-- C05-MCP-COLLECTIONS-FINAL-PROOF: 1ef802e5b3473c96de38f364f62815584f8f1206d441a473be8666c1ecb61fd9 -->
**MCP 수집의 일반 입구 재개와 저장 근거 조회**를 연결했다. 같은 담당의 여러 항목 수집을 일반 CLI·Web에 연결했다. 저장된 원응답을 먼저 정산하고 필요한 대화 요약과 문맥 복원을 거친 뒤, 모델이 명시한 완전한 저장 결과의 후속 시도를 로컬에서 소비한다. 새 페이지가 필요하면 연결을 기다리고 명시 온라인 재열기에서 다음 페이지나 실패 항목만 요청한다. **macOS Node24 신규 183/183·관련 519/519, NAS Linux Node24 신규 183/183·관련 519/519·전체 3,691/3,691 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-usage.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-plan.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-linux-nas-20260908/verification.json). 완전한 저장 결과 안내는 실행 허가가 아니다. 원 부모·원문·영수증·현재 계약과 권한을 다시 검사하며 부모의 실패를 성공으로 바꾸지 않는다. 로컬 후속 소비는 논리 도구 호출 한 번이고 원격 전송은 0회다. 필요한 근거 조회와 새 모델 호출은 기존 예산을 따른다. 문맥 선택은 실제 한도에 들어오는 선택 항목 일부를 유지하도록 수렴을 고쳤다. 현재 허용된 원근거의 최초 카드·본문 조회만 준비 진전으로 인정한다. 동일 내용·파생 복사본의 반복 조회는 기본 무진전 한도 3을 초기화하지 않으며 준비 진전은 새 사실이나 목표 완료가 아니다. 다음 필수 단위는 collection 페이지별 전송 후 원응답 보관·known usage 정산과 현재 본문 채택의 분리다. 기존 단순 읽기의 보관 인수와 구분하며 아직 별도 구현·검증이 필요하다. 원문 재검증·조회 비용 개선도 측정과 경합 검증을 거쳐 진행한다. [필수 후속](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-plan.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태다. 실제 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이며 native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

## 이번에 확인한 흐름

실제 일반 입구는 CLI 2사례와 localhost HTTP 3사례다. SQLite/file-journal CLI는 SIGKILL 뒤 서버 없는 재개·실제 session compact·명시 저장 소비·공개된 근거 ID 조회·최종 답변을 확인했다. HTTP 두 저장 방식은 비최종 페이지 SIGKILL 뒤 반복 대기와 다음 온라인 페이지를, SQLite 한 사례는 정상 채택된 partial batch의 실패 항목만 재시도를 확인했다. 마지막 사례는 강제 종료나 file-journal 인수로 확대하지 않는다. 반복 명령은 원문·시도·예산·대화를 중복하지 않으며 HTTP 시험은 브라우저 렌더링 시험이 아니다.

일반 프로필의 `createMcpHostTools`에 `collectionBindings`를 연결했다. 같은 endpoint/provider의 단순 읽기와 수집 등록은 한 online 발견 session을 사용하고, 명시 `stored_only` 등록은 peer를 만들거나 발견하지 않는다. 같은 C01의 state·artifact·계약·원문 저장소를 재사용하며 별도 DB나 복구 전용 task schema를 만들지 않았다.

재개는 저장 수집 응답의 reconciliation과 정산을 필요한 compact·첫 문맥 복원보다 먼저 처리한다. 원 부모의 실패 상태·owner·원문·이전 사용량은 보존한다. 복구된 complete checkpoint는 부모 성공이나 목표 완료가 아니다. 모델이 실제 입력의 `stored_complete` 안내와 원 query를 보고 기존 `TaskSpec.readResume`로 후속 시도를 명시해야 한다. 실행기는 원 parent/head/query/계약/현재 권한과 원문을 다시 확인한 뒤 같은 `ReadCollections`의 로컬 소비를 정상 reserve/dispatch/receive/adopt로 연결한다. 별도 permit 장부나 모델이 부여하는 실행 권한은 없다.

완전한 결과의 로컬 소비는 논리 `toolCalls` 1회이며 원격 fetch는 0회다. 일반 `Tool.execute`나 collection fetch를 우회 호출하지 않는다. 모델이 공개된 근거 ID를 사용해 수행하는 `core.evidence.find/get`과 답변·compact 호출은 각각 기존 예산과 회계를 따른다. online 프로필에서도 정확한 complete 후속 소비의 의미는 같다.

미완료 수집은 현재 checkpoint에서 다음 요청이 가능한지 확인한 뒤 `connection_required`로 기다린다. 반복 재개만으로 새 예약·원격 호출을 만들거나 자동 online 전환을 하지 않는다. 명시 online 재열기는 원 snapshot/cursor를 잇는 다음 페이지 또는 실제 실패 항목만 요청한다. 기다리는 수집과 관계없는 진행 가능한 업무까지 일괄 차단하지 않는다.

## 문맥과 저장 근거 조회

문맥 선택은 실제 한도에 들어오는 선택 항목 일부를 유지하도록 수렴을 고쳤다. 현재 허용된 원근거의 최초 카드·본문 조회만 준비 진전으로 인정한다. 동일 내용·파생 복사본의 반복 조회는 기본 무진전 한도 3을 초기화하지 않으며 준비 진전은 새 사실이나 목표 완료가 아니다.

문맥 선택의 inspect/prepare가 선택 후보의 실제 byte 크기를 기준으로 다음 선택 폭을 줄이도록 고쳤다. 빈 byte 여유가 많아 같은 전체 후보를 반복하거나, 한도에 들어오는 선택 항목까지 모두 잃는 반례를 막는다. 필수 항목·유한 선택 횟수·최종 송신 요청 측정·출처 현재성 검사는 유지한다. 최적 선택이나 실제 tokenizer 정확도를 증명한 것은 아니다.

원근거 조회의 준비 진전은 현재 목표·범위·허용 정책에 맞는 실제 `core.evidence.find/get` 채택에서만 생긴다. 표시 ID·locator·시각을 바꾼 동일 내용이나 파생 복사본을 새 진전으로 세지 않는다. 성공적으로 반환된 최초 원근거 카드와 읽을 수 있는 본문의 준비 진전을 구분하며, 부족한 응답·임의 수정 입력·거절 결과로 진전을 만들지 않는다. 새로운 사실을 확인했거나 사용자의 목표를 달성했다는 뜻은 아니다.

complete 안내는 모델에게 보낼 packet에만 선택적으로 붙인다. 원래 수집 문맥의 네 필드와 progress의 정확한 비교, 구형 marker 없는 저장 입력과 수신 proof는 보존한다. 원문이 사라진 legacy 입력을 조용히 marker 없는 입력으로 취급하지 않는다. 같은 검증 단계에서 이미 읽은 checkpoint/frontier를 재사용하고 최종 실행·채택 단계의 현재 증명은 다시 확인한다.

## 증거와 보존한 실패

같은 source `33c45f6df85a16f8d43e0b90e9032ff332183ebc91674f63b7993146cb10fdfe`, build files digest `ff68adcf59f9cb3824eb0df7fd20b86093c17a478cfeedd42f45216b2f50c938`, compiled 파일 1,800개를 확인했다. Linux 종료는 `2026-09-07T16:19:04.063Z`이며 8단계·결과와 원로그 9개 회수·관측 가능한 전용 프로세스 0개·SSH 종료를 확인했다. 접근 불가 peer 2개와 범위 미확정 2개는 전 시스템 프로세스 부재 증명이 아니다. 로컬 최종 전체 회귀는 별도 실행하지 않았고 Linux 전체 결과와 구분한다. 합성 estimator와 모델 응답은 실제 모델 토큰·의미 품질·비용 측정이 아니다.

[최종 로컬 선택 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-local-final1.json)은 native 실행 전의 실제 로컬 결과다. 최종 proof와 별개인 [초기 통합 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-local-integration-result.json), [문맥 수렴 반례](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-context-selection-convergence-staging/result.md), [준비 진전 호환 교정](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-evidence-recall-progress-compatibility1.json)도 원본과 해시를 보존한다. 추가 보존 파일은 updater 출력의 `retainedCandidateEvidence`에 기록하며 proof.files에 포함된 근거로 가장하지 않는다.

실패했던 로컬 실행은 당시 source와 실제 집계를 남겼다. 최종 통과로 원로그나 미확정 원인을 바꾸지 않는다.

- [build1](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-build1.json): exit 1. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-build1.log), 당시 source `475ddda36a0edcb5dbd17995448df73f039ef95de60ae2d105fba372c25ff77d`.
- [build10](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-build10.json): exit 2. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-build10.log), 당시 source `f93d70a11e570f1852dee626e26cb8f1dbf006615e2360362e4c7b5839fb3d14`.
- [build2](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-build2.json): exit 2. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-build2.log), 당시 source `d0d2a406a7edaafc0365616f48b171ef9e8fe49430ead45aa3b96e112b3286be`.
- [new1](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new1.json): exit 1, 110개 중 103 통과·7 실패. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new1.log), 당시 source `4c963d245cb8c1837c82609cbe71d534833ede8a32721b391747d2b493e404f9`.
- [new3](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new3.json): exit 1, 5개 중 3 통과·2 실패. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new3.log), 당시 source `13f34041f1d4bb98a9b8663a0e2e865da3915bcbfda45d5c1f1b27b24a70fe77`.
- [new4](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new4.json): exit 1, 2개 중 0 통과·2 실패. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new4.log), 당시 source `fcb50a4a8a217426af580be4139e57eea807a68e205578af3b57dfb6e6b415a2`.
- [new5](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new5.json): exit 1, 1개 중 0 통과·1 실패. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new5.log), 당시 source `99ea0159d679c623d068b31ba6f492d460cef44ce1452e988dff7b3b231d6738`.
- [new6](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new6.json): exit 1, 2개 중 0 통과·2 실패. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new6.log), 당시 source `291311b8c7857c7da2b60a2f27c3f892d56994c43a280e259b4a1fe3641e5acb`.
- [new7](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new7.json): exit 1, 117개 중 115 통과·2 실패. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-new7.log), 당시 source `3f55a37f31e59da1bef14f6fbded1d282aad4c7317f2cd8aa0da776ec35cacc5`.
- [related3](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-related3.json): exit 1, 519개 중 518 통과·1 실패. [원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-related3.log), 당시 source `48b4847155d0070bbca3596602f8d6bd7084e20322f7dd9f471e6cd34b72e871`.

이번 최종 proof에 선행 실패 native attempt는 기록되지 않았다.

선행 [단순 읽기 offline proof](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json)의 수치와 소스는 역사적 별도 검증이다. 이번 묶음에 더해 총계로 보고하지 않는다. 문맥 반례와 조회 진전 교정 역시 제품 전체 성능 측정이 아니다.

## 남은 범위

다음 필수 단위는 collection 페이지별 전송 후 원응답 보관·known usage 정산과 현재 본문 채택의 분리다. 기존 단순 읽기의 보관 인수와 구분하며 아직 별도 구현·검증이 필요하다. 원문 재검증·조회 비용 개선도 측정과 경합 검증을 거쳐 진행한다.

collection의 응답이 전송 뒤 도착할 때 현재 본문 사용 권한이 철회된 경우, 원응답 보관과 known usage 정산을 분리하는 경계는 이번 complete 복구 인수로 완료됐다고 볼 수 없다. 이미 구현·검증한 단순 읽기 custody와 별개인 collection 페이지별 필수 후속이다. sent 표시는 실제 원격 실행이나 과금 증명이 아니며 알려지지 않은 값을 추정해 채우지 않는다.

원문 전체 재검증·상태 조회는 여전히 비용이 든다. [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md)에 남긴 중복 경로를 현재성 경합과 함께 측정해야 한다. 이번에는 새로운 물리 I/O·지연·처리량·실제 토큰 절감률을 측정하지 않았다. 별도 wait/collection 전체 인수와 실제 외부 서비스 연결을 일반 입구 5사례가 대신하지 않는다.

C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태다. 실제 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이며 native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다. 실제 SIGKILL은 관측한 중단 경계의 증거이며 전원 장애나 모든 파일 시스템의 내구성 보장은 아니다. HTTP 시험은 네이티브 요청 인수이고 브라우저 화면 검증은 별도다.
