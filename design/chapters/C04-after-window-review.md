# C04 문맥 창 이후 — 실제 공백과 다음 최소 단위

2026-09-07 · 현재 소스·로컬 증거를 읽은 후속 제안. 이 문서만 작성했으며 제품·시험·설정 변경, 새 시험 실행, 외부 연결은 하지 않았다.

**다음 권고는 기존 일반 요청 입구에 호스트가 등록한 모델 프로필을 연결하는 한 단위다.** 원문 접수·주 턴·답변·질문·도구 실행·반복 compact를 다시 만들 필요는 없다. 현재 배치 입구가 명시적인 합성 제공자에 고정된 부분을 기존 구조화 어댑터와 연결하고, 실제 모델 대신 로컬 결정적 전송 대역으로 끝까지 확인한다. 실제 모델/API 시험 재개를 뜻하지 않는다.

## 1. 이 검토의 기준과 착수 조건

| 구분 | 확인한 범위 |
|---|---|
| 이전 C04 첫 흐름 | [확정 증거](../../runtime/evidence/C04-turn-linux-nas-20260907/verification.json)의 Linux 3,138/3,138은 이전 소스의 결과다. 현재 문맥 창 수정본의 전체 통과로 대체해 쓰지 않는다. |
| 현재 문맥 창 로컬 검증 | Node v24.20.0에서 [신규 71/71](../../runtime/evidence/C04-window-new-result.json), [관련 704/704](../../runtime/evidence/C04-window-related-result.json). 두 기록 모두 실제 child 종료와 실행 전후 동일 소스·빌드 지문을 포함한다. 로컬 전체 시험을 수행했다는 뜻은 아니다. |
| 현재 NAS | [확정 증거](../../runtime/evidence/C04-window-linux-nas-20260907/verification.json): 같은 최종 소스에서 신규 71/71·관련 704/704·전체 3,209/3,209, 8단계 통과. session 13419 exit 0, 원로그/결과 9개 회수, 관측 가능한 전용 프로세스 0과 SSH 종료 확인. 접근 불가 peer 2개는 미확인으로 보존한다. |
| 실제 모델·화면 | 등록 tokenizer의 실제 정확도, 실제 모델의 반론·요약·응답 의미 품질은 확인하지 않았다. API 시험 중단을 유지한다. 이 검토에서 실제 브라우저도 실행하지 않았다. |

현재 로컬 검증과 NAS 실행의 고정 대상은 source `fe041beb923c764099302efda684399933a39ea076fc3f75a39509ae9bf79357`, build files `48cc235bca0faf0be804deef570319fde24ab5ad3948a406f076a2a41a5985c4`, 파일 수 1,572다. [로컬 pin](../../runtime/evidence/C04-window-local-build2-pin.json)을 따른다. 문맥 창 최종 검증에 실패가 있으면 그 실패를 먼저 처리한다. 통과하면 부모가 확정한 proof를 기준으로 다음 구현을 시작하고, 끝난 로컬·이전 NAS 검증을 이유 없이 반복하지 않는다.

[통합 계획 C04](../03-migration-plan.md), [백로그](../implementation-backlog.json), [문맥 창 계획](C04-context-window-plan.md)은 최종 검증에 맞춰 갱신한다. 계획 본문의 착수 당시 공백은 이미 작성된 코드를 다시 구현하라는 요구가 아니다. [C04 입구 준비](C04-entry-preparation.md)와 [초기 연결 메모](C04-next-implementation-notes.md)도 착수 전 공백의 역사 기록이다. 이 문서는 그 계획을 복제하지 않고 현재 남은 차이만 좁힌다.

## 2. 이미 있는 연결 — 다음 작업에서 재사용

| 현재 위치 | 확인한 구현과 재사용 경계 |
|---|---|
| [AgentTurnService](../../runtime/src/application/agent-turn-service.ts), [일반 프로필](../../runtime/src/presentation/agent-turn-profile.ts), [CLI](../../runtime/src/presentation/agent-turn-cli.ts), [Workbench](../../runtime/src/presentation/local-workbench.ts) | scenario 없이 받은 원문으로 정상 응답 업무를 만들고 기존 세션 영수증에 묶는다. 답변·질문·계획 뒤 같은 세션의 다음 요청을 이어간다. 입구와 전달 장부를 새로 만들지 않는다. |
| [주 턴 프롬프트](../../runtime/src/infrastructure/agent-turn-prompt.ts), [결과 계약](../../runtime/src/domain/agent-turn.ts) | 고정 프롬프트·담당 목적·skills mode에 지문이 있다. `answer/question/plan`, `previousAnswer`, `needs_work`, 검토한 반론과 미충족 요구를 구분한다. 자체 평가는 독립 근거가 아니다. |
| [PlanningRuntime](../../runtime/src/application/planning-runtime.ts), [AgentTurnCalls](../../runtime/src/application/agent-turn-runtime.ts), [완료 검사](../../runtime/src/domain/completion.ts) | 세 호출 목적의 예약·실행·usage·received 복구를 재사용한다. 답변 원본·입력 기준·미완료 graph·가설 검토·의무를 검사하고, 전달과 업무 완료를 구분한다. 새 모델 연결에서도 이 경계를 통과한다. |
| [모델 입력 한도](../../runtime/src/application/model-input-budget.ts), [추정기](../../runtime/src/infrastructure/model-input-estimator.ts), [설정 지문](../../runtime/src/application/model-input-profile.ts) | 입력·출력·총 창·바이트를 구분하며 등록 추정기로 같은 요청을 계산한다. 송신 전 설정 변경과 이미 받은 응답 복구를 구분한다. 다른 한도 계산기나 자원 장부를 추가하지 않는다. |
| [ContextCompiler](../../runtime/src/application/context-compiler.ts), [preview](../../runtime/src/application/model-context-preview.ts), [SessionCompactor](../../runtime/src/application/session-compactor.ts) | 무쓰기 크기 검사, 보호한 최소 입력, 선택 항목 축소, 유한 prefix 축소, 실제 게시 후 최종 요청 재측정이 연결돼 있다. 원문 소실과 정상 summary 전진도 구분한다. head 없는 preview는 실제 송신 입력이 아니다. |
| [기존 모델 조사 시험](../../runtime/src/tests/model-runtime.test.ts), [응답 완료 시험](../../runtime/src/tests/agent-response-completion.test.ts) | 늦은 반증→가설 갱신→필요 graph 변경과 완료 차단의 기존 회귀가 있다. 이를 이유 없이 새 framework나 같은 단위시험으로 재작성하지 않는다. |

이 표는 소스에 구현이 존재한다는 확인이다. 새 문맥 창의 전체 OS 검증 완료나 임의 모델의 의미 판단 능력을 주장하지 않는다.

## 3. 실제 남은 공백

**등록 이름에서 실행 모델까지의 연결이 없다.** [C01 설정](../../runtime/src/application/agent-profile-contracts.ts)은 `model: null | {profile: string}`을 저장하지만, `openAgentTurnProfile`은 `provider:'synthetic'`만 허용하고 `config.model.profile`을 해석하지 않는다. CLI도 같은 선택만 허용한다. `modelReady:false`인 파일 설정 조회는 모델을 실제 연결했다는 상태가 아니다. 이름이 없거나 미등록된 경우의 거절은 유지하되, 등록된 호스트 제공자를 정상 조립할 경로가 필요하다.

**구조화 주 턴은 있지만 범용 compact 전송 연결은 없다.** [StructuredAgentTurnAdapter](../../runtime/src/infrastructure/structured-agent-turn.ts)와 [StructuredPlannerAdapter](../../runtime/src/infrastructure/structured-planner.ts)는 SDK에 종속되지 않는 전송 포트를 받는다. 반면 일반 프로필의 compact는 [SyntheticSessionCompactPlanner](../../runtime/src/presentation/synthetic-session-compact.ts)의 정해진 문구와 규칙만 처리한다. 기존 compact 계약·출처 검증·원문 및 retained 보존·게시 영수증은 이미 있으므로, 필요한 것은 그 계약을 사용하는 구조화 입력/응답 포장과 호스트 연결이다. 모델마다 요약 저장소를 다시 만드는 작업이 아니다.

**일반 입구의 배치 구성이 아직 합성용이다.** 담당 ID·목적·skills mode·저장소는 C01에서 오지만, `local/operator`, 허용 목적지·자료 label, `fixture.read`, 기본 자원 한도는 프로필 코드가 고정한다. 호스트가 구성한 정책·도구를 받는 조립 지점을 만들면 기존 `composeRuntime`의 정확한 도구 계약을 그대로 쓸 수 있다. 사용자 텍스트나 HTTP 요청이 임의 권한·어댑터 경로·모듈을 지정하는 기능은 필요하지 않다. 사내 MCP 전체 연결은 C05/C06의 별도 범위다.

다음 두 항목도 C04 잔여지만 위 결선과 한꺼번에 늘리지 않는다.

- **새 응답 입구의 복합 조사 인수:** 기존 조사 코어에는 반증·부분 재계획 검증이 있고, 새 주 턴에는 직접 답변·한 번 읽기·질문·needs_work 검증이 있다. 두 경로를 잇는 “늦은 반증과 읽기 실패 → 기존 성공 작업 재사용 → 필요한 재계획 → 수정 답변”의 실제 일반 입구 인수를 보강할 수 있다. 이는 가설/완료 엔진 재작성이나 새로운 독립 반론 에이전트 구현이 아니다. 독립 반론 에이전트는 C08이다.
- **명시적 목표 변경의 일반 입구:** 현재 `followUp`은 `continue` 또는 `clarify`로 원문 기준을 갱신하면서 기존 Goal과 응답 요구를 보존한다. 기존 코어의 목표 변경 명령과 달리 일반 chat 입구에 목적 변경을 명시하는 별도 흐름은 없다. 모델에게 목표 수정 권한을 주는 대신 기존 명령을 재사용할지 후속 단위에서 정한다. 자연어로 새 업무/기존 업무를 자율 선택하는 의미 품질도 합성 시험만으로 확인할 수 없다.

## 4. 권고하는 다음 한 단위

**C01의 등록된 모델 이름 → 호스트 등록 제공자·정책·도구 → 기존 주 턴/compact → CLI 또는 HTTP 응답과 재개**를 하나의 흐름으로 끝낸다. 기존 synthetic 경로는 명시적인 예제로 유지한다.

1. **호스트 등록 경계를 작은 factory로 연결한다.** 등록된 이름을 호스트 소유 구성에서 찾고 C01 담당 ID·목적·skills mode로 어댑터를 만든다. 같은 조립 함수를 CLI/Web이 사용한다. 초기 검증 제공자는 결정적 로컬 transport이며 실제 네트워크를 호출하지 않는다. 새 설치 시스템·동적 플러그인 로더·키 탐색·기본 외부 fallback은 만들지 않는다.
2. **기존 구조화 주 턴과 compact를 같은 호출 수명에 결선한다.** compact의 고정 prompt/strict candidate/usage/추정 포장을 얇게 추가하되 기존 SessionCompactCalls와 SessionCompactor를 사용한다. 첫 범위는 같은 등록 모델 신원으로 주 턴과 선택적 compact를 제공하면 충분하다. 목적마다 서로 다른 모델·권한을 자동 배정하는 라우터는 다음 선행 조건으로 넣지 않는다. compact 미등록은 그대로 미지원이며 합성 요약으로 조용히 대체하지 않는다.
3. **설정과 실제 요청의 대응을 남긴다.** 등록 프로필의 모델 신원·요청 템플릿/추정 revision·한도가 실제 예약 입력 지문까지 이어지는지 검사한다. 현재 C01 저장 schema와 과거 semantic v1~v4를 소급 변환하지 않는다. 수신한 응답 재개는 같은 원본과 사용량을 보존하고, 송신 전 등록 변경은 기존 currentness 검사로 막는다.
4. **같은 사용자 흐름으로 마무리한다.** 읽기 도구를 하나 호스트에서 주입한 담당을 열고, 긴 세션의 자동 compact→답변→재시작 후 후속 요청을 실행한다. 도구 등록 제품을 새로 만들거나 모든 backend에서 동일 전체 흐름을 복제하지 않는다. 기존 C01 저장소·세션·문맥 시험은 재사용하고 결선에 따른 차이만 검증한다.

권고 수정 지점은 일반 프로필의 조립, 그 조립을 여는 CLI/Web 선택 경계, 신규 구조화 compact 포장과 관련 계약 시험이다. `PlanningRuntime`, `ContextCompiler`, 원문 저장소, 개인 기억, 도구 실행기는 확인된 결함이나 필수 연결이 드러난 경우에만 수정한다. 모델 응답을 UI가 직접 실행하거나 답변을 가짜 PlanProposal로 바꾸지 않는다.

### 최소 인수 5개

| 흐름 | 확인할 차이 |
|---|---|
| 등록 없음·잘못된 이름 | 정상 설정 조회는 가능하지만 모델 실행은 명시적으로 미등록을 알린다. 네트워크·모델 예약·임의 fallback은 0이다. 기존 명시 synthetic 선택은 호환된다. |
| 등록된 로컬 전송의 한 답변 | C01 purpose/agentId/skills mode와 호스트 정책을 담은 실제 구조화 요청이 같은 저장 입력과 대응한다. CLI 또는 HTTP 접수→답변 artifact→전달까지 같은 WorkState에 usage를 남긴다. 자유 문장 의미를 이해했다는 주장은 하지 않는다. |
| 등록된 읽기와 compact | 호스트 등록 읽기 도구의 관측이 다음 답변 입력에 들어간다. 작은 합성 창에서는 구조화 compact가 기존 장부로 실행되고 합의·반론·원문 참조 및 현재 입력을 보존한 실제 주 턴으로 돌아온다. 기존 한도 helper 시험을 복제하지 않는다. |
| 전송 반환 차이 | 잘린 JSON·거절·모델 신원 불일치·usage 없음/부분 usage를 기존 수명으로 처리한다. 이미 호출한 소비를 0으로 바꾸거나 자동 재호출하지 않는다. 로컬 전송 대역은 실제 제공자 wire protocol 검증이 아니다. |
| 예약과 재시작 | 예약 후 등록 revision 변경은 이전 입력 송신을 차단한다. 받은 응답 뒤 재시작은 원 호출/영수증을 사용한다. 입력·정책 변경 차단과 기존 설정 지문 규칙을 그대로 적용한다. |

각 검사는 이미 있는 adapter·runtime 회귀와 역할을 나누고, 검증 명령·소스 pin·실제 종료·원로그를 남긴다. 실제 사내 모델의 JSON 준수율, 판단 정확도, 요약 누락률, tokenizer 오차, 지연·비용 비교는 별도 실측이며 현재 중단된 모델 시험을 자동 재개하지 않는다.

## 5. 다음 goal 턴으로 넘길 사항

문맥 창 최종 proof를 확인했다. 다음 한 단위는 **등록 위치와 실제 전송 대역의 선택을 작은 계약으로 고정한 뒤, 기존 런타임으로 한 흐름을 완성하는 것**이다. [구현 계획](C04-registered-model-plan.md)에 채택할 경계와 A→D 순서를 저장했다. 세부 근거는 [호스트 등록 계약 검토](C04-registered-model-contract-review.md)와 [구조화 compact 계약 검토](C04-structured-compact-contract-review.md)다. HTTP에서 임의 모델 코드나 권한을 받는 방식은 선택지가 아니다. 이 검토만으로 그 factory/API가 구현된 것은 아니다.

C03의 기본 SQLite·선택 문서·명시 이관과 원문/개인 기억 현재성은 이 흐름의 기반으로 재사용한다. PostgreSQL, native Windows runtime/file binding 연결·실기 검증, Knox/MCP 실제 연동, C05 효율 비교, C08 독립 반론·동료 배치는 이 단위의 선행 완성 조건이 아니다. 해당 잔여를 완료로 표시하지 않는다. C04 전체 및 전체 goal도 계속 미완료다.
