# C05 문맥 검증 비용의 좁은 후속 검토

2026-09-07 · 현재 소스의 읽기 검토다. **최적화는 아직 구현하지 않았다.** 검토 뒤 같은 소스의 단회 기준선 계측을 추가했다. 호스트 연결 검증과 분리하며 [호스트 연결 다음 검토](C05-after-host-review.md)의 후보를 두 경로로 좁힌다. 실제 모델/API 시험 중단을 유지한다.

현재 Node24/C01 SQLite에서 개인 기억 `KnowledgeService.get` 한 번을 전달 관측했다. 그 안의 원문 검증은 4회이며, 각 검증에서 `state.get` 3회·`session.input` 3회·`session.history` 1회를 확인했다. 전체 측정 구간은 각각 12회/28,404 JSON 바이트, 12회/16,824바이트, 4회/1,468바이트이고 `knowledge.get`은 4회/5,656바이트였다. 관측 확인을 위한 추가 조회는 별도 구간에 집계했다. 이것은 포트가 반환한 JSON 크기이며 물리 디스크 읽기량이 아니다. 모델·도구 호출과 사용량은 0, 임시 담당은 정리했고 source/build 지문은 전후 동일하다. 단회 시간이나 과거 측정과의 차이를 개선율로 해석하지 않는다. [단회 결과](../../runtime/evidence/C05-source-read-baseline1.json) · [실행 로그](../../runtime/evidence/C05-source-read-baseline1.log) · [측정 코드](../../runtime/evidence/C05-source-read-probe.mjs).

[C03 SQLite 비용 기록](C03-personal-memory-cost-notes.md)과 [문서 기억 비용 기록](C03-document-memory-cost-notes.md)은 작은 기억의 문맥 준비에서도 서비스·원문 검사가 반복됨을 관측했다. 두 기록은 서로 다른 과거 소스의 결과다. 당시 조회 수·시간을 현재 코드의 기준선이나 저장 방식 간 속도 비교로 사용하지 않는다.

## 이미 있는 재사용은 유지한다

[ContextCompiler](../../runtime/src/application/context-compiler.ts)의 `compile`은 원본 참조의 전체 지문을 확인한 뒤 호출 안의 `sources` Map에 바이트를 보관한다. 크기와 항목 수 상한이 있고, 재사용한 원본은 게시 뒤 존재·상태를 다시 확인한다. `materialize`의 준비 함수도 WeakMap에서 한 번만 꺼내 쓰며 문맥이 바뀌었는지 재검사한다. 새 범용 원문 캐시를 추가하는 것이 첫 과제가 아니다.

반복이 큰 경로는 개인 기억이다. `compile → readPersonalMemoryContext → PersonalMemoryService.context → read`가 카드를 조립하고, 바로 뒤 `current`가 `context`를 다시 조립한다. `sourcesCurrent`도 시작과 끝에서 개인 기억·세션을 검사한다. [ContextFrameStore](../../runtime/src/application/context-store.ts)의 이전 프레임 조회와 `stage` 전후에도 검사가 있다. 이 지점들은 비동기 읽기·게시 전후의 경계이므로 검사 횟수만 줄이기 위해 없애지 않는다. 먼저 아래 내부 중복을 줄이면 기존 상위 API가 그대로 이익을 받을 수 있다.

## 후보 1: 개인 기억 원문 한 건 검사 안의 중복 DB 조회

현재 경로는 다음과 같다.

```text
SessionKnowledgeSources.#inspect
  input(scope, messageId) + state.get(receipt.workId)       ← 최초 영수증·업무
  SessionOriginals.read(정확히 그 sequence 한 건)
    history → input(동일 발언) + state.get(동일 업무)        ← 중복 조회
  state.get(work.id) + input(scope, messageId)              ← 마지막 변경 확인
```

[SessionKnowledgeSources](../../runtime/src/application/session-knowledge-sources.ts)는 `SessionOriginals.read`에 이미 읽은 업무를 넘기지만, [SessionOriginals](../../runtime/src/application/session-originals.ts)는 이력의 각 발언을 검증하면서 영수증과 원본 업무를 다시 가져온다. 개인 기억은 이 구간에서 정확한 사용자 발언 한 건만 확인하며 assistant artifact는 허용하지 않는다.

최소 변경 후보는 `SessionOriginals`의 **사용자 이력·영수증·원본 업무를 대조하는 순수 검증 부분**을 공유하는 것이다. `#inspect`에서 이미 읽은 영수증·업무와 새로 조회한 이력 행을 그 검사에 함께 넘긴다. 일반 `read`는 계속 자신이 자료를 조회해 같은 검사를 호출한다. 별도 공개 `skipValidation` 옵션이나 “검증됨”이라는 모델 입력을 만들지 않는다.

재사용 범위는 한 `#inspect` 호출 안의 한 `(tenant, agent, principal, session, messageId, sequence, workId)`뿐이다. receipt 본문·payload·kind·workId의 digest, 이력 본문/라벨/순번 일치, applied 상태, source 정책·disclosure·모델 목적지 검사를 모두 수행한다. 현재 마지막 `stableWork`·`stableReceipt` 재조회는 유지한다. 원 정책·업무 scope·적용 세션 basis·사용자 원문 generation·전체 receipt가 최초 값과 같은지 확인한 뒤에만 source/stamp를 반환한다. 파생 기억 격리와 원문 generation을 구분하는 `originalGeneration`도 그대로 쓴다.

이 변경의 직접 대상은 중간의 같은 영수증·업무 조회다. 이력 조회나 마지막 변경 검사를 제거하지 않는다. source 반환 뒤 다음 검증 단계로 성공값을 넘겨 쓰지 않으며, 다른 발언·원문 업무에는 적용하지 않는다. 여러 DB를 원자적으로 읽었다는 보장도 추가하지 않는다.

## 후보 2: 선택 기억을 개별 안정화한 뒤 다시 묶어 검증하는 중복

[PersonalMemoryService.read](../../runtime/src/application/personal-memory-service.ts)는 선택 참조별로 `KnowledgeService.get`을 호출하고, 모든 카드를 모은 뒤 같은 dependency 목록을 `validateDependencies`에 넘긴다. [KnowledgeService](../../runtime/src/application/knowledge-service.ts)의 현재 경로는 다음과 같다.

```text
각 선택 ref: get → #read → #materialize + #stable([id])
모든 ref 뒤: validateDependencies → #stable(선택한 모든 id)
```

`#stable`은 변경이 없을 때도 세 번의 `#snapshot`으로 두 번 연속 같은 전체 vector를 확인한다. `#snapshot`은 이미 여러 ID와 그 부모를 Map으로 묶고, actor·전체 레코드·출처 정책·generation·의존성을 비교한다. 선택 기억은 현재 최대 5개다. 이 기존 묶음 기능을 쓰는 **호스트 내부 선택 읽기 메서드**가 후보이며 아직 export된 API가 아니다.

구체적으로 선택 참조의 최초 owner/revision/읽기 가능 검사와 `#materialize`의 즉시 오류 의미를 보존하고, 마지막에는 한 번의 `#stable(전체 선택 ID)` 결과에서 카드와 dependency를 함께 반환한다. 반환된 전체 목록을 기존 선택에 고정된 semantic dependency와 비교한다. 그러면 카드별 `#stable`과 그 직후 같은 선택을 대상으로 다시 시작하던 안정화 일부를 합칠 수 있다. 최초 거절을 이후 읽기의 성공으로 덮거나 누락 카드를 조용히 생략해서는 안 된다.

범위는 같은 제한 actor, personal owner, 선택 refs/revision, 업무 policy 및 적용 입력 basis로 수행한 **한 번의 선택 카드 조립**이다. 중간에 다른 업무 단계로 넘어가지 않고, 마지막 안정화에서 읽은 카드만 반환한다. 이후 `PersonalMemoryService.current`, `personalMemoryContextCurrent`, 프레임 게시 전후, 모델 dispatch·채택의 현재성 검사는 그대로 다시 수행한다. 바깥에서 독립 호출하는 `get`과 `validateDependencies`도 기존 검증을 유지한다.

재사용할 구현은 `#snapshot/#stable`, `canReadKnowledge`, actor/owner 검사와 기존 dependency semantic 비교다. `inspectDependencies` 및 `SourceInputInspection.current()`의 유한한 출처 확인 방식도 참고할 수 있지만, **현재 inspection은 카드 본문을 반환하지 않고 완전한 입력 검증도 아니다.** 이를 `get`의 대체 응답으로 사용하거나 `current()`를 값만 보는 저렴한 검사라고 가정하지 않는다. 실제 `current()`는 새 `#stable`을 수행한다.

## 재사용을 끝내는 경계

- 업무 revision만 같은 것으로 기억·원문 DB가 같다고 보지 않는다. 기억 정정/잊기/만료, 원문 receipt·이력 불일치, source 정책/라벨/disclosure 변경, 원본 소실은 각각 확인한다.
- 새 사용자 입력·목표 변경·취소·프로필 권한 signal, 선택 ID 또는 owner 변경 뒤에는 이전 단계의 결과를 사용하지 않는다. C05의 실제 호출 직전 원 상태·권한 검사는 유지한다.
- SQLite 전용 snapshot을 코어 필수로 만들지 않는다. 문서 저장소의 event/witness 연속성, 외부 확인 기록, 누락 witness 복구·sync, 등록·디렉터리 정체성 검사는 저장소 API 안에 남긴다.
- 읽기 오류·원문 불일치를 성공 캐시로 가리지 않는다. 시간 기반 TTL, 업무 revision 하나, 이전 카드의 body hash 하나만으로 현재 권한과 원본 확인을 대신하지 않는다.

## 변경 전후 확인할 최소 흐름

먼저 후보 1을 작은 단위로 검증하고, 실제 남은 비용이 크면 후보 2를 이어간다. [기존 SQLite 계측 스크립트](../../runtime/evidence/C03-personal-measure.mjs)와 [문서 계측 스크립트](../../runtime/evidence/C03-documents-measure.mjs)의 실제 C01 stores·서비스·문맥 흐름, `verifyEvaluationBuild`, 공개 포트 forwarding 계측을 재사용한다. 역사적 스크립트나 원결과를 덮어쓰지 않고 새 소스의 기준선을 먼저 남긴다.

| 구간 | 비교할 항목 |
|---|---|
| X 원문 기억 등록 → Y 선택 → `context.prepare` | `state.get`, `knowledge.get`, `session.input/history` 호출·실패·반환 bytes. 이력은 X 출처/Y 현재 대화와 sequence 범위를 구분한다. |
| 후보 1의 한 원문 검사 | 최초 읽기·중간 대조·마지막 확인을 구분해 센다. 마지막 재조회와 이력 본문 검증이 남고 중간 동일 조회만 줄었는지 확인한다. |
| 후보 2의 선택 1개, 최대 5개 | 선택 ID/owner별 조회와 안정화 회차를 구분한다. 같은 원문을 공유하는 기억과 서로 다른 원문을 가진 기억을 분리한다. |
| 문서 저장소 | `hostMetadataFiles().diagnostics()` 차이와 event/witness 수·논리 bytes. 공개 포트 횟수와 파일 경계 횟수를 섞어 합산하지 않는다. |
| 실제 결과 | 카드 본문·버전·출처·선택 basis, 생성 packet/frame의 의미와 필수 근거, 사용량 장부가 동일하다. 임시 ID·시각처럼 실행마다 달라지는 항목은 명시적으로 정규화한다. |

변경을 끼워 넣는 결정적 시험도 필요하다. 최초 읽기와 이력 대조 사이의 receipt 본문/라벨 변경, 마지막 확인 전 source 정책·원문 소실, 두 선택 카드 사이의 정정/잊기/만료, 프레임 게시 중 입력·권한 취소를 각각 주입한다. 기존 거절과 원문 보존, 실제 금지된 모델·도구 호출 0, 알려진 늦은 사용량 정산이 유지돼야 한다. 독립 `get/current/validateDependencies`와 재접속 경로도 확인한다.

측정마다 실행 전후 source/build pin, Node·저장 방식·fixture, 호출 구간을 기록한다. 단계별 경과 시간은 같은 환경에서의 관측값으로만 남기고, 단회 결과를 평균·백분위·물리 디스크 I/O·실제 모델 토큰 절감률로 확대하지 않는다. 이 문서에는 예상 절감 수치나 C05 최적화 완료 주장을 넣지 않는다.


## 전송 후 정산 연결에서 추가로 측정할 비용

2026-09-07 · source `d662de55a414015e5fb4f26b189cc6ec3874d222c68736fd38eec53fa5402580` 읽기 검토다. 현재 NAS 전체 회귀의 속도를 이 경로의 영향이라고 입증한 것은 아니며 제품은 동결 중이다. 아래는 후속 계측 항목이고 최적화 구현·성능 향상 수치가 아니다.

- `ExecutionRuntime.reconcileStoredUsages`는 후보가 없는 경우에도 metadata helper의 현재 상태 비교와 마지막 상태 조회, 전체 attempt 지문 Map 생성을 한다. 정산 후보가 없는 정상 업무에서 소유 확인 직후 반환할 수 있는지 먼저 계측한다. 반환은 관측한 상태 revision의 결과이며, 저장소 조회 중 종료된 수명을 성공으로 반환하지 않는 마지막 동기 검사를 유지해야 한다.
- 후보 선별은 각 ID마다 `StoredToolUsages.candidate`가 전체 attempts를 다시 filter한다. 중복 ID 거절을 유지한 단일 Map/순회로 바꿀 여지가 있다. 이 변경은 원 dispatch/response/raw의 증명 검사를 대신하지 않는다.
- `recordedStoredUsageAttempts`의 이미 정산된 후보는 현재 work의 전체 events를 한 번 읽는다. 기존 metadata 조회 포트로 필요한 정산 이벤트만 확인할 때의 비용과 오래된 정산 기록을 못 찾는 경우의 원 증명 fallback을 비교한다. 새 영수증 장부나 무제한 메모리 cache를 먼저 추가하지 않는다.

현재의 저장 결과 정산·본문 복구 인수를 먼저 확정하고, 후보0/원응답미정산/이미정산·nullable/오래된 많은 attempts와 events를 나눠 state·event·receipt·raw 읽기 횟수와 elapsed time을 측정한다. 수정한다면 소유·세대·권한·수명·경합 검사를 유지하며, 일반 도구가 MCP 정산 기능 때문에 불필요한 반복 I/O를 부담하지 않는지 확인한다. 다른 서버·실제 모델의 처리량 개선으로 확대해 주장하지 않는다.

## 서버 없는 재개에서 추가한 송신 검사 비용 — 측정 전

2026-09-07 · source `5be670d9bfdefbc5cc54d96b267b78131e05ffb7464ed335406c52601ebc51b4`의 구현 읽기 검토다. [PlanningRuntime](../../runtime/src/application/planning-runtime.ts)의 `outgoingDefinitionsCheck`는 자기 owner의 reserved 상태인 비compact 모델 호출을 dispatch할 때 **고정 입력 artifact를 한 번 더 읽는다.** 일반 계획은 저장 packet/options를, agent turn은 기존 `turns.load`를 통해 읽는다. 이 바이트에서 검사 closure를 만들고 transaction 편집·게시 직전에는 현재 definition/availability를 동기 대조한다. 해당 closure 검사마다 입력을 다시 읽지는 않는다. 실제 transport 전에는 기존 입력 로드와 최종 검사를 유지한다.

이는 새 모델 입력에 들어갔던 도구가 그 사이 저장 전용으로 바뀌었는지 검증하는 추가 비용이다. compact에는 적용하지 않는다. 메모리 포트 호출과 파일 경계 읽기·물리 디스크 I/O를 같은 수치로 취급하지 않는다. 이번 [offline 로컬 인수](C05-mcp-offline-resume-result.md)는 동작을 검증했으며 이 추가 get의 실제 bytes·elapsed를 계측한 결과가 아니다.

후속 단회 forwarding 관측에서는 reserve·dispatch·transport·receive/adopt를 나누어 `artifacts.get` 횟수/반환 bytes를 고정 input ref별로 집계하고, 일반 계획/agent turn/compact와 availability 변경 거절을 구분한다. 동일 dispatch 안의 검증된 바이트를 재사용하는 후보를 검토하더라도 호출을 넘어서는 성공 cache는 만들지 않고, 편집·게시·송신 직전 현재 카탈로그의 동기 재검사와 원문·정책 검사를 유지한다. Node·저장 방식·source/build 전후 pin을 함께 남기며 측정 전 절감 수치나 처리량 개선을 제시하지 않는다.


## 2026-09-08 — collection 일반 입구 확정 결과

[최종 결과](C05-mcp-collections-entry-result.md)와 [확정 증거](../../runtime/evidence/C05-mcp-collections-linux-nas-20260908/verification.json)에 로컬 183/519 및 Linux 183/519/3691 통과를 기록했다. 문맥 선택 수렴과 원근거 최초 조회 준비 진전은 이번 기능 교정이다. 실제 I/O·토큰·지연 절감률은 측정하지 않았다. 다음 [페이지별 응답 보관·정산](C05-mcp-collections-custody-plan.md)은 A staging만 작성 중이며 별도 미검증이다. 아래·앞선 진행 수치와 미결정 내용은 당시 기록으로 유지한다.
