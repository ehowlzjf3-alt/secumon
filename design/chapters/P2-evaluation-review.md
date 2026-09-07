# P2-05 고정 실행 평가 독립 검토

2026-09-05 · 합성 로컬 자료에 대한 설계 검토 · 구현/시험 실행 결과 아님

아래 132개 fresh/36개 replay phase 행렬은 착수 시 제안이다. 최종 구현은 [평가 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-evaluation-plan.md)의 16개 변형×두 업무군×두 저장소×세 모드, 192개 실행과 각 기록 재생을 사용한다. 실제 통과 수치는 [결과 기록](/Users/seunghanee/Documents/secumon/design/chapters/P2-evaluation-result.md)을 따른다.

검토 기준은 [P2 모드 계획의 5단계](/Users/seunghanee/Documents/secumon/design/chapters/P2-modes-plan.md), [실행 모드의 평가 계약](/Users/seunghanee/Documents/secumon/design/11-execution-modes.md), [범위와 우선순위의 재생 가능한 평가](/Users/seunghanee/Documents/secumon/design/14-scope-and-priorities.md)다. 이번 검토는 아래 실행 평가의 판정 조건을 제안한다. 기존 source/fixture/문서는 수정하지 않았으며 모델/API/사내 서비스와 시험 명령을 실행하지 않았다.

## 1. 기존 시험에서 재사용할 부분과 한계

[정적 fixture 평가기](/Users/seunghanee/Documents/secumon/runtime/src/application/fixtures.ts)는 checkpoint마다 새 work를 만들고 사용 도구 수를 주입한다. 기대 사유/근거 ID도 실제 결과에 포함되는지만 검사한다. 따라서 이 평가를 그대로 누적 실행의 완료율로 사용하면 중간의 잘못된 완료, 불필요한 추가 호출, 금지 근거의 추가 채택을 놓친다. [fixture 보고서 생성기](/Users/seunghanee/Documents/secumon/runtime/src/presentation/fixtures.ts)의 elapsedMs는 파일 읽기와 정적 판정 루프 시간이며 사용자 업무 지연이 아니다. 기존 4개 시나리오/22개 checkpoint 기록은 정적 계약 기준선으로 유지해야 한다.

[두 저장소의 영속 workflow 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/persistent-workflow.test.ts)은 실제 모델 예약/응답 저장, 도구 실행, 근거 반영, 전달을 잇는 harness 기반이다. 다만 재시작 뒤 저장 모델 응답을 채택하고 추가 모델/도구 호출로 완료한다. 이것은 저장 응답 재사용을 포함한 실행 재개이며 전체 replay의 호출 0 근거가 아니다.

[모드 통합 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/execution-mode-runtime.test.ts)은 두 업무군/두 backend/세 모드, 단순 업무 조기 완료와 fast 복잡 계획 거부를 이미 다룬다. 미리 준비된 복잡 계획을 한 번에 제공하는 사례와 실행 중 새 반증이 도착해 계획을 바꾸는 사례는 구별해야 한다. [진전 통합 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/work-progress-runtime.test.ts), [준비 진전 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/resource-progress.test.ts), [대화 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/conversation.test.ts)의 경계 조건도 평가 일정에 연결할 수 있다.

[실제 프로세스 종료 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/workflow-crash.test.ts)은 저장 전 읽기 응답 유실 시 원본 도구를 다시 호출하고, 저장 후에는 같은 도구 응답을 재사용한다. 쓰기 응답 유실은 unknown 의무를 유지한다. 읽기 재호출이 있는 복구나 수신 영수증 lookup이 있는 전달 정산을 외부 진입 0의 replay로 표시하면 안 된다.

## 2. 필수 시나리오 행렬

모든 행의 기본 축은 family `{document_comparison, observation_review}` × backend `{sqlite, file-journal}` × initial mode `{auto, fast, deep}`의 12개 조합이다. mode는 초기 요청 값이며 실행 중 실제 전략과 변경 이력을 별도로 기록한다. 같은 조합의 시작 예산/기한/자료/응답 순서는 고정하고, 모드별 정책 차이만 manifest에 명시한다.

| ID | 고정 입력/일정 | 문서 업무군 | 관측 업무군 | 반드시 관측할 결과 |
| --- | --- | --- | --- | --- |
| F01 | 단순한 충분한 근거 | 최신 보존 기간 원본 | 수집 완료 원본 | 세 모드 모두 필요한 최소 실행 후 검증 완료. deep의 불필요한 추가 탐색 없음 |
| F02 | 복잡한 근거와 검토 의무 | 독립 문서와 정정본 비교 | 관측과 승인 기록 연결 | auto/deep의 필요한 검토와 완료. fast가 제한으로 중단하면 부족한 조건을 보존하고 완료하지 않음 |
| F03 | 초기 주장 뒤, 최종 판정 전에 반증 공개 | 90일 주장 뒤 30일 문서/유효한 정정본 | 초기 승인 주장 뒤 현재 유효한 반대 기록 | 반증 전후 판단/가설/계획의 의미 변화와 현재 근거 확인. 이전 결론의 무조건 재사용 및 성급한 전달 금지 |
| F04 | 필요한 원본을 제공하지 않음 | 필수 문서 결손 | 필수 승인/수집 원본 결손 | 자료 부족이 명시되고 완료/꾸며낸 근거 없음. 빈 검색이나 재조회로 진전·총기한을 갱신하지 않음 |
| F05 | 결과 소비 전 고정 I/O 경계에서 출처 권한 철회 | 문서 접근 철회 | 관측/승인 자료 접근 철회 | 이후 모델 입력/근거 읽기/답변에 철회 본문·metadata 노출 없음. 원본 재검사 실패를 새 추론으로 덮지 않음 |
| F06 | 같은 의미의 도구 실패, task ID 변경, reopen | 같은 문서 조회 실패 | 같은 관측 조회 실패 | failure key/첫 총기한/횟수가 유지됨. backoff 동안 호출 0, 상한 이후 새 배정 0. 모드 변경/compact로 우회하지 않음 |
| F07 | 필수 회신 대기 후 가짜 시계 +86,400,000ms, 새 프로세스 재개 | 문서 책임자 회신 | 변경 담당자 회신 | 대기 동안 추론 호출 0, deadline/wake 조건 보존. 유효 회신만 의무를 정산하고 남은 실행을 재개 |
| F08a | 실행 중 모드 변경 | 같은 근거/목표 유지 | 같은 근거/목표 유지 | auto→fast, fast→deep, deep→fast 각각 다음 안전 배정 경계에 적용. 이미 사용/예약/unknown/완료 task와 총기한 보존 |
| F08b | 실행 중 완료 기준 추가 | export 기준 등 추가 | 추가 필수 확인 기준 | 목표 revision과 새 기준을 반영. 이전 목표의 준비 결과를 새 목표의 완료로 전달하지 않음 |
| F09a | 예약 후 실제 adapter 진입 전 취소 | 읽기 예약 취소 | 읽기 예약 취소 | 취소 이후 실제 진입/최종 완료 답변 0, 미호출 예약 해제, 취소 상태 보존 |
| F09b | adapter 진입 후 응답 도착 전 취소 | 늦은 문서 응답 | 늦은 관측 응답 | 새 배정 없음. 늦은 응답/usage는 정산하고 취소를 완료로 바꾸지 않음. 미확정 비용/효과를 지우지 않음 |

이는 기본 9개 시나리오 그룹의 108개 조합에 변경/취소의 별도 경계를 펼친 **132개 fresh 관측 셀**이다. 셀 수는 새 node:test 개수나 독립 사용자 요청 수와 같지 않다. 하나의 매개변수 시험이 여러 셀을 검사할 수 있지만 보고서에는 각 셀의 실행·실패·미실행을 구별해 남긴다. 각 업무군이 동일한 합성 결과를 다른 이름으로만 사용하는 대신 그 업무군의 원본/완료 기준을 실제로 소비해야 한다.

F03의 반증은 처음부터 planner 입력에 숨겨 넣지 않는다. 자료 공개 일정과 호출 barrier를 manifest에 고정한다. 초기 근거만으로 실제 완료 가능한 업무가 끝난 뒤 예고 없던 사실이 생긴 것을 과거의 잘못된 완료로 소급 판정하지 않는다. 반증 검토가 아직 필요하다는 독립 출처/coverage/필수 검토 조건을 초기 계약에 두거나, 완료 판정 전에 반증 도착을 보장해야 한다. 관측 fixture의 maintenance-ticket과 denied-ticket은 자동 supersession 관계가 아니므로 단순히 나중 응답이라는 이유로 앞 자료를 폐기하면 안 된다.

F06은 기본 fast의 도구 2회 상한이 반복 실패 3회보다 먼저 적용될 수 있다. 이 경우 올바른 모드 상한 중단을 실패 정책 미작동으로 오판하지 않는다. manifest에 모드별 허용 종료 사유와 도달 가능한 실패 횟수를 사전 고정한다. F07은 업무 wallTimeMs를 하루보다 길게 명시하고, 이와 별도로 기한 이후 회신이 새 예산/기한을 만들지 않는 부정 사례를 둔다. 짧은 기본 fixture 기한을 사용한 다음 날 완료 기대는 잘못된 oracle이다.

14장의 부분 결과, 컨텍스트 교체, 오래된 명세, 외부 효과 불명확은 위 행 이름만으로 검증되었다고 표시하지 않는다. 각 항목을 실제 실행의 삽입 경계와 연결하거나 기존 전용 회귀 시험의 고정 버전/사례에 연결한 별도 coverage 표를 둔다. 새 전체 실행에 연결하지 않은 항목은 `existing_regression_only`로 남긴다. 특히 원본 유실과 derived context 유실, 읽기 재호출과 쓰기 unknown 보존을 같은 기대 결과로 합치지 않는다.

## 3. Replay와 새 실행을 이어가는 경우

아래도 같은 12개 축으로 관측한다. fresh 저장 상태를 만든 비용은 setup/lifetime에 기록하고 replay phase 비용과 분리한다. 아래 36개 phase 관측을 fresh 완료 요청 수에 더하면 안 된다.

| ID / 실행 종류 | 시작 상태와 허용 동작 | phase 내 실제 진입/상태 조건 |
| --- | --- | --- |
| R01 `stored_model_adoption` | received 모델 응답과 artifact를 reopen 후 읽어 한 번 채택하고 다음 예약 전에 멈춤 | planner/model·tool·sink send/lookup 모두 0. 채택 CAS는 허용, 모델 호출/토큰 재청구 없음 |
| R02 `stored_tool_adoption` | received 도구 결과와 원본 출처를 reopen 후 읽어 한 번 채택하고 전달/다음 배정 전에 멈춤 | 실제 도구·planner/model·sink send/lookup 모두 0. 채택 CAS는 허용, 고유 근거/사용량 중복 없음 |
| R03 `completed_projection_replay` | 완료된 저장 결과를 현재 권한으로 조회/재구성 | 모든 외부 adapter 진입 0, 새로운 업무 이벤트/영수증/상태 revision/사용량 변화 0 |

R01/R02 다음에 workflow를 끝까지 실행하면 그 이후 phase는 `fresh_continuation`으로 따로 기록한다. 이전 packet의 재사용 여부는 실행 종류를 결정하지 않는다. 저장되지 않은 응답을 다시 요청하면 `recovery_continuation`이며 실제 호출을 센다. 전달 ACK 유실 뒤 lookup은 `delivery_reconciliation`으로 따로 계수하고, `send=0`을 `sink 진입=0`으로 바꾸지 않는다. 실제 모델을 다시 호출하는 추론 비교는 별도 요청·usage·비결정성을 갖는 평가이며 이번 합성 replay에 포함하지 않는다.

각 replay 부정 대조는 원본 삭제/손상/권한 철회 후 명시적인 unavailable/차단을 요구한다. 재생 불가능한 입력을 제외하고 성공 replay 비율만 내지 않는다. derived context만 손상된 경우에는 현재 정본에서 재생성이 가능하되, 이것이 손상 원본을 복구했다는 의미는 아니다. 저장 artifact 안의 본문도 현재 접근권과 출처를 검증해야 하며 버전 고정은 긴급 권한 철회를 무시할 권한이 아니다.

## 4. Outcome oracle

oracle은 실행 전에 fixture의 독립 기대값과 자료 공개 일정으로 고정한다. 실제 runtime의 마지막 `complete` 값이나 동일한 completion 함수를 다시 호출한 결과만 정답으로 사용하지 않는다. 최소한 아래 조건을 저장 상태/이벤트/실제 adapter entry 기록과 대조한다.

- 최종 상태뿐 아니라 모든 공개 완료 주장과 결과 전달 시점에서 현재 목표/정책/기한, 충분한 coverage, 독립 출처 수, 정정·철회·반증, 가설 검토, 필수 의무가 충족되어야 한다. analysisReady, result 준비, 전달 영수증, completed를 별도 결과로 기록한다.
- 필수 근거와 금지 근거를 모두 검사한다. ID 부분집합 일치만으로 통과시키지 않고 원본 lineage/범위/내용의 의미를 확인한다. 복사본을 독립 원본으로 세지 않는다. `export.allowed=false`나 유효한 거부 기록은 정확한 부정 답변으로 완료할 수 있다.
- 숨은 mode 승격, 예산/총기한 초기화, 취소 뒤 새 배정, 대기 중 추론, 미확정 비용/외부 효과 삭제, 중복 결과 전달은 명시적인 금지 결과다. 고유 키와 허용 추가량으로 실제 예약/사용 이력을 대조한다.
- fast의 정당한 미완료·권한 부족·대기·취소는 계약을 통과할 수 있으나 목표 완료율의 완료 분자에는 넣지 않는다. `contractPass`, `analysisComplete`, `deliveryConfirmed`, `workCompleted`, `expectedStop`을 독립 필드로 둔다.
- scripted planner가 거부된 계획을 같은 응답으로 무한 제공하지 않도록 응답 수/허용 경로도 고정한다. oracle 정보를 planner에 전달하지 않는다. 사람은 두 업무군과 주요 실패/회복 경계의 저장 결과 표본을 검토하고, 모델 평가 점수만으로 승인하지 않는다.

동시 변경 검증은 제어 가능한 I/O barrier를 사용한다. 마지막 출처 read view 이후 모든 다른 저장소 변경을 막는 분산 원자성은 이번 계약으로 주장하지 않는다. 대신 각 barrier가 실제 발동했는지 단언하고, 그 후의 호출/답변/상태에서 금지 결과가 없는지 검사한다.

## 5. 지표와 분모

| 지표 | 분모/기록 조건 |
| --- | --- |
| 목표 완료율 | 완료한 fresh 요청 / 실행한 전체 fresh 요청. 별도로 사전 oracle상 완료 가능한 요청 중 완료 비율을 표시. 중단/대기/취소 셀을 몰래 제외하지 않음 |
| 계약 통과율 | 모든 필수 불변식을 통과한 셀 / 실행한 셀. 미실행 셀 수와 전체 예정 셀 수도 함께 표시 |
| 잘못된 완료 | 잘못된 완료를 한 요청 수 / 전체 요청 수와, 잘못된 완료 주장 수 / 모든 완료 주장 수를 구별. 완료 주장 0이면 후자 비율은 N/A |
| 고유 조회/재조회 | 실제 source entry의 의미 요청 키로 집계. tool/version/입력/범위/권한·lifecycle·freshness 기준을 고정하고 task/attempt ID 변경을 제거. 다른 page나 정당한 새 관측을 중복으로 세지 않음 |
| 시도/호출/채택 | 예약, dispatch, 실제 model/tool entry, received, adopted, reused, joined를 각각 계수. 내부 catalog/guidance/원본 검증 I/O는 별도 열. 한 batch wrapper와 내부 source call 수를 합치지 않음 |
| 비용 | 요청별 사용·예약·미확정 model/tool/token/replan 값과 실제 관측치를 분리. 성공 요청만의 평균과 실패 포함 총비용을 함께 기록. 실제 토큰/금액 미측정은 null이며 fake usage는 합성 추정값임을 명시 |
| 완료 업무당 비용 | 전체 fresh 실행에 든 관측 비용 / 검증 완료한 fresh 업무 수, 완료 0이면 N/A. 완료 사례만의 조건부 평균과 이름/분모를 구별 |
| replay 비용 | setup 이전/이후, replay 직전/직후, continuation 직전/직후 counter 차분. 과거 lifetime 사용량이 남은 것을 새 호출로 세거나 과거 비용까지 0으로 표시하지 않음 |
| 상태/근거 보존 | 변경/재시작 전후 원본 참조·goal/control revision·완료 task·usage·failure 첫 기한·unknown 의무의 기대 보존을 셀별 단언. 원문을 일반 로그에 복제하지 않음 |

첫 유용 응답은 접수 ACK나 반복 상태 메시지가 아니라 사용자에게 전달된 유효한 사실 또는 실행 가능한 부족 조건 안내로 사전 정의한다. 접수 지연, 첫 유용 응답, analysis 검증 완료, 전달 확인 지연을 따로 측정한다. 단지 result 준비 artifact가 만들어졌다는 이유로 사용자 응답 시간을 기록하지 않는다.

실행기 monotonic 실측 시간과 fake clock의 업무 경과시간은 다른 열이다. 다음 날 대기의 86,400,000ms를 CPU 지연으로 보거나, fake clock이 멈췄다는 이유로 실제 I/O 지연을 0으로 표시하지 않는다. 대기 중 모델/도구 호출 0은 운영 저장소·scheduler 비용 0을 뜻하지 않는다. 고정 합성 표본의 p50/p95에는 n과 반복 횟수를 표시하고 실제 모델 지연/운영 tail latency로 일반화하지 않는다.

모드 비교에는 같은 자료·script·예산 기준·장비·Node·backend·cache 조건을 사용한다. 실행 순서/반복과 cold/warm 여부를 기록한다. 과거 정적 fixture 시간과 새 전체 workflow 시간을 비교해 지연 개선을 주장하지 않는다. 라우팅 호출/지연, 불필요한 승격·필요 검토 누락, 사용자 개입 횟수도 실제 관측 가능할 때만 보고하고 없으면 미측정으로 남긴다.

## 6. Manifest와 provenance 고정

실행 전 입력 manifest와 실행 후 증거 report를 분리한다. 결과 파일 자신의 hash를 그 파일에 삽입하는 자기 참조를 피하고, 변경 전 baseline을 덮어쓰지 않는다. 최소 pin은 다음과 같다.

1. 평가 schema/scenario/oracle 버전과 파일 SHA-256, 두 업무군 원본 fixture와 파생 시나리오의 관계, 자료 공개/오류/회신/취소/변경 일정, seed·ID 생성·fake clock 시작/전진·허용 step 수. 미래 반증을 언제 공개했는지도 근거로 남긴다.
2. Git 유무와 무관한 source snapshot digest, 실제 실행한 build의 source 대응 관계, lockfile·Node·의존성 버전, backend 및 저장 형식, 실행 OS/장비, 측정 설정/cold-warm 상태. source hash만으로 낡은 dist를 실행하지 않았다고 주장하지 않는다.
3. 목표/계획/상태/control revision, 초기 mode와 mode 정책, work/위임 예산, 무진전/실패 정책, 원래 기한. 재시작 후 같은 정책이라는 것을 문자열 모드 이름만으로 판단하지 않는다.
4. tool ID/version과 전체 계약 digest, source adapter/collection/reuse 조건, guidance manifest·규칙·본문 hash, planner/script/prompt template/skill·방법 버전, model identity/capabilities·입력 추정·출력 상한. `version=1`처럼 같은 문자열 아래 내용이 바뀌는 경우 digest 불일치를 검출해야 한다.
5. tenant/principal·정책 digest·labels·destination·자료 lifecycle generation, 접근 가능한 원본 artifact refs, 결과/호출/전달 영수증·이벤트 sequence, reopen 전후 state/head identity. 출처 참조의 소유권을 현재 읽기 권한과 동일시하지 않는다.
6. `synthetic=true`, 각 phase의 execution kind, 실제 모델/API/사내 서비스 호출 여부, 물리 adapter entry counter, 관측/추정/미측정 구별. 일반 로그에는 필요한 작은 projection과 보호된 참조만 두고 전체 입력/본문을 무조건 복사하지 않는다.

## 7. 이번 검토의 결론

우선 기존 영속 workflow harness에 고정 일정과 실제 entry counter를 붙이고, 단일 work의 누적 전이를 독립 oracle로 검사하는 것이 필요하다. replay는 채택/조회 구간에서 멈추어 호출 0을 입증한 뒤 새 실행 구간과 분리해야 한다. 이 문서는 그 구현의 요구 조건이며, 위 행렬 통과나 전체 P2-05 완료를 입증하는 실행 기록은 아니다.

## 8. 추가 검토: 보이지 않는 정정본과 완료 기준

[근거 lineage 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/evidence-lineage.test.ts)의 `a correction remains a monotonic supersession...` 및 version-chain 사례와 [P2 기억 계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-memory-plan.md)은 정정본의 철회·접근 제거·권한 상실이 이미 대체된 옛 근거를 현재 근거로 부활시키면 안 된다고 명시한다. 따라서 supersession을 현재 보이는 accepted 자료로만 계산하도록 바꾸는 것은 기존 계약을 위반한다.

Node v24.20.0에서 기존 build의 순수 intake/completion/control 함수를 합성 레코드로 호출하여 다음 결과를 관측했다. 파일·저장 상태 변경, 외부 호출, 새 build 또는 test suite 실행은 없었다.

| 합성 입력 | 관측 결과 |
| --- | --- |
| 독립 원본 a/b의 value=true, counter의 value=false; 목표는 완전한 독립 출처 2개 | unresolved_counterevidence로 완료 불가 |
| 같은 source/lineage의 replacement가 counter를 supersede하고 retracted | intake 수락; 현재 a/b만 남아 완료 가능 |
| replacement가 partial이며 facts가 비어 있음 | intake 수락; a/b가 출처 수를 채워 완료 가능 |
| replacement가 a에서 복사됨(derivedFrom a), source/lineage는 counter와 같음 | intake 수락; 복사본 자체는 독립 출처로 세지 않지만 a/b로 완료 가능 |
| 신규 replacement의 access=restricted | intake가 evidence_access_unavailable로 거부. 이를 정상 수락 경로의 완료 사례로 세지 않음 |

위 관측은 충분성 정책의 경계를 보여주지만, 그 자체로 coding violation을 확정하지 않는다. 철회된 lineage를 더 이상 요구하지 않고 남은 유효한 출처가 목표의 최소 수를 충족하면 완료를 허용하는 해석이 현행 계약과 양립한다. 공식 수명 변경 경로에는 별도의 재검토 의무도 있으므로 그 의무가 없는 순수 배열 판정을 실제 수명 서비스의 자동 완료로 일반화하면 안 된다.

이번 평가의 최소 선택은 scorer에서도 옛 근거를 부활시키지 않고, 특정 lineage의 현재 정정본 확인이 필요한 fixture에 그 replacement의 정확한 ID/source/lineage/관측 시각을 `oracle.requiredEvidenceIds`와 `oracle.originals`로 고정하는 것이다. 그러면 접근 불가·철회·복사본은 필수 원본 결손으로, 부분 원본은 coverage 부족으로 실패한다. 정상적인 완전한 정정본은 별도 양성 대조로 통과해야 한다. 모든 숨은 lineage에 일반적인 완료 blocker를 추가하거나 partial/derived supersession 수락 정책을 바꾸는 것은 별도 설계 결정이며 이번 평가 단위에서 production 의미를 변경하지 않는다.
