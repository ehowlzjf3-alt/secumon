# 범용 롱 호라이즌 런타임

2026-09-08 · checkpoint390 · 기준선 `158b82b`. 복원 뒤 외부 기록 대조를 일반 실행 입구에 연결했다. 파일 복원·담당 신원 재등록이 끝나도 외부 효과 대조 전에는 실행을 재개하지 않는다. 호스트가 등록한 조회 소스들이 복원본에서 사라진 외부 실행·송신·위임·자원 기록까지 확인하고, 같은 복원 고유 번호·신원에 묶인 영수증을 발급한다. 미해결 효과와 임시 게시 중 원자료 변경은 보존하며 별도 회복을 기다린다.

같은 최종 build1에서 대상26개(신규17개·기존 신원 복구9개)·관련 회귀46개, 고유72개 모두 통과했다. 실패·취소·건너뜀0, build1·코어 타입 검사 exit0, 계층200/위반0, 최종2,454파일 대조 일치다. 실제 로컬 외부 파일·CLI/HTTP·SIGKILL 경계의 확인이며 실제 사내 서비스 검증은 아니다. [사용법](../design/chapters/C10-restore-reconciliation-usage.md) · [결과](../design/chapters/C10-restore-reconciliation-result.md) · [체크포인트](evidence/checkpoint390.json) · [다음 작업](../design/NEXT-STEPS.md).

다음은 누락된 외부 원기록과 임시 대조 게시의 변경 자료를 기존 효과 복구로 회복하는 경계다. 이후 C09 취소·목표 변경·일시정지·저널·이력 비용, C05/C06 후속, 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·패키지 효율·운영 배포·최종통합을 이어간다. 전체 C10/goal은 미완료이며 실제 모델/API 시험 중단·외부 서비스 연결0을 유지한다. 메인 프롬프트는 구현·연결돼 있으나 실제 모델 품질은 미검증이다. 활성 빌드·시험은 없고 checkpoint390 커밋·푸시 확인은 이 기록 이후 주 작업이 진행한다.

이전 기록 — checkpoint389. 아래 다음 행동과 검증 수치는 당시 기록이다.

2026-09-08 · checkpoint389 · 기준선 `53019cf`. 쓰기 가능한 저장소를 열기 전에 공통 읽기 전용 형식 검사를 연결했다. 정확한 버전·compact 지원 확인과 기존 SQLite 상태 1/2→3·지식 1→2 이행을 재사용하며, 실제 설치 A/B의 구형 저장 구조 두 시나리오에서 최초 이행과 재열기를 확인했다. 신규 경계9개·통합 시나리오2개·관련109개가 통과했다. Node 집계에는 통합 묶음 상위 항목1개가 추가되며, 전체121개를 최종 소스에서 재실행한 것은 아니다. 최종 build3의 선검사9개·문서 기억8개는17/17, 설치 통합은 build2의 상위 항목 포함3개, 관련109개는 build2의101개와 build3의 문서 기억8개다. build3 exit0·2,433파일 대조 일치, 코어 타입 exit0·계층199/위반0은 안쪽 코어가 바뀌지 않은 build1 기록이다. [사용법](../design/chapters/C10-storage-upgrade-usage.md) · [결과](../design/chapters/C10-storage-upgrade-result.md) · [다음 작업](../design/NEXT-STEPS.md).

다음은 기존 복원 업무·외부 효과 대조 경로를 읽고 백업 복원 후 새 외부 실행 전에 필요한 연결을 확인하는 일이다. C09 취소·목표 변경·일시정지·이력과 C05/C06 후속, 현재 Linux/native Windows·실제 PostgreSQL·사내 연동·운영 배포·최종통합은 남아 있다. 전체 C10/goal은 미완료이고 활성 빌드·시험은 없다. 메인 프롬프트는 구현·호출 연결 상태이며 실제 모델 품질은 미검증이다. 실제 모델/API 시험 중단과 외부 서비스 연결0을 유지한다.

이전 기록 — checkpoint388:

2026-09-08 · checkpoint388. npm/개발 패키지에서 호스트 소유 설치본을 준비하고 그 실제 CLI로 새 담당의 첫 엔진 고정을 연결했다. 같은 원본의 두 담당은 설치본을 재사용하고 각자의 자료를 유지한다. 신규16개는 최종 build3, 관련·확장 기존32개는 build2에서 통과했다. 고유48개를 최종 소스에서 모두 재실행한 것은 아니다. 최종 build3 exit0·2,421파일 대조 일치, 코어 타입 exit0·계층199/위반0은 build2 기록이다. [사용법](../design/chapters/C10-engine-preparation-usage.md) · [결과](../design/chapters/C10-engine-preparation-result.md) · [다음 작업](../design/NEXT-STEPS.md). 메인 프롬프트는 구현·호출 연결 상태이며 실제 모델 품질은 미검증이다. 실제 모델/API 중단을 유지한다.

이전 기록 — 2026-09-08 checkpoint387: 검증된 설치 release의 새 담당을 자동으로 첫 엔진에 고정하고, 초기화 중 종료돼도 원 ID·설치·첫 pin으로 복구한다. 같은 최종 빌드에서 신규20개·관련79개, 합계99개를 통과했다. [사용법](../design/chapters/C10-initial-pin-usage.md) · [결과](../design/chapters/C10-initial-pin-result.md) · [다음 npm/개발 release 준비](../design/chapters/C10-initial-pin-plan.md). 메인 프롬프트는 구현·호출 연결 상태이며 실제 모델 품질은 미검증이다. 실제 모델/API 중단을 유지하고, 이번 Linux/native Windows·실제PG/사내 연동·운영 인수는 남아 있다.

이전 Checkpoint379: C08 반환·활성 배정·접수 중단의 신규5개와 직접 영향 회귀11개를 확인했다. 실제 세션 요약 후 원 배정으로 이어가기, 자진 반환 뒤 새 배정, 실제 SIGKILL 후 원 동료 요청의 명시 재개를 확인했다. 제품 변경 없이 시험을 보완했고, 실제 모델/API·운영 인수와 전체 goal은 미완료다. [현재 결과와 남은 범위](../design/chapters/C08-remaining-boundaries-result.md) · [다음 작업](../design/NEXT-STEPS.md). 아래 이전 단위 수치와 당시 다음 작업은 이력이다. 각 빌드 기록을 최종 한 소스의 전체 재실행으로 합치지 않는다.

<!-- C05-MCP-COLLECTIONS-FINAL-PROOF: 1ef802e5b3473c96de38f364f62815584f8f1206d441a473be8666c1ecb61fd9 -->
**MCP 수집의 일반 입구 재개와 저장 근거 조회**를 연결했다. 같은 담당의 여러 항목 수집을 일반 CLI·Web에 연결했다. 저장된 원응답을 먼저 정산하고 필요한 대화 요약과 문맥 복원을 거친 뒤, 모델이 명시한 완전한 저장 결과의 후속 시도를 로컬에서 소비한다. 새 페이지가 필요하면 연결을 기다리고 명시 온라인 재열기에서 다음 페이지나 실패 항목만 요청한다. **macOS Node24 신규 183/183·관련 519/519, NAS Linux Node24 신규 183/183·관련 519/519·전체 3,691/3,691 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-usage.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-plan.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-linux-nas-20260908/verification.json). 완전한 저장 결과 안내는 실행 허가가 아니다. 원 부모·원문·영수증·현재 계약과 권한을 다시 검사하며 부모의 실패를 성공으로 바꾸지 않는다. 로컬 후속 소비는 논리 도구 호출 한 번이고 원격 전송은 0회다. 필요한 근거 조회와 새 모델 호출은 기존 예산을 따른다. 문맥 선택은 실제 한도에 들어오는 선택 항목 일부를 유지하도록 수렴을 고쳤다. 현재 허용된 원근거의 최초 카드·본문 조회만 준비 진전으로 인정한다. 동일 내용·파생 복사본의 반복 조회는 기본 무진전 한도 3을 초기화하지 않으며 준비 진전은 새 사실이나 목표 완료가 아니다. 다음 필수 단위는 collection 페이지별 전송 후 원응답 보관·known usage 정산과 현재 본문 채택의 분리다. 기존 단순 읽기의 보관 인수와 구분하며 아직 별도 구현·검증이 필요하다. 원문 재검증·조회 비용 개선도 측정과 경합 검증을 거쳐 진행한다. [필수 후속](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-plan.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태다. 실제 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이며 native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.66 단순 읽기의 서버 없는 재개 결과와 당시 다음 계획(아래 미착수 표시는 당시 기록):

<!-- C05-MCP-OFFLINE-FINAL-PROOF: 28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9 -->
**MCP 서버 없는 일반 재개와 명시 온라인 재열기**를 연결했다. 신뢰된 시작 프로그램이 저장 전용 모드를 명시하면 MCP 서버를 시작하거나 발견하지 않고 같은 담당의 저장 응답과 영수증을 검증해 일반 CLI·Web에서 재개한다. 새 읽기가 필요하면 연결을 기다리고, 같은 담당을 온라인으로 다시 열어 기존 목표를 이어 실행한다. **macOS Node24 신규 145/145·관련 847/847, NAS Linux Node24 신규 145/145·관련 847/847·전체 3,601/3,601 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [저장 전용 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-usage.md) · [MCP 호스트 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json). 저장 계약과 새 호출 가능성을 구분하며 원문·현재 권한·목표·출처 검사는 유지한다. raw 파일만 있거나 intent 영수증만 있으면 응답 영수증을 만들거나 재전송하지 않는다. 보관·사용량 정산 성공은 본문 채택이나 업무 완료의 허가가 아니다. 자동 연결 실패 fallback과 모델까지 포함한 무네트워크 실행을 뜻하지 않는다. 다음 후보는 collection(여러 항목 수집)·페이지·대기의 일반 입구 연결이다. 검토 메모를 준비했으며 제품은 미착수다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도 측정·인수한다. [후속 연결 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-notes.md) · [전체 MCP 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.65 보관·정산의 확정 결과와 서버 없는 재개 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):

<!-- C05-MCP-CUSTODY-FINAL-PROOF: 3783a0a1f5ba3a4eea5a9a2231d5def3dbaf44a163c4444b8e559642283e463c -->
**MCP 전송 후 권한 변경의 원응답 보관·사용량 정산**을 연결했다. 허용한 읽기를 보낸 뒤 권한이 바뀌어도, 실제 받은 원응답과 입증된 사용량을 원 담당·원 시도에 보관하고 정산한다. 본문을 지금 보여 주거나 근거로 채택하는 권한은 따로 검사한다. 정상 저장 결과의 수신·채택 또는 거절/정산 → 필요한 compact(긴 대화 정리) → 문맥 체크포인트 복원 → 이후 작업 순서를 유지하며, 일반 run 진입에서 사용량 보완을 한 번의 유한한 과정으로 연결했다. **macOS Node24 신규 121/121·관련 775/775, NAS Linux Node24 신규 121/121·관련 775/775·전체 3,544/3,544 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-plan.md) · [MCP 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json). 보관 원문은 SDK가 해석한 MCP 응답 JSON이다. sent는 로컬 전송 시도 표시이며 원격 실행·성공·과금의 증명이 아니다. 입증되지 않은 측정값은 unknown(null)으로 남긴다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 영수증을 만들어 복구하거나 자동 재전송하지 않는다. 원문·원 영수증·owner·자료 세대를 유지하며 현재 본문 검사를 느슨하게 하지 않는다. 서버를 다시 발견(tools/list)하는 현재 시작 경로는 유지되므로 서버 없는 재개는 아직 아니다. 다음 구현은 MCP 서버 없는 일반 CLI·Web 재개이며 설계 확정·제품 미착수다. 호스트가 명시한 저장 전용 도구에서 기존 보관·본문 검증을 재사용하고, 새 연결이 필요한 작업은 기다리며 다른 독립 작업은 진행하는 경계를 연결한다. 일반 입구의 collection(여러 항목 수집)·페이지·대기 복구와 문맥 조회 비용 개선도 후속이며, 원문·권한의 현재성 검사를 유지한다. [다음 구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [사전 검토 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-notes.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

이전 v0.64 저장 응답 복구의 확정 결과와 권한 경계 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):

<!-- C05-MCP-RECOVERY-FINAL-PROOF: f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960 -->
**단순 MCP 원응답 수신 뒤 중단 복구**를 기존 C01 담당·실행기·정산에 연결했다. 검증된 원응답과 귀속 영수증이 있으면 같은 실행 시도의 수신·채택 또는 거절/정산 → 필요한 compact → 문맥 체크포인트 복원 → 이후 작업 순서로 진행한다. receive는 수신 기록, adopt는 현재 근거 채택이며 compact는 긴 대화를 정리하는 과정이다. 문맥 체크포인트는 다음 추론에 쓸 확인된 문맥의 저장본이며 미수신 결과를 대신 만들지 않는다. **macOS Node24 신규 55/55·관련 421/421, NAS Linux Node24 신규 55/55·관련 421/421·전체 3,423/3,423 통과**. [복구 결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-response-recovery-result.md) · [MCP 연결 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json). 원 실행자와 lease(호출 유효 시간)를 바꾸지 않고 당시 응답 기록과 현재 목표·권한·출처를 검증한다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 복원 불가로 멈추며 자동 재조회하지 않는다. 응답 시각·트랜잭션 준비 시각은 물리 commit 완료 시각이나 재시작 간 단조 시계의 증명이 아니다. 복원에는 추가 tools/call이나 논리 도구 예산을 쓰지 않고 새 답변·compact는 기존 모델 예산을 따른다. 프로필을 다시 열 때 서버 발견(tools/list)은 필요하므로 offline은 아니다. 다음 단위는 도구 요청을 보낸 뒤 권한이 바뀐 경우 원응답·보고된 사용량을 보존하는 경계이며 아직 제품 구현에 착수하지 않았다. 이후 서버 없는 재개, 일반 입구의 페이지·대기 복구를 연결한다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도로 측정·인수한다. [다음 전송 후 권한 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-plan.md) · [전체 MCP 후속 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결과 PostgreSQL의 잔여 구현·검증도 남아 있다.

이전 v0.63 MCP 연결의 확정 결과와 복구 착수 당시 기록(아래 “다음”·미구현 표시는 당시 상태):
<!-- C05-MCP-FINAL-PROOF: c04e4cb45e98716b5c5f003c2609c627711100a4e018cb501c5811708f0e2226 -->
기존 MCP 읽기를 **같은 C01 담당의 보관 포트와 일반 CLI/Web**에 연결했다. 호스트 시작 프로그램이 승인한 실행 설정·도구 계약을 등록하고 기존 계획·도구 실행·원응답·영수증·증거·정산을 사용한다. **macOS Node24 신규 30/30·관련 572/572, NAS Linux Node24 신규 30/30·관련 572/572·전체 3,368/3,368 통과**. [MCP 연결 결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-linux-nas-20260907/verification.json). 저장된 received/완료 결과는 tools/call을 중복하지 않지만, 프로필 재열기에는 서버 발견(tools/list)이 필요하므로 offline 재개는 아니다. 다음 단위는 원응답과 MCP 영수증을 저장한 뒤 실행기의 received 전에 중단된 단순 읽기의 복구로, 착수 예정이며 실행 권한(lease)과 수신 시각 등 세부조건은 검토 중이다. 그 뒤 전송 후 권한 변경·known usage 보존, 서버 없는 재개, 페이지·대기의 일반 입구 연결을 이어간다. 문맥 조회 비용 개선도 남아 있다. [다음 원응답 복구 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-response-recovery-plan.md) · [문맥 조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox, native Windows runtime/file 연결·PostgreSQL·운영 배포는 미검증 또는 후속 구현 항목이다.

이전 v0.62 C05 호스트 연결의 확정 결과와 MCP 착수 당시 기록(아래 “다음”·진행 중 표시는 당시 상태):
<!-- C05-HOST-FINAL-PROOF: 6ff54f755b983c007ab7a541496f64500294086f86b0ac9a21f1445b8ee3ac5f -->
신뢰된 시작 프로그램이 담당별 **읽기 도구·사용자 권한·새 업무 한도**를 일반 CLI/Web에 전달하도록 연결했다. 호스트는 실행 프로그램이며 리드 에이전트를 뜻하지 않는다. 기존 도구 계약·목록·실행·원문·세션·정산을 재사용하고, 정책 축소·종료 시 낡은 결과의 사용과 이미 소비한 자원 기록을 구분한다. **macOS Node24 신규 54/54·관련 356/356, NAS Linux Node24 신규 54/54·관련 356/356·전체 3,338/3,338 통과**. [C05 결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-host-tools-result.md) · [호스트 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-host-tools-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-host-linux-nas-20260907/verification.json). 다음은 기존 MCP 읽기 어댑터를 같은 담당의 보관 포트와 일반 CLI/Web에 연결하는 일이다. 다음 MCP 연결과 문맥 조회 비용 최적화는 아직 구현 완료가 아니다. [MCP 연결 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [문맥 조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md) · [후속 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-after-host-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·usage·취소·tokenizer 적합성, 사내 MCP·Knox, native Windows 연결·PostgreSQL·운영 배포는 미검증 또는 후속 구현 항목이다.

이전 v0.61 C04 목표 변경의 확정 결과와 C05 착수 당시 기록(아래 “다음”·진행 중 표시는 당시 상태):
<!-- C04-GOAL-FINAL-PROOF: 77c47342f9fd89f5593a8eb791d58f3d7eb2d9651c5b90a3610217caf23d19be -->
같은 담당·대화·업무의 **명시 목표 변경**을 일반 CLI/Web에 연결했다. 원문·근거·시도·사용량과 원래 한도를 유지하고, 같은 요청 재전송·새 입력 경합·옛 답변 무효화·compact 뒤 원문 재확인을 검증했다. **macOS Node24 신규 57/57·관련 249/249, NAS Linux Node24 신규 57/57·관련 249/249·전체 3,284/3,284 통과**. 앞선 복합 조사 시험도 이번 Linux 신규·전체 묶음에 포함했다. [목표 변경 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-goal-change-result.md) · [CLI 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-goal-change-cli-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-goal-linux-nas-20260907/verification.json). 실제 브라우저는 호스트 잠금으로 렌더링·클릭을 확인하지 못했고 임시 서버와 담당은 정리했다. [브라우저 시도 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-goal-browser-attempt.json). 다음은 C05에서 호스트가 준비한 읽기 도구와 사용자·정책을 일반 담당 프로필에 연결하는 일이다. 계획은 채택됐고 구현은 아직 시작하지 않았다. [다음 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-host-tools-plan.md). 실제 모델/API 시험은 중단 상태다. 실제 모델의 의미 판단·usage·취소·tokenizer 적합성과 native Windows runtime/file 연결·PostgreSQL·사내 연동·C08 독립 반론 협업은 남아 있다. C04 전체와 전체 goal은 미완료다.

이전 v0.60 복합 조사 로컬 인수 당시의 기록(아래 “미실행”과 “다음”도 당시 상태): 일반 요청의 복합 조사 인수에서 macOS Node24 신규 **2/2**·관련 **43/43**을 통과했다. 초기 자료에 반증이 들어오면 가설을 다시 평가하고 필요한 판별 자료만 추가 조회했다. 판별 자료가 실패하면 원본·충돌·사용량을 보존한 채 질문 대기로 남는다. 기존 등록 모델·계획 검사·도구 실행·정산을 재사용했으며 이번 단위는 제품 코어 변경 없이 통합 시험을 추가했다. [복합 조사 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-complex-turn-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-complex-verification.json). 새 복합 시험의 Linux 검증은 **미실행**이며 다음 목표 변경 제품 연결 후 필수 통합에 포함한다. 아래 등록 모델의 NAS 3,253개 통과는 당시 소스의 기록이다. 다음은 [명시 목표 변경](/Users/seunghanee/Documents/secumon/design/chapters/C04-goal-change-plan.md)이다. 합성 전송으로 계약을 확인했으며 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.

이전 C04 등록 모델 연결 당시의 검증 기록(아래의 “다음”도 당시 계획): 담당 설정에 저장한 모델 등록 이름을 CLI·Web의 같은 일반 요청 입구에 연결했다. 주턴과 compact는 기존 호출 예약·정산·복구를 사용하며, 기본 등록 예제는 네트워크 없는 구조화 전송 대역이다. macOS Node24 신규 **44/44**·관련 **245/245**, NAS Linux Node24 신규 **44/44**·관련 **245/245**·전체 **3,253/3,253**을 같은 소스로 통과했다. [등록 모델 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-registered-model-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-registered-model-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-registered-linux-nas-20260907/verification.json). 다음은 [일반 입구의 복합 가설·반증·부분 재계획](/Users/seunghanee/Documents/secumon/design/chapters/C04-complex-turn-plan.md)이며 [잔여 검토](/Users/seunghanee/Documents/secumon/design/chapters/C04-after-registration-review.md)의 명시 목표 변경도 남는다. 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.

이전 C04 문맥 창 검증 기록: 모델 입력·출력·총 문맥 창을 구분하고, 필수 상태와 현재 원문이 들어가는지 먼저 확인한 뒤 과거 대화 compact를 연결했다. 같은 준비 결과를 재사용하며 실제 요청은 게시 후 다시 측정한다. macOS Node24 신규 **71/71**·관련 **704/704**, NAS Linux Node24 전체 **3,209/3,209**을 같은 소스로 통과했다. [C04 문맥 창 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-window-linux-nas-20260907/verification.json). 다음은 [등록된 모델 프로필과 일반 입구 연결 검토](/Users/seunghanee/Documents/secumon/design/chapters/C04-after-window-review.md)다. 실제 모델/API 시험은 중단 상태이며 C04 전체·Windows·PostgreSQL·사내 연동과 전체 goal은 미완료다.

이전 C04 첫 흐름의 검증 기록: 2026-09-07 일반 요청 → 주 모델 턴 → 직접 답변·질문·검증된 계획 → 기존 도구 실행 → 응답 검토·전달을 연결했다. 작업이 끝나도 같은 세션의 원문·요약을 다음 요청에 사용한다. 같은 소스에서 macOS 신규 **100/100**·관련 **636/636**, NAS 실제 Linux/Node24 전체 **3,138/3,138**을 통과했다. [C04 첫 흐름 결과](/Users/seunghanee/Documents/secumon/design/chapters/C04-general-turn-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C04-turn-linux-nas-20260907/verification.json) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C04-general-turn-usage.md). 다음은 [모델 입력 한도와 compact 조정](/Users/seunghanee/Documents/secumon/design/chapters/C04-context-window-plan.md)이다. 합성 모델로 계약을 확인했으며 실제 모델/API 시험은 중단 상태다. C04 전체·Windows·PostgreSQL·사내 연동 및 전체 goal의 남은 범위는 유지한다.

이전 검증 단위: 2026-09-07 반복 compact를 기존 모델 호출·정산·복구와 연결했다. 같은 세션의 원문을 보존하며 앞부분 요약과 최근 입력을 조합하고, 작업 완료 뒤에도 문맥을 이어간다. NAS 실제 Linux/Node24에서 **전체 2,836/2,836**, 신규 compact **46/46**을 통과했다. [반복 compact 결과](/Users/seunghanee/Documents/secumon/design/chapters/C02-session-compact-result.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C02-compact-verification.json). 첫 Linux 초기화 경합 실패는 고정 재현·최소 수정하고 원로그를 보존했다. 이 검증 이후 C03 개인 기억 흐름을 진행했다. 실제 모델/API 시험은 재개하지 않았으며 C01/C02 전체 및 전체 goal은 진행 상태를 유지한다.

아래 P0~P6 설명의 시험 수치와 “다음” 작업은 당시의 기록이다. 현재 결과와 C04 후속은 문서 맨 위와 통합 계획을 따른다.

이전 [역할 간 자원 배정·정산 결과](/Users/seunghanee/Documents/secumon/design/chapters/P4-budget-authority-result.md)에서 별도 자료 권한을 가진 역할에 자원을 배정하고, 해당 역할 runtime으로 중단·사용량 정산·미사용 반환을 연결했다. 권한 철회·응답 유실·하위 위임·compact/reopen을 검증했다. 전체 **2416/2416**, 관련 **168/168**, 신규 **62개**가 통과했다. **P4-01은 진행 중**이며 다음은 [게시판 수락과 에이전트 자원 관리 연결](/Users/seunghanee/Documents/secumon/design/chapters/P4-board-funding-plan.md)이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P4-board-budget-authority-local-verification.json).

이전 [MCP 단발 읽기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-adapter-result.md)에서 공식 SDK의 실제 로컬 stdio 서버를 기존 도구·호출 장부·원본 proof에 연결했다. 전체 **1,992/1,992·실패/취소0**, 신규42개·관련58개가 통과했다. 문서/관측×두 저장소의 원본·근거 채택, 정책 변경·취소·목록 변경·크기/동시성 제한·명시 재연결과 저장 결과 재검증을 확인했다. SDK client/server2.0.0 추가는 의도한 lock 변경이며 기존 원본과 정본을 보존한다. P3-01은 부분 검증/진행 중이다. 다음은 MCP batch/page와 ReadCollections의 cursor·부분 결과·명시 재개 연결이다. 실제 사내 MCP·모델·Knox·운영 검증은 아니다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-local-verification.json).

이전 [로컬 Web driver 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-local-web-driver-result.md)에서 기존 실행·증거·이어가기 코어를 실제 계측 HTML 앱과 Chrome에 연결했다. 전체 **1,950개 시험·실패/취소0**, 신규·관련20개, 별도 실제 browser **17/17**이 통과했다. 두 저장소의 같은 목표8셀 모두 입력2·저장1로 완료했고 개별 도구3회→batch2회, Web bridge13→10회를 관측했다. 저장후 응답 유실의 정산·입력 없는 verify, reload·앱 재열기와 사람의 연속 입력·브라우저 fill도 검증했다. 1280/390/320px 화면 검수와 소유 서버/브라우저 종료를 확인했다. DOM 자동화이며 native OS·사내 화면·모델/API 검증은 아니다. P3-04는 부분 검증/진행 중이고 다음 로컬 챕터는 P3-01 MCP 재사용 adapter다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-local-web-driver-local-verification.json).

이전 [실제 이어가기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-runner-result.md)에서 v2 checkpoint와 실제 continue/verify를 연결했다. 원 입력의 기한·누적 한도를 유지하고 부모당 하나의 후속 작업만 예약하며, 적용된 입력은 반복하지 않는다. 현재 조건을 새로 확인하는 verify는 입력 0회다. 전체 **1,930개 시험·실패 0**, 신규 77개·최종 관련 143개, 코어 타입 검사·안쪽 계층 98파일/위반 0·합성 4시나리오/22판정이 통과했다. 실제 SIGKILL 복구 6개와 정산 후 진행 장부 갱신·중복 credit 방지도 검증했다. P3-04는 부분 검증/진행 중이며 실제 GUI·모델/API·사내 서비스는 미실행이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-runner-local-verification.json).

이전 [후속 작업 계약·근거 소비 학습 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-boundary-result.md)에서 부모당 단일 후속 claim과 CAS 계약, compact/reopen의 원본 참조 보존, 자료·공개·기억·전송의 효과 증명 검사를 연결했다. 실패 처리된 과거 증명도 검사하고, 원 업무가 소비한 기억의 개정·철회를 유한한 원출처 원장으로 재검증한다. 전체 **1,853개 시험·실패 0**, 신규 82개·최종 관련 197개, 코어 타입 검사·안쪽 계층 97파일/위반 0·합성 4시나리오/22판정이 통과했다. 실제 continue/verify 도구와 v2 runner는 미지원이며 해당 실행을 명시 거절한다. P3-04는 partially_verified/in_progress, 전체 완료 작업은 9개다. 다음은 원 시간·누적 시도 한도를 보존하는 v2 checkpoint와 실제 단일 successor 실행이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-boundary-local-verification.json). 실제 모델/API 시험은 중단 상태다.

새 제품 구현 작업 공간이다. 전체 범위/순서는 [통합 계획](/Users/seunghanee/Documents/secumon/design/03-migration-plan.md), 실제 작업 상태는 [작업 목록](/Users/seunghanee/Documents/secumon/design/implementation-backlog.json)을 따른다.

현재 P0와 P1-01~05를 구현했고, P1-06/07의 모델 호출 장부·가설/계획 변경과 상태 기반 재개/전체 workflow를 로컬 검증했다. P2-01에서는 SQLite와 파일 저널에 같은 저장 계약과 업무·강제 종료 흐름을 적용했다. P2-02는 근거 수명·개인/공유 기억·검색·작업 파일, P2-03은 반복 compact·선택 재조회·복사 출처·재시작 계약 검사를 연결했다. P2-04 첫 단위는 저장 결과 재사용·합류·도구 목록 갱신·실제 구현 호출 장부다. 이어서 지침 수명·현재 원본 검사·순수 batch/page 계약을 연결했다. 영속 조회 runner·checkpoint·명시 재개·원응답 검증을 연결했고 증분 checkpoint 저장과 제한된 복원/조회 공유까지 연결했다. P2-04 로컬 계약 검증 뒤 P2-05의 별도 실행 모드·변경·진전/재시도·CLI 연결을 구현했다. 이어서 부모/자식 예산의 전액 보류·실제 할당/진입 검사·영속 차단·사용량 정산을 연결했다. P2-05에서는 두 업무군·두 저장소·세 모드의 고정 194개 실행과 194개 기록 재생을 검증했다. P2-06 당시 로컬 검증은 1,388개 시험 통과이며 정보 공개 계약·공개 뷰·workflow 거절/복구 시험 110개를 추가했다. 두 업무군·두 저장소의 A/B/C 전송 계약 12개 비교도 통과했다. P1-06/07과 종속 P2 작업에는 실제 모델 조건이 남아 있고 전체 에이전트나 실제 모델·MCP·Knox가 완성된 상태는 아니다.

이전 [합성 컴퓨터 유즈 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-use-result.md)에서 관찰·입력·조건 확인과 영속 진행, 결과 증명·compact 원본 검사·강제 종료 복구를 연결했다. 전체 **1,630개 시험·실패 0**, 코어 타입 검사·안쪽 계층 90파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 94개이며 두 저장소의 동일 목표 4개 비용 관측도 통과했다. P3-04 local_contracts는 partially_verified, 전체 status는 in_progress다. 다음은 명시적 효과 대조와 남은 단계 이어가기이며 실제 로컬 Web driver와 선택 환경 검증은 그 뒤에 연결한다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-use-local-verification.json). 실제 모델/API 시험 중단과 이전 원본/검증 기록 보존을 유지한다.

이전 [입력 영수증 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-receipts-result.md)에서 합성 앱과 원자 저장하는 operation 영수증, 현재 권한의 읽기 조회, v1 이행·재시작·저장 실패 처리를 연결했다. 전체 **1,656개 시험·실패 0**, 코어 타입 검사·안쪽 계층 92파일/위반 0·합성 4시나리오/22판정이 통과했다. 새 시험은 26개이고 최종 관련 시험은 120개다. P3-04는 partially_verified/in_progress이며 전체 완료 작업은 9개다. 다음은 명시 런타임 효과 대조 예약·정산, 이후 남은 단계 이어가기와 실제 로컬 Web driver다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-computer-receipts-local-verification.json). 실제 모델/API 시험은 중단 상태다.

이전 [명시 런타임 대조 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-runtime-reconciliation-result.md)에서 저장된 입력 영수증을 별도 읽기 예약·실행·정산에 연결했다. 원 입력과 결과를 보존하고, 증명이 사라지면 실행·모델·완료·압축·화면·전달 경계에서 다시 차단한다. 전체 **1,771개 시험·실패 0**, 코어 타입 검사·안쪽 계층 96파일/위반 0·합성 4시나리오/22판정이 통과했다. 신규·최종 관련 시험은 115개다. P3-04는 partially_verified/in_progress이며 전체 완료 작업은 9개다. 다음은 단일 successor의 남은 단계 이어가기와 현재 사후 조건 확인이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-runtime-reconciliation-local-verification.json). 실제 모델/API 시험은 중단 상태다.

기존 사실 조건 예제의 목표 변경 CLI는 `change-goal <work-id> --file <goal.json> --goal-revision N --control-revision M`처럼 두 revision을 명시해야 한다. Web은 편집 시점의 두 값을 제출한다. 필드 없는 이전 요청은 거절하고, 같은 요청 재확인은 ID와 본문을 그대로 보낸다. Web 목록 cursor는 인스턴스당 128개/15분이며 만료·서버 재시작 후 목록을 갱신한다. 빈 페이지에도 다음 cursor가 있을 수 있다.

## 실행

Node.js **24.20.0**을 사용한다. `.nvmrc` 및 package-lock.json에 버전을 고정했다. 현재 작업 폴더에는 공식 배포본과 SHA256을 확인한 Node가 `.tools/node-v24.20.0-darwin-arm64/`에 있다. 시스템 기본 Node와 별도로 설치했다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm ci --ignore-scripts
npm run verify
```

다른 호스트는 `.nvmrc`와 맞는 Node를 설치하고 같은 npm 명령을 사용한다. 위 경로는 현재 macOS arm64 전용이다. 검증은 빌드 → 로컬 시험 → 코어 별도 타입 검사 → 계층 의존성 검사 → fixture 판정으로 진행한다. 시험용 저장소는 OS 임시 폴더에 만들고 종료 시 정리한다. 실제 모델/사내 시스템 접속은 없다.

## 읽는 순서

1. [P0 학습·검증 기록](/Users/seunghanee/Documents/secumon/design/chapters/P0-result.md): 무엇이 완료와 근거를 구분하는가.
2. `fixtures/`: 단순/복잡 문서 비교와 관측 검토, 22개 판정 checkpoint.
3. `src/domain/model.ts`, `completion.ts`: 저장소/모델/채널 없이 동작하는 계약과 판정 규칙.
4. `src/application/ports.ts`, `contracts.ts`: 바깥 구현의 교체 경계와 실행 시 입력 검증.
5. `src/infrastructure/sqlite-state.ts`, `file-journal-state.ts`, `src/tests/state-conformance.test.ts`: 두 영속 구현의 공통 저장 경계와 실제 강제 종료·동시성 시험.

6. [P1-03 학습·검증 기록](/Users/seunghanee/Documents/secumon/design/chapters/P1-execution-result.md): 계획·시도·수신·수락·제어의 차이와 실패 사례.

`evidence/fixture-baseline.json`은 조건/참조와 checkpoint의 실제 제어 판정 결과다. P0 당시에는 기대값만 있었던 `expectedControl`을 P1-03에서 `decide()`와 연결했다. 별도 실행 시험은 도구·SQLite·원본 저장까지 연결한다. 모델 추론 성능·업무 성공률·운영 성능으로 해석하지 않는다.

API 키 연결 실험은 사용자 요청으로 종료했다. 이 제품은 비밀을 과거 프로젝트에서 자동 탐색하거나 종료한 실험의 키를 읽지 않는다.

[P1-04 학습·검증 기록](/Users/seunghanee/Documents/secumon/design/chapters/P1-resources-result.md)에서 도구 카드/명세, 과거 결과/현재 근거, 방법/지침/권한을 구분하는 예제를 읽을 수 있다.

[P1-05 학습·검증 기록](/Users/seunghanee/Documents/secumon/design/chapters/P1-conversation-result.md)에는 CLI 실습과 접수·분석/답변 준비·전달·완료의 차이가 있다. 빌드 후 `node dist/presentation/cli.js demo`로 합성 예제를 실행한다. 기본 저장 위치는 `.data/cli`이며 `--data-dir`로 바꿀 수 있다. 상주 worker와 실제 모델 연결은 없고, 저장한 업무는 `run <work-id>`로 이어 실행한다.

[P1-06 로컬 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P1-model-result.md)에서는 모델 제안의 수락과 비용 정산, 가설 평가와 작업 그래프 변경을 구분한다. `composeRuntime`에 identity가 있는 planner를 주입하면 `planning.runUntilYield(workId)`를 사용할 수 있다. 기본 CLI demo는 합성 명시 계획을 유지하며 모델/키를 자동 연결하지 않는다.

[P1-07 로컬 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P1-recovery-result.md)에는 상태/원본/파생 패킷의 구분과 9개 실제 SIGKILL 시험 결과가 있다. `composeRuntime`의 `workflow.run(workId, actor)`는 시작 복원과 종료 checkpoint를 포함한다. CLI `checkpoint <work-id> --json`으로 참조를 저장하고 `run <work-id> --resume-file <file>`로 비교 재개할 수 있다. 기본 CLI는 명시 합성 계획이며 scoped actor 실행·자동 상주 worker·수동 compact 명령은 지원하지 않는다.

[P2-01 로컬 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-storage-result.md)는 두 저장소의 공통 계약, 8개 전체 업무 흐름과 18개 업무 SIGKILL 시험을 다룬다. CLI에 `--state-backend file-journal --data-dir .data/journal-lesson`을 주면 새 폴더의 업무 저장소를 선택한다. 기본은 SQLite이며 이후 같은 폴더는 `profile.json`의 선택을 유지한다. 다른 backend로 조용히 전환하거나 자료를 이행하지 않는다. StateRepository를 교체한 것이며 로컬 채널은 계속 SQLite다. 파일 저널은 로컬 POSIX 적합성 실험으로, 전원 차단·공유 파일 시스템·운영 처리량은 미검증이다.

[P2-02 로컬 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-memory-result.md)는 출처가 바뀔 때 기억·복사본·준비 답변·파일 접근을 함께 검사하는 과정을 다룬다. `composeRuntime`의 선택적 `knowledge`/`workspaceFiles` 포트로 서비스를 주입한다. 로컬 프로필은 합성 주체와 `local` namespace에 한정해 `knowledge.sqlite`·`workspaces`를 열고, `core.memory.get/search`를 제공한다. 기억 본문과 내부 출처 참조를 분리하며 파생 자료의 물리 삭제와 전역 트랜잭션 보장은 별도다. 

[P2-03 로컬 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-context-result.md)는 정본과 모델 working set, 필수 정보와 참조/퇴거, 실제 request bytes와 token 추정을 구분한다. `composeRuntime`의 `context.prepare()`는 검증된 후보를 저장하고 PlanningRuntime이 같은 revision에서 head와 호출 예약을 게시한다. 지침 규칙과 현재 계약을 유지하며 조회된 복사본도 원출처 권한을 확인한다. 후속 P2-04 도구·지침 호출 효율은 아래 단위로 이어진다.

[P2-04 첫 단위 학습·진행](/Users/seunghanee/Documents/secumon/design/chapters/P2-efficiency-progress.md)은 같은 원 관측의 재사용과 실제 호출, 진행 실행 합류를 구분한다. 기본 read에는 캐시를 허용하지 않는다. 검토된 도구의 `definition.reuse`와 현재 원본이 유효할 때만 재사용하고 task의 `freshness: fresh`는 새 호출을 요구한다. `executionJoin.execute(workId, attemptId, signal)`로 들어온 caller들의 대기를 공유하며 사람의 권한 검사는 별도다. `core.catalog.search`에 maxBytes와 반환된 cursor를 주면 현재 snapshot의 다음 카드를 찾을 수 있다. 후속 [지침·조회 계약 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-guidance-collections-result.md)에서 지침 수명과 순수 조회 계약을 다룬다. core.guidance.find도 maxBytes/cursor로 페이지를 조회하며 본문은 별도 load로 선택한다. [영속 조회 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-durable-collections-result.md)에서는 composeRuntime의 collectionTools에 읽기 제공자를 등록하고, 새 task.readResume에 parent attempt/checkpoint ID를 넣어 명시 재개한다. 호출 intent와 원응답/진행 지점을 저장하고 두 backend에서 중단 후 이어가기를 확인했다. [증분 저장·내부 I/O 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-internal-io-result.md)에서 v2 변경 기록 저장·v1 논리 복원·현재 원본 재검사와 한정된 파싱/dispatch 공유를 다룬다. 파일 API/본문/hash bytes를 분리해서 측정하며 기존 v1 checkpoint도 읽고 이어간다.

[모드·진전·재시도 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-modes-result.md)는 auto/fast/deep, 실행 중 모드 변경, 같은 의미의 반복 제어와 저장된 retry 시각을 다룬다. CLI accept/demo의 `--mode`로 최초 모드를 지정하고, `mode <work-id> --mode deep --control-revision <현재 제어 revision> --goal-revision <현재 목표 revision> --reason <이유>`로 변경을 요청한다. status/snapshot에서 현재 모드·대기 변경·예산·재시도 시각을 확인한다. 모드 변경은 사용량/기한을 초기화하지 않으며 fast 상한과 진전 임계값은 로컬 평가 정책이다.


## 고정 실행 평가와 기록 재생

[전체 실행 평가 결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-evaluation-result.md)에서 완료 기준·가설·부분 결과·권한 철회·중단/재개·compact·전달 불명의 실제 상태 흐름을 읽을 수 있다. `npm run build`는 소스와 dist의 대응 hash를 저장한다. 아래 명령은 새 출력 폴더를 요구하고 실제 모델/사내 서비스를 호출하지 않는다.

```sh
npm run build
npm run evaluate -- run --out evidence/evaluation-lesson --variant simple
npm run evaluate -- replay evidence/evaluation-lesson/documents-simple.sqlite.auto.simple
```

`--variant`를 생략하면 194개 전체 조합을 실행한다. 기록 재생은 workflow를 다시 실행하지 않는다. 소스·빌드·case/oracle·권한·원본이 달라지면 재생 불가를 반환하며, 과거 코드의 재현은 그때 고정한 코드와 자료가 필요하다. 상태 저장 backend만 교체하며 로컬 시험 채널은 두 경우 모두 SQLite다.

[최종 비교 JSON](/Users/seunghanee/Documents/secumon/runtime/evidence/evaluation-final/report.json) · [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-evaluation-local-verification.json)

## 목적지별 정보 공개

[정보 경계 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P2-boundary-result.md)에서 읽기와 전송 권한, compact 뒤 분류 보존, 공개 뷰의 원자료/파생 관계를 설명한다. 새 업무의 Policy.disclosure에 목적지·표면·허용 등급과 공개 횟수/byte 한도를 명시한다. 기존 분류 이력이 없는 업무에 정책만 붙이는 자동 전환은 거절한다. 정책 없는 기존 합성 프로필은 강화된 정보 경계를 보장하지 않는다.

composeRuntime의 disclosureRules는 신뢰된 배치 설정이다. disclosure.release/read가 만드는 view의 payload만 공개 대상이며 id·destination은 내부 제어 정보다. 각 실제 전송/재시도는 dispatchReleased의 현재 원본/정책 검사 안에서 receiver에 진입해야 한다. 이 훅은 기존 모델/도구/채널의 호출/전달 장부를 대체하지 않는다.

빌드 후 `npm run compare:disclosure -- run --out evidence/disclosure-lesson`으로 새 디렉터리에서 12개 합성 비교를 실행한다. [고정 비교](/Users/seunghanee/Documents/secumon/runtime/evidence/disclosure-final/report.json) · [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-boundary-local-verification.json). 실제 모델·운영 adapter·전체 다중 역할 workflow와 배치 격리 검증은 별도다. 이후 P3-02 공통 조회/CLI 첫 단위를 진행했다.

## 공통 공개 업무 조회

빌드 후 `node dist/presentation/cli.js work-view <work-id> --json`으로 등록된 기본 대화의 현재 공개 상태를 읽는다. `--conversation`으로 이미 연결된 다른 대화를 선택하고 `--level details|diagnostics`로 상세/진단을 명시한다. 이전 출력의 cursor를 `--cursor`로 넘기면 같은 공개 내용에는 unchanged를 반환한다. 오래된 cursor는 최신 snapshot을 받으며 실행이나 전송을 재개하지 않는다.

composeRuntime.workView는 등록 경로·주체·현재 읽기/공개 정책·원자료·기억·가설 평가를 검사한다. 진단은 신뢰된 allowDiagnostics와 log 공개 정책을 모두 요구한다. 주 답변 경로를 변경하지 않고 pending/unknown/delivered를 구분한다. 원문 bytes·도구 input/output·모델 context는 이 화면에 포함하지 않는다. 기존 status/messages/events는 로컬 진단/이력의 계약을 유지하며 Web의 공개 API로 사용하지 않는다.

[첫 단위 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-work-view-plan.md) · [실습과 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-work-view-result.md) · [당시 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-work-view-local-verification.json). 이후 로컬 HTTP/Web과 갱신·접속 상한을 연결했고, 이번 단위에서 최근 사건 metadata 조회와 후보 페이지를 검증했다. 기본 profile은 고정 합성 사용자이며 조직 인증과 실제 Knox는 아직 연결하지 않았다. 현재 조회 비용과 제한은 [조회 효율 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-result.md)를 따른다.

## 로컬 Web 작업실

합성 예제용 화면이다. 실제 모델을 연결하지 않았으며 제목/질문 답변을 범용 자연어 계획으로 해석하지 않는다. 기존 설치를 사용해 다음처럼 실행한다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
node dist/presentation/web.js --data-dir .data/web-learning --state-backend sqlite
```

터미널의 최초 연결 URL을 연다. 서버는 127.0.0.1만 수신하며 일회 토큰을 세션으로 교환한다. 새 저장 폴더에서는 `--state-backend file-journal`도 사용할 수 있다. 기존 폴더의 backend를 바꾸지 않는다. 새로고침은 실행하지 않고, 서버 종료 후 저장 업무는 새 명시 실행으로 재개한다. 검수용 서버는 종료했다.

브라우저의 로컬 저장 확인은 사람의 읽음이나 실제 Knox 전달 확인이 아니다. 코드/두 저장소/브라우저 범위와 제약은 [Web 결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-web-result.md)를 따른다. HTTP 시험은 loopback 수신 권한이 필요하며, 제한된 sandbox에서 EPERM은 통과로 세지 않는다.


## 합성 컴퓨터 유즈 첫 단위

[학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-computer-use-result.md)를 따라 관찰·입력 의도·적용 여부·조건 확인·결과 채택을 구분한다. composeRuntime의 선택적 computerTools에 신뢰된 binding을 등록하면 observe/act가 기존 도구·저장·권한·예산·취소 경로를 사용한다. 기본 CLI/Web 프로필은 이 도구를 자동 등록하지 않는다.

빌드 후 `node --test dist/tests/computer-use.test.js dist/tests/computer-use-recovery.test.js`로 두 저장소의 합성 입력·강제 종료 복구를 확인한다. `node evidence/P3-computer-use-cost.mjs "$PWD" P3-computer-use-lesson`은 새 이름으로 같은 저장 업무의 묶음/개별 호출을 비교한다. 기존 기록이 있으면 다른 stem을 명시한다. 실제 브라우저/OS·MCP·모델을 호출하지 않는다.

현재 unknown 효과는 읽기 진단으로 자동 해소하거나 재입력하지 않는다. 명시 효과 대조/남은 단계 이어가기와 실제 로컬 Web driver는 다음 단위다. 합성 파일은 앱 내용·입력 수만 영속화하며 다중 프로세스 전역 UI lease를 보장하지 않는다.

## 명시 컴퓨터 효과 대조

composeRuntime.computerReconciliations는 호스트가 명시 source attempt/head와 command ID로 요청하는 별도 읽기 서비스다. reserve→execute→settle를 각각 호출하거나 reconcile로 연결한다. 원 입력을 재실행하지 않으며 동일 명령을 다시 보내도 이미 dispatch한 조회는 재호출하지 않는다. 제때 저장된 응답은 남은 work 권한 안에서 재시작 뒤 정산할 수 있다. 입력 영수증은 현재 화면의 조건이나 업무 완료 Evidence가 아니므로 남은 단계와 조건 확인은 후속이다. CLI/Web 모델 도구에 이 서비스를 자동 노출하지 않았다. [API 실습과 한계](/Users/seunghanee/Documents/secumon/design/chapters/P3-runtime-reconciliation-result.md)

## 로컬 Web 컴퓨터 유즈 실습

`npm run computer:fixture`가 실제 HTML 폼의 localhost URL을 출력하며 Ctrl+C로 종료한다. `SECUMON_FIXTURE_STATE_FILE`을 지정하면 앱/영수증 파일을 유지한다.

`SECUMON_PLAYWRIGHT_MODULE`에 host 설치 Playwright entry를, `SECUMON_BROWSER_CHANNEL=chrome`을 지정한 뒤 `npm run verify:computer-web`으로 별도 실제 browser gate를 실행한다. 기본 `npm run verify`와 분모를 구분하고 browser를 자동 설치하지 않는다. [실습과 해석](/Users/seunghanee/Documents/secumon/design/chapters/P3-local-web-driver-result.md).
