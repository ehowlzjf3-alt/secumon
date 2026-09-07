# 일반 에이전트에 MCP 읽기를 연결하는 방법

<!-- C05-MCP-COLLECTIONS-FINAL-PROOF: 1ef802e5b3473c96de38f364f62815584f8f1206d441a473be8666c1ecb61fd9 -->
**MCP 수집의 일반 입구 재개와 저장 근거 조회**를 연결했다. 같은 담당의 여러 항목 수집을 일반 CLI·Web에 연결했다. 저장된 원응답을 먼저 정산하고 필요한 대화 요약과 문맥 복원을 거친 뒤, 모델이 명시한 완전한 저장 결과의 후속 시도를 로컬에서 소비한다. 새 페이지가 필요하면 연결을 기다리고 명시 온라인 재열기에서 다음 페이지나 실패 항목만 요청한다. **macOS Node24 신규 183/183·관련 519/519, NAS Linux Node24 신규 183/183·관련 519/519·전체 3,691/3,691 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-result.md) · [사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-usage.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-plan.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-collections-linux-nas-20260908/verification.json). 완전한 저장 결과 안내는 실행 허가가 아니다. 원 부모·원문·영수증·현재 계약과 권한을 다시 검사하며 부모의 실패를 성공으로 바꾸지 않는다. 로컬 후속 소비는 논리 도구 호출 한 번이고 원격 전송은 0회다. 필요한 근거 조회와 새 모델 호출은 기존 예산을 따른다. 문맥 선택은 실제 한도에 들어오는 선택 항목 일부를 유지하도록 수렴을 고쳤다. 현재 허용된 원근거의 최초 카드·본문 조회만 준비 진전으로 인정한다. 동일 내용·파생 복사본의 반복 조회는 기본 무진전 한도 3을 초기화하지 않으며 준비 진전은 새 사실이나 목표 완료가 아니다. 다음 필수 단위는 collection 페이지별 전송 후 원응답 보관·known usage 정산과 현재 본문 채택의 분리다. 기존 단순 읽기의 보관 인수와 구분하며 아직 별도 구현·검증이 필요하다. 원문 재검증·조회 비용 개선도 측정과 경합 검증을 거쳐 진행한다. [필수 후속](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-plan.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태다. 실제 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이며 native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

실제 일반 입구는 CLI 2사례와 localhost HTTP 3사례다. SQLite/file-journal CLI는 SIGKILL 뒤 서버 없는 재개·실제 session compact·명시 저장 소비·공개된 근거 ID 조회·최종 답변을 확인했다. HTTP 두 저장 방식은 비최종 페이지 SIGKILL 뒤 반복 대기와 다음 온라인 페이지를, SQLite 한 사례는 정상 채택된 partial batch의 실패 항목만 재시도를 확인했다. 마지막 사례는 강제 종료나 file-journal 인수로 확대하지 않는다. 반복 명령은 원문·시도·예산·대화를 중복하지 않으며 HTTP 시험은 브라우저 렌더링 시험이 아니다.

collectionBindings는 기존 bindings와 별도 배열로 제공한다. 같은 endpoint/provider의 혼합 등록은 하나의 발견 session을 공유하며 저장 전용 등록은 config 없이 origin을 명시한다. 현재 host가 계약·정책을 주입하며 HTTP나 사용자 원문으로 실행 파일·권한을 받지 않는다. 원문·본문 사용 권한과 호출 가능성은 별개다. 기존 단순 읽기 예제와 당시 수치는 아래에 보존했다.

## 이전 단순 읽기·보관·offline 사용법과 API 예제

<!-- C05-MCP-OFFLINE-FINAL-PROOF: 28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9 -->
**MCP 서버 없는 일반 재개와 명시 온라인 재열기**를 연결했다. 신뢰된 시작 프로그램이 저장 전용 모드를 명시하면 MCP 서버를 시작하거나 발견하지 않고 같은 담당의 저장 응답과 영수증을 검증해 일반 CLI·Web에서 재개한다. 새 읽기가 필요하면 연결을 기다리고, 같은 담당을 온라인으로 다시 열어 기존 목표를 이어 실행한다. **macOS Node24 신규 145/145·관련 847/847, NAS Linux Node24 신규 145/145·관련 847/847·전체 3,601/3,601 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [저장 전용 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-usage.md) · [MCP 호스트 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json). 저장 계약과 새 호출 가능성을 구분하며 원문·현재 권한·목표·출처 검사는 유지한다. raw 파일만 있거나 intent 영수증만 있으면 응답 영수증을 만들거나 재전송하지 않는다. 보관·사용량 정산 성공은 본문 채택이나 업무 완료의 허가가 아니다. 자동 연결 실패 fallback과 모델까지 포함한 무네트워크 실행을 뜻하지 않는다. 다음 후보는 collection(여러 항목 수집)·페이지·대기의 일반 입구 연결이다. 검토 메모를 준비했으며 제품은 미착수다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도 측정·인수한다. [후속 연결 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-notes.md) · [전체 MCP 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

C01 SQLite/file-journal에서 실제 로컬 stdio peer를 닫은 뒤 별도 CLI 자식 프로세스 2사례와 실제 localhost HTTP 4사례를 확인했다. HTTP는 저장 응답 복구·재열기와 미호출 작업의 연결 대기→명시 온라인 재열기를 각각 두 저장 방식에서 확인했다. 온라인 전환은 원 work/session/goal/plan/task를 보존하고 tools/call 한 번으로 완료하며, 같은 명령 재전송은 추가 호출·정산·답변을 만들지 않는다. 실제 브라우저 렌더링 시험은 아니다.

온라인 등록은 기존 config 방식, 저장 전용 등록은 mode: 'stored_only'와 origin(endpointId·protocolVersion)을 사용한다. 같은 binding·정확한 버전과 현재 정책을 호스트가 제공해야 한다. 등록 객체를 나중에 바꾸거나 CLI/HTTP가 원격 계약을 주입하지 않는다. 서버를 다시 사용할 때는 현재 앱을 닫고 online 호스트로 같은 담당을 연다.

서버 발견이 필요해 재개할 수 없다는 아래 문장은 이전 온라인 전용 시작 경로의 역사다. 현재 저장 전용 모드는 발견·새 호출 없이 증명을 읽으며, 정상 수신·채택/정산 → 필요한 compact → 문맥 복원 → 이후 작업의 순서를 유지한다. 보관 권한과 현재 본문 권한, 원 입력 접근 거절, 원문 파일만 남은 중단의 제한은 그대로다. 아래 기존 등록 API 예제와 과거 수치는 보존했다.

## 이전 온라인 등록·보관 검증 기록과 기존 API 예제

<!-- C05-MCP-CUSTODY-FINAL-PROOF: 3783a0a1f5ba3a4eea5a9a2231d5def3dbaf44a163c4444b8e559642283e463c -->
**MCP 전송 후 권한 변경의 원응답 보관·사용량 정산**을 연결했다. 허용한 읽기를 보낸 뒤 권한이 바뀌어도, 실제 받은 원응답과 입증된 사용량을 원 담당·원 시도에 보관하고 정산한다. 본문을 지금 보여 주거나 근거로 채택하는 권한은 따로 검사한다. 정상 저장 결과의 수신·채택 또는 거절/정산 → 필요한 compact(긴 대화 정리) → 문맥 체크포인트 복원 → 이후 작업 순서를 유지하며, 일반 run 진입에서 사용량 보완을 한 번의 유한한 과정으로 연결했다. **macOS Node24 신규 121/121·관련 775/775, NAS Linux Node24 신규 121/121·관련 775/775·전체 3,544/3,544 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-plan.md) · [MCP 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json). 보관 원문은 SDK가 해석한 MCP 응답 JSON이다. sent는 로컬 전송 시도 표시이며 원격 실행·성공·과금의 증명이 아니다. 입증되지 않은 측정값은 unknown(null)으로 남긴다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 영수증을 만들어 복구하거나 자동 재전송하지 않는다. 원문·원 영수증·owner·자료 세대를 유지하며 현재 본문 검사를 느슨하게 하지 않는다. 서버를 다시 발견(tools/list)하는 현재 시작 경로는 유지되므로 서버 없는 재개는 아직 아니다. 다음 구현은 MCP 서버 없는 일반 CLI·Web 재개이며 설계 확정·제품 미착수다. 호스트가 명시한 저장 전용 도구에서 기존 보관·본문 검증을 재사용하고, 새 연결이 필요한 작업은 기다리며 다른 독립 작업은 진행하는 경계를 연결한다. 일반 입구의 collection(여러 항목 수집)·페이지·대기 복구와 문맥 조회 비용 개선도 후속이며, 원문·권한의 현재성 검사를 유지한다. [다음 구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [사전 검토 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-notes.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

기존 createMcpHostTools 등록과 runAgentTurnCli/openAgentWeb 입구를 그대로 사용한다. 새 공개 recovery 명령이나 사용자 원문·HTTP가 지정하는 보관 권한은 추가하지 않았다. 실제 서버 설정은 호스트가 정한다.

공개된 원 사용자 요청을 그대로 읽을 수 있는 재개는 보호 raw를 문맥에서 제외한 유효한 blocked 체크포인트를 반환할 수 있다. 이는 업무 완료나 보호 본문 채택이 아니다. 원 사용자 요청 자체를 읽을 수 없으면 사용량 정산 뒤에도 session_current_input_unavailable로 거절한다. GET·상태 조회·SSE는 읽기만 하며 정산은 명시 실행·명령에 연결한다.

본문 없는 restoreUsage 증명은 원 호출 측정값만 정산한다. unknown→known은 입증된 값으로 한 번 보완하며 known→unknown은 기존 값을 유지한다. 상충하는 known 값은 합산하지 않고 거절한다. 과거 모호한 failure.sent=true를 실제 원격 실행 1회로 격상하지 않는다. 사용량만 정산한 미수신 시도는 정확한 정산 영수증까지 확인한 경우 정상 restoreResult 검사로 돌아갈 수 있으나, 이미 실패·거절된 결과는 되살리지 않는다.

같은 실행 측정값과 일치하는 기존 정산 이벤트·영수증을 확인한 시도는 정산 선별에서 raw 재조회를 생략한다. 정상 null 필드가 남았다는 이유로 반복 정산하지 않는다. 이 생략은 본문·문맥의 별도 원문 검증을 없애지 않으며 성능 개선 수치는 측정하지 않았다.

프로필 종료는 새 실행을 막고 모델·도구 연결을 닫은 뒤 기존 pending 수신을 기본 최대 5초 마무리하고 stores를 닫는다. 이 5초는 실행기 pending 마감이며 임의 호스트 close까지 포함한 전체 종료 상한이 아니다. 취소 신호와 DB commit의 원자화, 전원 손실 내구성을 보장하지 않는다.

아래 등록 예제는 바꾸지 않았다. 이전 검증 수치와 다음 계획 표시는 당시 기록이며, 현재 보관·정산과 남은 범위는 이 상단과 결과 문서를 따른다.

## 기존 등록 방법과 이전 검증 기록

<!-- C05-MCP-RECOVERY-NARRATIVE-PROOF: f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960 -->

2026-09-07 · **기존 MCP 등록 API에 단순 저장 응답 복구를 연결했다. macOS Node24 신규 55/55·관련 421/421, NAS Linux Node24 신규 55/55·관련 421/421·전체 3,423/3,423 통과.** [복구 확정 증거](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json)와 [복구 결과](C05-mcp-response-recovery-result.md)를 기준으로 아래 재개 범위를 갱신했다. C05 전체와 C01–C10 목표는 미완료다. 실제 모델/API 시험은 중단 상태이며 합성 모델·로컬 MCP peer의 계약 인수를 실제 모델 품질이나 사내 서비스 운영 검증으로 해석하지 않는다. native Windows runtime/file 연결·검증, PostgreSQL 및 설치·운영도 남아 있다.

최초 MCP 연결 당시 검증 기록(아래 “현재”는 당시 상태): 2026-09-07 · **구현과 지원 POSIX 검증을 완료한 연결의 사용·개념 문서다.** 현재 로컬 Node 24의 신규 30개 시험이 통과했다. [실행 기록](../../runtime/evidence/C05-mcp-new2.json)과 [원로그](../../runtime/evidence/C05-mcp-new2.log)는 같은 source/build에서의 결과다. 관련 회귀 572개와 build/core/계층 검사도 통과했다. 같은 소스의 NAS Linux 전체 3,368/3,368와 필수8단계·원로그 회수·정리도 완료했으며, C05 전체 완료를 뜻하지 않는다. 이 문서 작성에서는 코드나 시험을 실행하지 않았다.

MCP 연결은 담당을 실행하는 **호스트 프로그램**에 등록한다. 호스트는 에이전트 본체를 불러오고 회사 정책·도구·모델 연결을 공급하는 신뢰된 시작 코드다. 사용자는 기존 CLI 또는 Web에서 요청하고, 본체는 기존 계획·도구 호출·증거·답변 흐름을 사용한다. MCP를 위해 다른 대화창이나 업무 DB를 만들지 않는다.

## 무엇을 등록하는가

[createMcpHostTools](../../runtime/src/presentation/mcp-host-tools.ts)의 실제 API는 다음과 같다.

```ts
createMcpHostTools({
  config: McpStdioConfig,
  bindings: readonly McpReadBinding[],
  policy: Policy,
  limits: Limits,
}): HostToolRegistration
```

| 항목 | 의미와 현재 경계 |
|---|---|
| `config` | 로컬 MCP 프로세스를 여는 설정이다. `endpointId`, 실행 파일 `command`, 인자 `args`, 작업 디렉터리 `cwd`가 필요하다. 선택적 `env`와 메시지 크기·동시 호출·목록 페이지·시간 한도는 기존 클라이언트가 검사한다. `command`와 `cwd`는 절대 경로다. |
| `bindings` | 호스트가 승인한 원격 도구와 본체의 도구 계약을 연결하는 목록이다. 서버가 발견한 도구를 전부 자동 허용하지 않는다. |
| `policy` | 담당·사용자의 식별자와 허용 도구·자료 라벨·목적지를 정한다. 현재 helper는 읽기 연결이므로 `allowWrites: false`여야 한다. |
| `limits` | 새 업무에 적용할 도구·모델 호출, 토큰, 재계획, 시간 한도다. 프로필을 다시 열어도 기존 업무의 사용량을 초기화하지 않는다. |

`stdio`는 호스트가 연 자식 프로세스의 표준 입출력으로 메시지를 주고받는 방식이다. 현재 helper는 이 방식을 연결한다. MCP HTTP 주소를 받는 별도 전송 helper나 사내 인증 설정 UI가 생긴 것은 아니다. 현재 클라이언트는 고정된 MCP 프로토콜 `2026-07-28`을 사용하므로 실제 서버의 호환성도 별도 확인해야 한다.

한 helper 등록은 **한 endpoint와 한 provider**를 맡는다. 동일 provider의 여러 bindings는 한 번의 발견 결과를 공유한다. 빈 목록, 여러 provider의 혼합, 같은 원격 도구 이름 중복은 거절한다. 같은 등록을 두 담당에서 열면 각각 독립적인 MCP 클라이언트를 소유한다.

## 도구 이름·버전·원자료 변환

`McpReadBinding`은 다음 정보를 담는다.

- `definition`: 본체에서 쓰는 provider·도구 ID·기본 버전·설명·읽기 효과·목적지·라벨·입출력 스키마.
- `remote`: 실제 MCP의 `name`, 입력 스키마, 출력 스키마. 이 helper에서는 출력 스키마도 필요하다.
- `projectorId`, `projectorVersion`, `project(value, task)`: 검증된 원격 응답에서 본체가 쓸 출력과 관측 사실을 만드는 호스트 함수와 그 버전.

**provider와 도구 ID의 이름 공간이 맞아야 한다.** 예를 들어 provider가 `company`이면 `company.mcp.document.read`가 유효한 형태다. provider를 `company-mcp`로 지정하고 같은 ID를 쓰면 일치하지 않아 거절된다. 원격 이름 `documents.read`는 별도로 연결하며 본체의 ID와 같을 필요가 없다. 외부 등록은 `core` provider나 `core.*` ID를 대신할 수 없다.

스키마는 어떤 필드·자료형의 입력과 응답을 허용하는지 정하는 계약이다. projector는 모델에게 실행시키는 코드가 아니다. 호스트가 응답 구조를 확인하고 `output`, `coverage`, `observations`를 반환한다. 관측에는 원출처·계보·원문 위치·관측 시각·사실을 남긴다. 원격 설명이나 응답 속 지시문은 권한이나 본체 지시로 승격하지 않는다.

실제 게시 버전에는 원격 계약·projector 식별자/버전·endpoint·프로토콜의 지문이 붙는다. 기본 버전 `1`은 `1.<24자리 해시>` 같은 형태가 된다. 모델과 계획은 **현재 카탈로그가 제공하는 정확한 버전**을 선택해야 한다. 기본 `1`을 실행 버전으로 고정하지 않는다. projector 동작을 바꿀 때는 호스트가 해당 버전도 바꿔야 하며, 함수 내부의 임의 변경까지 자동 검출하는 소스 코드 지문은 아니다.

등록과 실행 허용은 별개다. `policy.allowedTools`에 도구가 자동 추가되지 않는다. 많은 도구를 선택적으로 찾게 하려면 `core.catalog.search`, `core.catalog.get`도 호스트가 명시적으로 허용한다. 본체의 기존 카탈로그·문맥 선택을 그대로 사용한다. 스킬을 꺼 둔 담당은 호스트 목록에 이름이 있어도 `core.guidance.*`를 사용할 수 없다.

## 호스트 조립 예시

다음은 **구조 예시**다. 이미 검토한 모델 등록표·MCP 실행 설정·binding을 인자로 받는 시작 프로그램을 보여 준다. 코드 조각 자체가 사내 서버나 실제 모델 연결을 제공하지 않는다. import 경로는 runtime 소스에서의 모듈 위치를 나타낸다.

```ts
import type { AgentTurnHost } from './presentation/host-models.js';
import type { AgentExecutionHost } from './presentation/host-tools.js';
import type { McpStdioConfig } from './infrastructure/mcp-stdio-client.js';
import type { McpReadBinding } from './infrastructure/mcp-read-tools.js';
import { createMcpHostTools } from './presentation/mcp-host-tools.js';
import { runAgentTurnCli } from './presentation/agent-turn-cli.js';
import { openAgentWeb } from './presentation/agent-web.js';

export function companyHost(
  models: AgentTurnHost['models'],
  reviewedConfig: McpStdioConfig,
  reviewedBindings: readonly McpReadBinding[],
): AgentExecutionHost {
  return {
    models,
    tools: createMcpHostTools({
      config: reviewedConfig,
      bindings: reviewedBindings,
      policy: {
        tenantId: 'example-company',
        principalId: 'example-reader',
        allowedTools: ['company.mcp.document.read'],
        allowedLabels: ['public'],
        allowedDestinations: ['local'],
        allowWrites: false,
      },
      limits: {
        toolCalls: 30, modelCalls: 16, tokens: 1_000_000,
        replans: 8, wallTimeMs: 3_600_000,
      },
    }),
  };
}

export async function ask(directory: string, host: AgentExecutionHost) {
  await runAgentTurnCli([
    'ask', '--directory', directory, '--provider', 'registered',
    '--message-id', 'request-1', '--text', '허용된 원자료를 확인해 줘.',
  ], host);
}

export async function startWeb(directory: string, host: AgentExecutionHost) {
  return openAgentWeb([
    '--directory', directory, '--provider', 'registered', '--port', '0',
  ], host);
  // 시작 프로그램은 반환된 app의 close()를 자기 종료 절차에 연결한다.
}
```

위 예시의 bindings에는 provider `company`, ID `company.mcp.document.read`인 읽기 계약을 넣고 실제 자료에 맞는 라벨·목적지를 설정한다. 예시의 `public`/`local`을 사내 중요자료에 그대로 붙이라는 뜻이 아니다. 등록된 도구와 모델 목적지는 각각 정책 검사를 받는다.

담당의 기존 `config.json`에서는 `model.profile`만 호스트 `models` 등록표의 정확한 이름과 맞춘다. MCP 실행 파일·환경 변수·projector를 이 문자열로 불러오지 않는다. 기본 실행기에 회사용 호스트가 자동 설치되거나 동적으로 import되는 것도 아니다. 호스트가 위 API의 두 번째 인자로 등록표를 전달해야 하며, 미등록 모델은 오류로 거절된다.

`runAgentTurnCli`를 직접 부를 때 인자는 `ask`부터 시작한다. 실행 파일의 명령 표시와 달리 `chat` 접두사를 추가하지 않는다. 같은 호스트를 사용해 `resume --work ID --session ID`, `status`, `history`를 호출할 수 있다. `resume`은 상태 조회와 달리 미완료 작업을 계속 실행할 수 있다. 같은 담당의 저장소와 대화 ID를 유지해야 이전 문맥을 잇는다.

Web도 동일한 `openAgentTurnProfile` 조립을 사용한다. 브라우저 요청은 원문·요청 ID·실행 모드를 전달하고 기존 인증·Origin·CSRF 검사를 거친다. 실행 파일 경로, 환경 변수, bindings, projector, 권한, provider source를 사용자 원문이나 HTTP의 실행 설정으로 받지 않는다. 원문에 이런 문자열이 있어도 실행 가능한 호스트 설정으로 해석하지 않는다.

등록 모델이 compact도 제공하면 기존 등록 모델 수명을 함께 사용한다. `--provider registered`에 별도 `--compact-provider`를 지정하지 않는다. 세부 모델 계약은 [등록 모델 사용법](C04-registered-model-usage.md)을 따른다. 기본 합성 모델은 정해진 문장·도구만 처리하므로 임의 회사 도구를 이해하는 모델로 간주하지 않는다.

## C01 저장소와 종료의 소유자

프로필은 C01 저장소를 먼저 열고, `HostToolRegistration.open(context, assembly)`에 같은 담당의 보관 포트를 전달한다.

| 전달값 | 역할 |
|---|---|
| `context.agentId/root/scope` | 담당 식별자·설치 디렉터리·업무 범위. |
| `assembly.custody.state` | 기존 업무 상태·dispatch·호출 영수증을 읽고 기록하는 같은 저장소 객체. |
| `assembly.custody.artifacts` | 원응답과 결과 파일을 보관하는 같은 artifact 저장소 객체. |
| `assembly.custody.digester/clock` | 본체와 동일한 지문 계산·시각 포트. |
| `assembly.schemas/signal` | 기존 스키마 검사와 프로필 수명의 취소 신호. |

`custody`는 여기서 원자료와 귀속 증명을 보관하는 기능을 뜻한다. MCP용 DB를 새로 열거나 담당 간 원응답을 한 저장소로 합치지 않는다. 포트 컨테이너는 고정하지만 각 저장소 객체는 본체와 동일하다. `state`에는 영수증을 남길 쓰기 기능도 있으므로 이 인자를 읽기 전용 저장소나 OS 보안 샌드박스라고 부르지 않는다. 모델 factory에는 이 assembly를 전달하지 않는다.

기존 한 인자 도구 factory도 계속 사용할 수 있다. MCP helper에는 assembly가 필요하며 일반 프로필이 공급한다. 사용자가 직접 두 번째 DB나 코어 서비스를 조립할 필요는 없다.

helper는 `tools: []`와 발견용 `providerSources`를 반환한다. 프로필은 기존 `ToolContracts`에 완전한 목록을 게시한 뒤에만 호출자에게 열린 프로필을 돌려준다. `ToolCatalog`도 이 같은 목록을 사용한다. 한 provider를 고정 도구와 source에 나누어 소유하거나 여러 source에 중복 등록하면 거절된다. 발견·목록 검증 실패가 부분 카탈로그나 합성 도구 대체로 성공 처리되지 않는다.

프로필이 **모델 → 도구 → C01 저장소**의 정리 소유자다. 먼저 수명 신호를 취소한 뒤 각 정리를 시도한다. MCP helper는 자신의 클라이언트·peer 프로세스만 닫으며 C01 저장소를 닫지 않는다. 같은 등록을 열어 만든 다른 담당의 클라이언트도 닫지 않는다. CLI는 작업 뒤 프로필을 정리하고, Web의 `app.close()`는 서버 종료 절차 뒤 프로필을 정리한다. 종료는 세션·원문 삭제가 아니다.

단일 오류는 그대로 전달하며 여러 정리 오류는 최초 오류를 cause로 한 `AggregateError`에 함께 남긴다. 목록 실패의 공개 오류명 `provider_listing_failed`는 유지하고 원 source 오류를 cause에 보존한다. 최초 오류와 독립 cleanup 오류를 검사할 수 있지만 모든 잘못된 원격 출력 바이트가 보존된다는 뜻은 아니다. signal 취소와 DB commit을 하나의 원자 연산으로 만들거나, 실행 중 직접 close해도 모든 늦은 응답을 끝까지 정산하는 완전한 drain 보장도 추가하지 않는다.

## 저장한 응답으로 이어가기

정상 읽기는 기존 **dispatch → MCP intent → 원응답 artifact → MCP response 영수증 → 실행기 received → 근거 채택 → 답변** 순서를 따른다. intent는 호출 의도 기록이고, received는 실행기가 결과를 수신한 상태다. 원문은 SDK가 해석한 MCP 응답 JSON이며 전송선의 wire 바이트 녹화가 아니다.

이제 **원응답과 MCP response 영수증이 모두 저장됐지만 received 전 프로그램이 종료된 경우**도 검증된 같은 시도의 결과로 복원한다. 원 dispatch·intent·영수증·실제 원문 바이트와 현재 목표·계획·권한·출처를 대조하며, 원 실행자와 lease(호출 유효 시간)를 바꾸지 않는다. lease 만료만 기록된 시도도 이 증명 범위에서 확인하지만 사용자 취소·명시 실패·새 계획·후속 시도를 옛 결과로 되살리지는 않는다. 이미 received이거나 완료된 경우는 기존의 중복 없는 수신·정산 경로를 유지한다.

재개 순서는 **저장 응답 수신 → 채택 또는 거절·정산 → 필요한 compact → 문맥 체크포인트 → 이후 계획과 실행**이다. compact는 긴 대화를 정리하는 과정이며 원응답 수신을 대신하지 않는다. 복구가 tools/call이나 논리 도구 호출 예산을 추가 소비하지 않고, 이후 새 답변·compact에는 기존 모델 예산과 deadline을 그대로 적용한다.

원문 파일만 있거나 intent만 있고 response 영수증이 없으면 `stored_result_unavailable`, 귀속·현재성 증명을 확인하지 못하면 `stored_result_recovery_failed`로 멈춘다. 자동 재조회로 누락을 숨기지 않는다. 이미 명시적으로 차단된 업무는 원 차단 사유를 유지하며 명시적 재개 뒤 다시 검증한다. 영수증의 관측 시각은 캡처·트랜잭션 준비 시각이지 물리 commit 완료나 재시작 간 단조 시계의 증명이 아니다.

**현재 재접속은 offline이 아니다.** 프로필을 새로 열 때마다 새 MCP 클라이언트가 서버와 연결하고 `tools/list`로 계약을 발견한다. 저장 결과의 재표시에서 `tools/call=0`이어도 서버 시작·발견까지 0인 것은 아니다. 서버가 없으면 일반 프로필 열기가 실패할 수 있다. endpoint·프로토콜·원격 계약·projector 버전이 바뀌어 옛 증명을 검증할 수 없으면 옛 원자료를 새 조회 결과로 몰래 바꾸지 않는다.

남은 범위는 [전송 뒤 권한 변경의 원응답·보고 사용량 보존](C05-mcp-sent-authority-plan.md), 서버 발견 없는 일반 CLI/Web 재개, 일반 입구의 페이지 수집·대기·재조정 연결이다. 전송된 뒤 Promise가 먼저 거절돼 실제 응답 값이 없는 경우를 복원 가능하다고 주장하지 않는다. [MCP 후속 순서](C05-mcp-host-plan.md)를 유지하며 기존 collection·wait 구현과 일반 입구 인수 완료를 구분한다.

## 실제로 확인한 예제와 남은 검증

[합성 호스트 helper](../../runtime/src/tests/mcp-agent-profile-helper.ts)는 명시된 문장 `[합성 MCP] company.mcp.document.read로 good 자료를 읽고 값을 알려 줘.`만 처리한다. 로컬 stdio peer의 값을 47로 설정한 시험에서는 실제 원응답·투영 근거를 거쳐 `[합성 MCP 결과] 원자료 값은 47입니다.`를 반환했다. 응답을 의미적으로 이해한 실제 모델 시험이 아니라 고정 규칙·구조화 전송 대역의 계약 인수다.

최초 연결 당시 신규 로컬 30개 묶음에는 [프로필 인수](../../runtime/src/tests/mcp-agent-profile.test.ts), [별도 CLI 프로세스와 localhost HTTP 인수](../../runtime/src/tests/mcp-agent-entry.test.ts), [등록 helper](../../runtime/src/tests/mcp-host-tools.test.ts), [provider source 경계](../../runtime/src/tests/host-provider-tools.test.ts)가 포함된다. C01 SQLite/file-journal, 원응답·영수증·버전 선택, received/완료 뒤 재접속, 두 담당의 원본 격리, 실제 peer 종료, source·discovery·close 실패를 검사했다. HTTP 시험은 실제 브라우저 화면 관측과 구분한다.

실제 사내 MCP·인증·SIEM/EDR·Knox 및 실제 모델/API 시험은 수행하지 않았다. 네이티브 Windows 런타임/파일 연결의 미구현·미검증, PostgreSQL, 설치 배포도 이 결과로 완료되지 않는다. [최초 연결 결과](C05-mcp-host-result.md)는 당시 기록이며, [현재 복구 결과](C05-mcp-response-recovery-result.md)에 이번 로컬·Linux 검증과 한계를 구분해 기록한다.
