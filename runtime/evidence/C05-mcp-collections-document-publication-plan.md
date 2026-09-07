# C05 collection 최종 증거 뒤 문서 갱신 계획

이 파일은 **갱신 항목과 사실 범위를 정리한 준비 문서**다. design·HTML·backlog·기존 증거를 변경하지 않았고 updater·빌드·시험·SSH를 실행하지 않았다. 읽은 시점에 `C05-mcp-collections-linux-nas-20260908/verification.json`은 없었다. 아래 native 성공 문장은 실제 최종 proof가 생성·검증된 뒤에만 사용할 수 있다.

## 지금 확인한 로컬 사실

[최종 로컬 기록](C05-mcp-collections-local-final1.json)의 상태는 `local_selected_integration_passed_native_pending`이며 SHA256은 `56089e7f9a78c42212bcfceb546ea18cbffe2f1a5e16b47910c9cd148f55f003`이다. build12/new9/related4/core4/architecture4가 실제 exit0으로 선택됐고, 신규 14파일 **183/183**, 관련 38파일 **519/519**다. 고정 source는 `33c45f6df85a16f8d43e0b90e9032ff332183ebc91674f63b7993146cb10fdfe`, build files digest는 `ff68adcf59f9cb3824eb0df7fd20b86093c17a478cfeedd42f45216b2f50c938`, compiled 파일 수는 1800이다. 이 기록과 최종 native proof의 pin이 다르면 현재 로컬 수치를 새 pin의 통과로 옮기지 않는다.

[new9 원로그](C05-mcp-collections-new9.log) SHA `3afef4eca4c524cf9e470c0154c024353e7778295174874350614ace6b83e782`, [related4 원로그](C05-mcp-collections-related4.log) SHA `c04e12a6e9dd43bb336e4436a2f3f1dc0d038779d076933d6756fddec97e2284`를 읽었다. 최종 count는 원로그/alias/proof에서 다시 읽어야 하며 이 메모의 숫자를 updater 상수로 쓰지 않는다. 중간 new2 41개, 이전 offline 145/847/3601은 별도 소스의 역사이며 합산하지 않는다.

## 결과에 쓸 사용자 흐름과 정확한 한계

1. **collection 일반 입구 연결.** 같은 C01 담당의 기존 state/artifacts/계약/실행기를 사용한다. online mixed plain+collection 등록은 한 endpoint의 발견을 공유하고, 명시 `stored_only`에서는 peer 생성·발견·호출 없이 현재 원응답/영수증을 검증한다. 과거 파일에서 도구 계약을 추측하거나 자동 online fallback을 하지 않는다.
2. **복구·명시 후속 시도·답변.** collection 저장 정산을 필요한 compact와 첫 문맥 복원보다 먼저 처리한다. 완전 checkpoint의 원 부모 failed/owner/원문은 보존한다. 모델이 실제 packet의 `stored_complete` 안내를 보고 기존 `readResume` 후속 계획을 명시하면, 현재 부모/head/query/계약/권한/원문을 다시 검사한 로컬 소비로 정상 receive/adopt에 연결한다. annotation은 실행권한이 아니다. 기존 TaskSpec.readResume와 저장 상태 schema를 유지하며 새 permit 장부를 만들지 않는다. 로컬 후속 소비는 **논리 toolCalls +1 / 원격 fetch0**이고 이후 core.evidence 조회는 별도 논리 호출이다.
3. **실제 일반 입구 인수는 CLI2·HTTP3.** [entry 소스](../src/tests/mcp-collection-entry.test.ts)와 new9의 실제 성공 이름을 대조했다. SQLite/file-journal CLI2는 실제 SIGKILL 후 peer 없는 새 CLI 프로세스에서 실제 session compact → 명시 complete successor → 모델 입력에 공개된 ID를 통한 저장 근거 조회 → 최종 현재 근거 답변까지 확인한다. SQLite/file-journal HTTP2는 비최종 페이지 응답 뒤 SIGKILL → 반복 offline 연결 대기 → 명시 online 재열기 → 원 snapshot/cursor의 **다음 페이지 한 번**을 확인한다. SQLite HTTP1은 **정상 채택된 partial batch**를 유지하며 online에서 실패 항목만 재시도한다. 마지막 사례를 SIGKILL이나 file-journal 검증으로 확대하지 않는다. HTTP는 localhost 프로토콜 인수이며 실제 브라우저 렌더링 검증이 아니다. 반복 명령/재접속의 원문·시도·정산·대화 중복 없음도 해당 fixture 범위에서 확인한다.
4. **문맥 선택 수렴 보완.** [ContextCompiler](../src/application/context-compiler.ts)의 inspect/prepare가 다음 선택 예산을 줄일 때 실제 선택 비용을 상한으로 삼는다. 사용하지 않은 큰 byte 예산 때문에 같은 선택을 반복하다 최소 정보만 남기거나 실패하던 반례에서, 실제 추정상 들어가는 선택 항목 일부를 유지한다. 필수 정보 보호·6회 선택 상한·최종 full request 한도/현재성 검사는 그대로다. 전역 최적 packing이나 일반 성능 개선, 실제 tokenizer 정확도를 입증한 것은 아니다.
5. **저장 근거 조회의 준비 진전.** [acceptedToolProgressKeys](../src/application/work-progress.ts)는 정상 검증·채택된 `core.evidence.find/get`의 현재 허용된 **원근거** 카드/본문을 정확히 대조해 최초 준비 진전 키를 만든다. find 후 최초 get은 별도 준비 진전이고 get은 card/body를 함께 기록한다. 동일 내용의 재조회, 조회 문구·크기·표시 ID/시각 변경, 파생 복사본은 반복 제한을 초기화하지 않는다. 기본 무진전 한도3, 실행 예산·목표·완료 조건·권한은 유지하며 새 관측이나 새 evidence를 생성하지 않는다. partial find의 정확한 반환 카드는 가능하지만 부분/too_large get·거절·위조·미채택·reuse·원문 raw 조회는 이 새 준비 진전 대상이 아니다. 파생 근거를 조회하거나 답변에 사용하는 기능 자체를 금지한 것도 아니다.

**다음 별도 단위는 collection 페이지별 전송 후 보관·정산이다.** 기존 plain-read post-send custody의 완료를 취소하거나 collection까지 이미 완료됐다고 쓰지 않는다. [collection fetch](../src/infrastructure/mcp-read-collections.ts)는 현재 `client.call` 뒤 reply/failure envelope를 만들며 plain 경로의 요청별 decoded capture/`authorizeResponseCustody` 연결을 쓰지 않는다. generic throw의 sent 추정도 남아 있다. 권한 변경 뒤 원응답 보관·known usage와 현재 본문 채택의 분리, 요청별 원귀속·중복 정산·중단 인수를 별도로 설계·검증해야 한다. 새 구체 후속 계획 파일은 현재 확인하지 못했으므로 존재하지 않는 링크를 만들지 않는다. 우선 [현 collection 계획의 필수 후속](../../design/chapters/C05-mcp-collections-entry-plan.md)과 [전체 MCP 순서](../../design/chapters/C05-mcp-host-plan.md)를 연결하고 root가 다음 계획을 확정하면 교체한다.

## 갱신할 정확한 문서 위치

현재 공통 버전은 v0.66이다. 다음 버전은 **v0.67 후보**이며 root의 최종 게시 결정으로 확정한다. 아래는 쓰기 대상 후보이지 현재 변경한 파일 목록이 아니다.

| 경로 | 바꿀 현재 항목 / 보존할 내용 |
| --- | --- |
| `design/chapters/C05-mcp-collections-entry-result.md` **신규 경로 제안** | 상단에 최종 local/native/pin/종료·회수·cleanup을 두고, 위 5개 실제 동작과 별도 post-send 한계를 기록한다. native가 아직 없으면 local183/519·native 미확정만 표시한다. |
| `design/chapters/C05-mcp-collections-entry-plan.md` | 첫 “구현 전 계획/선행98882 관측 중” 문단 위에 새 상태를 추가하고, 미결정 permit/후속 선택/partial wait 설명을 착수 당시 기록으로 구분한다. 원 설계·실패 이력을 삭제하지 않는다. |
| `design/chapters/C05-mcp-collections-entry-usage.md` **신규 경로 제안** | actual host `collectionBindings`·online/stored_only·일반 CLI/Web·명시 후속 계획/연결 대기의 의미를 실제 export와 맞춰 설명한다. 예제 실행과 합성 인수는 구분한다. 경로는 root가 확정한 뒤 다른 문서에서 링크한다. |
| `design/chapters/C05-mcp-host-usage.md` | 현재 설명에 collection binding과 이번 실제 입구 범위를 연결한다. 기존 plain API 예제/보관 한계/수치·역사 보존. |
| `design/README.md` | 맨 위 최신 proof 문단, 버전줄, “현재 goal”, HTML 현재 상태 안내. 기존 v0.66과 이전 proof 소개는 날짜·당시 상태로 남긴다. |
| `design/03-migration-plan.md` | 맨 위 최신 설명·버전줄 및 `### C05` 바로 아래 현재 결과 문단(현재 offline/collection 미착수라고 표시된 부분). C05 scope/acceptance 및 C01~C10 순서·미완료 경계는 유지한다. |
| `runtime/README.md` | 맨 위 현재 기능/증거/사용법/후속 링크. 과거 offline 문단·실행 예제는 보존한다. |
| `design/implementation-backlog.json` | `revision`, C05의 `current_implementation`·`nextPlan`, 새 `mcp_collections_progress`, `next_local_work_item`만 좁게 갱신한다. 아래 구조 세부를 따른다. |
| `design/secumon-review.html` | 최신 배너·hero·roadmap·sidebar/footer 현재 설명·review-data 현재 snapshot과 관련 모듈의 done/left/docs만 갱신. 기존 스타일·실행 JS·역사 구조는 그대로 둔다. |

추가 동기화는 자동 9파일 updater와 별도로 root가 범위를 정하면 된다: [구현 메모](../../design/chapters/C05-mcp-collections-implementation-notes.md)의 new8/부분 인수 문구는 당시 상태로 남기고 최종 링크를 추가한다. [문맥 비용 검토](../../design/chapters/C05-context-cost-review.md)에는 수렴/준비 진전의 구현 사실과 **조회 횟수·지연 절감 미측정**을 구분한다. [전체 MCP 계획](../../design/chapters/C05-mcp-host-plan.md)의 후속 목록에는 plain 완료와 collection 현재 인수/별도 post-send를 구분하는 최신 안내를 추가하되 원 순서를 지우지 않는다. `design/VERIFICATION.md`, `design/IMPLEMENTATION-RESUME.md`, `design/WORKLOG.md`의 최종 체크포인트·실행 정리·다음 행동은 root 운영 기록으로 다루며 이전 updater의 암묵적 쓰기 대상에 넣지 않는다.

## backlog·HTML에 들어갈 범위

`execution_chapters[id=C05].status='in_progress'`, `next_execution_chapter='C05'`, `chapterComplete=false`, `goalComplete=false`를 유지한다. `host_tools_progress`, `mcp_host_progress`, `mcp_recovery_progress`, `mcp_custody_progress`, `mcp_offline_progress`와 다른 chapter/requirements/P0~P6는 원값을 보존한다. 이전 snapshot의 당시 nextPlan도 소급 수정하지 않는다.

새 `mcp_collections_progress`에는 proof path/SHA·result/plan/usage·sourceAndBuild, 실제 local/new/related/native/full counts, 종료 시각/관측 범위/SSH 정리, 실제 entryCases(CLI2, HTTP3의 backend·중단 차이), complete 소비/partial wait/current source 경계, `contextSelectionConvergence`와 `evidenceRecallPreparation`, `collectionPostSendCustody:'required_followup'`, 비용 미측정, 모델 중단·Windows/PG 미완료를 둔다. 준비 진전을 evidence 획득 수나 목표 완료 비율로 환산하지 않는다. 구체 후속 계획이 확정 전이면 `nextPlanStatus`도 검토/미착수로 남긴다.

HTML의 `snapshot.currentNotesAsOf/currentResults/currentVerification/nextPlan`과 새 `snapshot.c05McpCollections`를 갱신한다. 기존 `c05McpOffline`를 포함한 모든 snapshot을 보존한다. 현재 16모듈·31역사 항목·93용어를 직접 확인했다. `work/plan/execute/context/tools/mcp/budget/channels/policy` 중 실제 관련 모듈의 현재 설명만 보완한다: work는 준비 진전≠완료, plan은 명시 successor/공개된 근거 ID, context는 필수정보/fit/원문 재검사, budget은 logical local 소비와 physical fetch 구분이 핵심이다. 이전 모듈 설명은 새 snapshot의 previousModuleNotes로 남긴다. `memory`의 개인 기억과 이번 **업무 evidence 조회**를 혼동하지 않는다.

## 재사용할 updater와 게시 전 gate

[offline updater](C05-mcp-offline-update-docs.mjs) SHA `45bcd8adfed7d4c47ecae641f6b52f8f0d636fa4260fb2e317aafd38a38e7b58`의 proof·파일 hash·링크·snapshot·HTML 보존 검사를 재사용할 수 있다. 지금은 이 계획 한 파일만 만들고 updater를 복제하지 않았다. 구체 result/usage/nextPlan 경로와 최종 native 증거가 아직 없으므로 현재 updater를 실행할 수 없다.

- 새 proof 경로는 `runtime/evidence/C05-mcp-collections-linux-nas-20260908/verification.json`, scope는 `mcp_collections_general_resume`다. 실제 supported POSIX partial status, 8단계 성공·9개 결과/원로그 회수·현재 pin과 전체 proof.files SHA·로컬 per-run 종료·관측 가능한 전용 프로세스0·SSH/socket 정리를 확인하고 그 값으로 문장을 만든다. native 수·종료·해시를 예상값으로 채우지 않는다.
- 필수 새 로그 이름은 `final/new-mcp-collections-tests.log`이다. CLI2/HTTP3 성공 이름, context 수렴2, evidence 준비 진전 및 기존 반복 차단이 **해당 최종 pin의 선택 파일과 실제 로그에 있는지** 확인한다. 총183 같은 수 하나만으로 특정 동작을 입증하지 않는다. 최종 native와 local이 다른 소스면 게시를 거절한다.
- predecessor는 offline proof SHA `28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9`다. 이전 updater의 custody predecessor/고정 실패 이름/집중68 보완 증거 로직을 그대로 치환하지 말고, collection의 실제 이력으로 바꾼다. 새 native attempt 실패가 없다면 실패 attempt를 만들어 내지 않는다.
- [초기 부분 인수 기록](C05-mcp-collections-local-integration-result.json), new3~new7 원로그/진단, [수렴 baseline](C05-context-selection-convergence-staging/baseline1.json), [수렴 반례 설명](C05-context-selection-convergence-staging/result.md), [조회 진전 교정 기록](C05-evidence-recall-progress-compatibility1.json)을 보존한다. baseline의 0/2 실패·new7의 무진전 실패·related3의 종전 기대값 실패는 최종 성공으로 덮지 않는다. proof.files 밖의 근거를 쓸 때는 별도 hash 보완 증거로 명시한다.
- 모든 대상의 원문/해시를 읽은 뒤 정확한 단일 앵커를 검사하고, 새 전체 문자열·링크·JSON·HTML을 메모리에서 준비한 다음 쓰기 직전 proof/pin/원문 불변을 재확인한다. 새 marker `C05-MCP-COLLECTIONS-FINAL-PROOF`가 이미 있으면 중복 갱신을 거절한다. 기존 코드 예제, CSS, 실행 JS, items/glossary/scenarios, 모듈의 비대상 필드와 모든 과거 snapshot은 exact 비교로 보존한다.
- 이전 updater는 여러 파일을 순서대로 쓰므로 **다중 파일 원자 게시가 아니다**. 실행 전 원본/해시와 출력 결과를 보존하고, 쓰기 중 실패하면 자동 반복하지 않고 부분 상태를 보고한다. 문서/JSON/JS 정적 검사는 브라우저 렌더링·제품 시험이나 새 native 성공으로 기록하지 않는다.

최종 보고는 “이번 지원 POSIX collection 흐름의 검증”으로 한정한다. 실제 모델/API 시험 중단, 합성 estimator·응답의 의미 품질/과금 한계, 사내 MCP·Knox·운영 배포 미검증, native Windows runtime/file 미구현·미연결/미검증, PostgreSQL 미완료, 프로세스 관측의 unresolved peer와 전원 장애 한계를 유지한다. 문맥 수렴 보완과 최초 근거 조회의 준비 진전은 이번 **기능·경계 교정**이며, 실제 token/물리 I/O/지연 절감률을 주장하지 않는다.
