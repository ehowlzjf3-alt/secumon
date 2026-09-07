# C03 D2: 편집 초안을 개인 기억에 명시적으로 적용

2026-09-07 · D2 지원 POSIX 검증 완료 · C03 전체 진행 중

<!-- C03-D2-FINAL-PROOF: 60d7e65ea1dd57ebbb0ce5fb3268f259199e07ef36a034764b20669566c3037a -->

문서 저장을 선택한 담당에서 초안 생성 → 외부 편집기로 파일 편집 → 명시 적용 → 원문·기억 상태 확인 → 같은 ID로 재개하는 CLI/Web 흐름을 연결했다. 기본은 SQLite다. 같은 최종 소스의 NAS 실제 Linux에서 **전체 3,000/3,000·관련 306/306**을 통과했고, 원로그 8개 회수·관측 가능한 전용 시험 프로세스 0·SSH 종료를 확인했다. 다음은 D3의 기존 SQLite 개인 기억 명시 이관이며 아직 구현·검증하지 않았다. PostgreSQL·Windows 연결·문서 읽기 효율·실제 모델 품질은 남아 있고 C03 전체와 전체 goal은 진행 중이다. [최종 검증 근거](../../runtime/evidence/C03-drafts-verification.json) · [다음 D3 계획](C03-personal-memory-migration-plan.md)

## 사용자가 진행하는 한 흐름

1. **새 초안 만들기:** 개인 기억 카드에서 `문서 초안 만들기`를 선택하거나 CLI에 기억 ID와 새 `draftId`를 전달한다. 현재 기억의 제목·본문을 복사한 편집 파일 경로와 기준 버전을 반환한다. 이때 대화 원문이나 기억 버전은 추가하지 않는다.
2. **파일 편집:** 반환된 `.md` 파일을 사용자 편집기에서 고친다. 편집기가 파일을 임시 파일로 쓴 뒤 이름을 바꾸는 저장 방식도 지원한다. 저장만으로 기억이 바뀌지는 않는다.
3. **명시 적용:** 현재 선택한 세션·업무에 적용 이유와 `applyId`를 전달한다. 읽어 둔 기준 기억과 업무의 목표 버전이 아직 맞는지 검사한 뒤, 적용할 내용을 고정한다.
4. **상태 확인:** 사용자 원문이 반영됐는지, 해당 요청의 기억 정정이 완료됐는지, 지금 기억은 몇 번째 버전인지 따로 확인한다. 응답 오류나 연결 끊김만으로 미반영이라고 판단하지 않는다.
5. **같은 적용 재개:** 고정된 요청을 다시 진행한다. 원문과 기억 정정이 이미 끝났다면 기존 결과를 확인하며 중복으로 만들지 않는다. 이후 새로 편집하려면 명시적으로 새 초안을 만든다.

`draftId`는 편집 초안의 식별자, `applyId`는 한 번의 적용 요청을 식별하는 UUID다. 같은 ID를 다시 보낼 때는 같은 내용을 뜻해야 한다. 실패할 때마다 새 ID를 자동 발급하지 않는다. `revision`은 기억의 변경 순번이고, `expectedGoalRevision`은 적용하려는 업무 목표의 예상 변경 순번이다.

SQLite는 계속 기본값이다. 이 흐름은 새 담당 등록 때 `secumon-agent init --personal-memory documents`를 선택한 경우에만 제공한다. 문서 선택에서도 업무 기억은 기존 SQLite 경로를 사용한다. 기존 SQLite 담당을 자동 전환하거나 데이터를 이관하지 않으며, 문서 저장소 오류를 새 SQLite 정본 생성으로 대체하지 않는다. [D1 저장 방식 연결](C03-document-memory-result.md)

## 실제 저장 구조와 편집 형식

초안은 정본인 `memory/documents`와 분리된다. 구현의 실제 배치는 다음처럼 사용자 소유 범위별 폴더 안에 파일을 나란히 두는 구조다.

```text
<담당 디렉터리>/memory/
  documents/                         개인 기억 정본과 게시 확인 기록
  drafts/
    <조직·담당·사용자 범위의 SHA-256>/
      <draftId>.origin.json          초안의 출발점
      <draftId>.md                   사용자가 편집하는 파일
      <applyId>.intent.json          적용할 내용을 고정한 요청
      .secumon-init-<UUID>.pending   게시 도중 남을 수 있는 후보
```

폴더 이름의 지문만 신뢰하지 않고 파일 안의 조직·담당·사용자 및 저장소 ID도 대조한다. 초안마다 하위 폴더를 만들거나 별도 완료 파일을 쓰지 않는다. 완료 상태는 기존 사용자 원문 영수증과 기억 정정 영수증을 조회해 계산한다. 여기서 영수증은 요청의 처리 여부를 재확인하는 저장 기록이다.

| 파일 | 역할과 변경 규칙 |
|---|---|
| `origin.json` | 출발 기억 ID·버전·제목·본문 지문과 소유 범위를 보존한다. 같은 ID로 다른 출발점을 덮어쓰지 않는다. |
| `.md` | 제목과 본문을 편집한다. 정본 파일을 직접 수정하는 경로가 아니다. |
| `intent.json` | 적용 ID, 편집 내용, 이유, 대상 세션·업무·목표 버전과 후속 명령 ID를 고정한다. 같은 적용 ID의 다른 내용을 거절한다. |

편집 파일의 제한된 형식은 다음과 같다. 제목은 JSON 문자열이며, 일반 YAML의 임의 기능이나 외부 파일 참조·실행 문법을 해석하지 않는다.

```markdown
---
secumon-memory-draft: 1
title: "보고서 표현"
---
결론을 먼저 적고 근거를 이어서 설명한다.
```

UTF-8, 제목·본문 길이, 형식, 소유자·권한·일반 파일 여부를 검사한다. 현재 한 소유 범위의 정식 파일은 최대 4,096개·64MiB, 파일별 최대 256KiB이며 게시 후보에는 별도 한도를 적용한다. 자동 이력 정리 기능은 없다. 심볼릭 링크·외부 하드링크·특수 파일·안전하지 않은 권한은 거절하고 임의로 권한을 고치지 않는다. [파일 어댑터](../../runtime/src/infrastructure/personal-memory-drafts.ts)

## 원문 반영과 기억 정정을 나누는 이유

실제 연결 순서는 **편집 파일 검사 → 적용 요청 고정 → 해당 사용자 원문 반영 → 같은 원문을 출처로 기억 정정 → 두 처리 기록 조회**다. 원문 저장과 기억 저장은 하나의 원자적 트랜잭션이 아니므로 중간 상태를 숨기지 않는다.

원문에는 적용 ID에서 유도한 `draft-source:…`, 기억 정정에는 `draft-memory:…`라는 서로 다른 명령 ID를 사용한다. `SessionService.inputOnly`는 지정한 원문만 적용하며, 다른 대기 입력이나 업무를 대신 실행하지 않는다. 이 명령으로 일반 계획·도구·컴팩트를 자동 호출하지 않는다. 앞선 입력이 아직 대기 중이면 먼저 처리해야 할 입력을 건너뛰지 않는다.

기억 정정은 초안의 기준 버전을 다시 확인한다. 원문 반영 뒤 다른 요청이 기억을 먼저 바꿨다면 정정이 충돌할 수 있다. 이미 받은 원문은 보존하고, 경쟁 요청의 최신 버전을 이번 요청의 성공으로 표시하거나 기준 버전을 자동 갱신하지 않는다. 초안 만들기와 원문 반영이 기억 정정 완료를 대신하지 않는다.

기억을 고치면 기존 선택·모델 입력의 오래된 기억 재사용은 현재성 검사에서 차단된다. 새 기억을 실제 문맥에 쓰려면 최신 버전을 다시 회상·선택한다. 이번 초안 명령이 선택을 자동 교체하거나 기존 검토 의무를 일괄 해제하지는 않는다. [공통 적용 흐름](../../runtime/src/presentation/local-memory-drafts.ts) · [원문 처리](../../runtime/src/application/session-service.ts) · [기억 정정·상태](../../runtime/src/application/knowledge-service.ts)

## 상태와 재개에서 구분하는 값

| `stage` | 의미 |
|---|---|
| `prepared` | 적용 요청이 고정됐고, 이 요청의 사용자 원문은 아직 수신되지 않았다. |
| `source_pending` | 이 요청의 원문 영수증은 있으나 적용이 대기 중이다. |
| `source_rejected` | 이 요청의 원문 적용이 거절됐다. 기억 정정 성공으로 표시하지 않는다. |
| `memory_pending` | 사용자 원문은 적용됐지만 이 요청의 기억 정정 완료 기록이 없다. 경쟁 정정으로 충돌한 경우도 여기에 남을 수 있다. |
| `complete` | 이 요청의 기억 정정 완료 기록이 있다. 현재 기억의 유효 상태와는 별도로 표시한다. |
| `unchanged` | 제목·본문이 기준 기억과 같아 원문과 새 기억 버전을 추가하지 않았다. |

`sourceStatus`는 원문의 `not_received / pending / applied / rejected`를 따로 표시한다. 앞선 입력 때문에 이번 원문을 받기 전에 중단되면 오류는 `session_input_pending`이지만 이번 요청의 상태는 `prepared / not_received`일 수 있다. 모든 대기를 `source_pending`으로 뭉개지 않는다.

`appliedRevision`은 **이 적용 ID가 만든 원래 버전**, `currentRevision/currentStatus`는 **현재 기억의 버전과 상태**다. 예를 들어 이번 요청이 v2를 만들고 나중에 v3에서 잊기가 적용됐다면 `appliedRevision=2`, `currentRevision=3`, `currentStatus=deleted`로 구분한다. v2의 중복 요청을 다시 받았다고 v3을 이번 요청의 결과로 돌려주거나 v2를 되살리지 않는다. 현재 값을 권한상 확인할 수 없는 경우에는 `null`이며 현재 활성 기억이 있다는 뜻이 아니다.

상태 조회는 새 원문·기억 버전을 만들지 않는다. 과거 요청의 완료 기록을 확인하는 것과 그 기억 본문을 지금 회상할 권한·출처가 유효한지는 별도 검사다. 과거 완료 표시가 현재 본문 사용을 허용하지 않는다.

처음 적용은 현재 편집 파일을 읽지만, **재개는 저장된 적용 요청의 내용**을 사용한다. 첫 적용 뒤 `.md`를 다시 고쳤다면 같은 적용의 재개에 새 편집 내용을 섞지 않는다. 해당 `.md`가 사라져도 고정 요청을 재개할 수 있지만, 남아 있는 소유 범위 안의 안전하지 않은 파일은 계속 거절한다. 파일 게시·동기화 실패는 원인과 게시 가능성을 보존한다. 오류 응답을 받았을 때는 같은 ID의 상태를 먼저 확인하며, 응답 실패를 부작용이 없었다는 증거로 삼지 않는다. [공개 상태 계약](../../runtime/src/application/personal-memory-draft-contracts.ts)

## CLI와 Web에서의 표시

| 작업 | CLI 명령 | Web |
|---|---|---|
| 초안 생성 | `memory-draft-create --memory-id ID --draft-id UUID` | 기억 카드의 `문서 초안 만들기` |
| 명시 적용 | `memory-draft-apply <work-id> --draft-id UUID --apply-id UUID --goal-revision N --reason 이유 --session ID` | 경로·ID·이유를 확인하고 `현재 업무에 명시 적용` |
| 상태 조회 | `memory-draft-status --apply-id UUID --session ID` | 적용 ID의 `상태 확인` |
| 같은 요청 재개 | `memory-draft-resume --apply-id UUID --session ID` | `같은 적용 재개` |

설치 진입점에서는 `secumon-agent work` 뒤에 위 명령과 대상 담당 디렉터리 옵션을 사용한다. 초안 생성 외에는 기존 세션을 명시한다. Web은 선택한 세션과 요청의 세션이 같은지 검사하며, 공통 처리층이 저장된 업무·사용자·담당 소유권을 확인한다. 읽기 권한만 가진 호출자는 상태 조회는 가능하지만 생성·적용·재개는 거절된다.

Web은 기억 관리 영역 한 곳에서 경로·ID·상태를 갱신한다. 관리 알림을 채팅 말풍선으로 누적하지 않고, 실제 반영된 사용자 원문만 대화 이력에 남긴다. 실패 후 같은 ID를 유지하며 완료 뒤 사용자가 새 초안을 요청할 때 새 ID를 만든다. SQLite 담당에는 버튼을 숨기고 서버도 해당 기능을 거절한다. HTTP는 자유 파일 경로·임의 소유자·편집 본문을 입력받지 않는다. 기존 Host/Origin·세션·CSRF 검사를 재사용한다.

원문 변경으로 기존 업무의 파생 조회가 오래된 상태가 되더라도, 소유권이 확인된 적용 상태·재개 경로를 같은 이유로 막지 않는다. 빌드된 CLI 진입점과 실제 HTTP 왕복은 시험했지만, 이번 D2의 브라우저 렌더링·사용자 편집기 UI 자동화는 실행하지 않았다. [Web 회귀](../../runtime/src/tests/memory-draft-web.test.ts) · [CLI 회귀](../../runtime/src/tests/personal-memory-draft-cli.test.ts)

## 최종 검증과 초기화 진단

| 검증 | 확정 값 |
|---|---|
| 최종 macOS 관련 시험 | 306/306; 전체 시험은 별도 실행하지 않음 |
| NAS 실제 Linux | 전체 3,000/3,000, 관련 306/306; 실패·취소·생략 0 |
| NAS 빌드·코어·구조·fixture | 필수 7단계 통과, 안쪽 계층 144파일·위반 0 |
| 원본 회수·환경 정리 | 8개 회수 근거의 해시 대조, 관측 가능한 전용 프로세스 0·SSH 종료 |
| CLI/Web | 실제 CLI 및 HTTP 회귀; 이번 D2 브라우저 렌더링 미실행 |
| 안내 HTML | 정적 JSON·스크립트·참조 검사만 수행. file URL 정책 차단을 우회하지 않음 |
| 실제 모델/API | 중단 상태 유지; 합성 구조 시험과 모델 의미 품질은 구분 |

최종 `sourceDigest=3fc910d23cc423708a8fd97feb6244c1df2dacf048e7e202e6502822e2f2fc42`, `filesDigest=115d241665f123c7fe720d64576bf0fa94b64de894536978bd4996a6a9c58cc5`, `fileCount=1380`. NAS 종료 2026-09-07T02:56:35.548Z. [최종 검증 근거](../../runtime/evidence/C03-drafts-verification.json). 로컬 선행 실행은 아래 역사적 기록의 각 소스 지문에 해당하며 최종 NAS 소스로 소급하지 않는다.

**초기화 진단의 최종 분류: `bounded_limitation`.** 다음 내용은 최종 증거 파일에 루트가 확정한 결론을 그대로 인용한다.

> build3의 첫 관련 시험(target2)에서 기존 concurrent CLI first storage opens(SQLite) 4개 중 1개가 agent_storage_path_unsafe로 실패했다. 정확한 throw 원인은 미확정이다. 독립 API 10묶음·40 worker와 원 CLI 경로를 관측한 관련 재시험 target3(299/299)에서는 재현하지 못했다. 원인 추측으로 파일·소유권 검사를 완화하거나 초기화 코드를 변경하지 않았다. 이 비결정적 macOS 초기화 실패는 미해결 관측으로 남기며 재발 시 원 stack/메타데이터를 확인한다.

진단 근거: [C03-drafts-owner-open-diagnostic.mjs](../../runtime/evidence/C03-drafts-owner-open-diagnostic.mjs) · [C03-drafts-owner-open-diagnostic1.json](../../runtime/evidence/C03-drafts-owner-open-diagnostic1.json) · [C03-drafts-owner-open-diagnostic1.stderr.log](../../runtime/evidence/C03-drafts-owner-open-diagnostic1.stderr.log) · [C03-drafts-owner-open-diagnostic2.json](../../runtime/evidence/C03-drafts-owner-open-diagnostic2.json) · [C03-drafts-owner-open-diagnostic2.stderr.log](../../runtime/evidence/C03-drafts-owner-open-diagnostic2.stderr.log) · [C03-drafts-owner-cli-trace.mjs](../../runtime/evidence/C03-drafts-owner-cli-trace.mjs). `bounded_limitation`으로 기록된 경우 제한을 남긴 것이며 해당 원인이 수정·입증됐다는 의미가 아니다.

build2의 로컬 관련 **295/295**는 중간 소스의 확인값이다. 첫 NAS 관련 시험은 **294/295**로 실패했으며 같은 apply ID의 두 프로세스가 사용자 원문을 검증하는 동안 업무 revision이 경합한 `knowledge_contention`이었다. 이후 build3의 로컬 target2는 **298/299**로 실패했고 기존 첫 초기화 경계의 오류를 별도로 조사했다. 공개 API를 통한 제한된 **40워커** 진단에서는 재현되지 않았으나, 미재현을 최초 실패의 해소나 원인 규명으로 간주하지 않는다.

**세 번째 NAS 관련 시험과 수정:** 세 번째 NAS 관련시험은297/299로 실패했다. 원 등록 오류의 중첩 cause와 writer 대기의 자식 오류는 원로그에 없어 두 실패의 유일한 원인을 단정하지 않는다. 별도 고정 재현에서는 정상 canonical hardlink 게시 후 낡은 pending-only 목록으로 owner와 namespace를 읽으면 unsafe/read가 발생함을 각각 확인했다. 공통 읽기 경계는 같은 checked 디렉터리의 제한된 이름 목록이 실제 달라질 때만 원 cause를 보존한 changed/read로 전체 재검증한다. 링크·소유자 허용 조건과 재시도 상한은 유지했다. 자식 IPC/조기 종료의 원 stderr 진단도 보강했고, 신규7개 회귀를 포함한 로컬306/306·최종NAS관련306/306·전체3000/3000을 확인했다. [진단·재현 기록](../../runtime/evidence/C03-drafts-native-attempt3-diagnosis.json).

**후속 전체 시험의 MCP 정체:** NAS 전체 attempt2의 MCP read-tools 파일은 17개 자연 완료 뒤 약336초 정체하여 정확한 자식 PID를 진단용 SIGTERM으로 종료했다. 전체2982/2983·실패1을 보존했다. 같은 build3 단독 관측시험은28/28로 자연 완료했다. 이후 문서 목록 경합을 수정한 build4의 최종 NAS 전체3000/3000·관련306/306도 통과했으며 MCP 종료 시 미완료 phase/FS는 없었다. 원 MCP 정체 원인은 여전히 미확정이다. MCP/SDK 코드를 추측으로 수정하지 않았고, 관측 preload의 타이밍 영향과 상세 로그 한도를 유지해 기록한다. [진단·원기록](../../runtime/evidence/C03-drafts-mcp-diagnosis.json). 자연 assertion 실패와 진단용 프로세스 종료를 구분한다.

[중간 로컬 원로그](../../runtime/evidence/C03-drafts-target1.log) · [첫 NAS 실패](../../runtime/evidence/C03-drafts-linux-nas-20260907/attempt-1/drafts-targeted.log) · [build3 target2](../../runtime/evidence/C03-drafts-target2.log) · [진단 1](../../runtime/evidence/C03-drafts-owner-open-diagnostic1.json) · [진단 2](../../runtime/evidence/C03-drafts-owner-open-diagnostic2.json). 후속 발견·수정·재현의 상세 이력은 최종 증거의 `priorAttempts`와 `initializationDiagnosis`에 보존하며, 최초 실패 위치가 미확정인 경우 더 구체적인 원인으로 바꾸어 서술하지 않는다.

## 구현 중간의 로컬 검증 기록

아래 값은 build2 시점 기록이다. 현재 완료 여부는 위 최종 검증을 기준으로 한다.

| 검증 | 현재 확인값 |
|---|---|
| 로컬 코어 타입 검사 | `typecheck:core` 통과. [로그](../../runtime/evidence/C03-drafts-core1.log) |
| 로컬 구조 검사 | 안쪽 계층 144파일 검사, 위반 0. **144는 시험 개수가 아니다.** [로그](../../runtime/evidence/C03-drafts-architecture1.log) |
| 로컬 전체 빌드 | 두 번째 빌드 통과. [로그](../../runtime/evidence/C03-drafts-build2.log) · [빌드 지문](../../runtime/evidence/C03-drafts-build2-manifest.json) |
| 로컬 관련 회귀 | 33개 시험 파일의 295/295 통과, 실패·취소·생략 0. 기존 설정·기억·세션 회귀를 포함하며 전부 신규 시험이 아니다. [원 로그](../../runtime/evidence/C03-drafts-target1.log) · [대상 목록](../../runtime/evidence/C03-drafts-target1-files.json) · [결과](../../runtime/evidence/C03-drafts-target1-result.json) |
| 당시 NAS 상태 | build2 직후 진행 중이었으며 이후 첫 관련 시험은 294/295로 실패했다. 최종 결과와 진단은 위에서 별도 확인한다. |
| 실제 모델/API | 호출하지 않았다. 기억의 자연어 의미 품질을 검증한 결과가 아니다. |

위 로컬 빌드와 관련 시험의 고정 지문은 `sourceDigest=dfc0d60ed28be785ee58f9c2ca4280683c905c415d2b797ea7cd49f180b25da6`, `filesDigest=97f8caccdbdbfc69309f22a8fc25ab94ea2d15a10ed44c94b51fdec65aa31c2d`, `fileCount=1377`이다. 관련 시험 종료 시각은 `2026-09-07T01:22:33.763Z`다. 코어·구조 검사는 각각의 선행 검사 기록이며 최종 NAS 결과로 바꾸어 해석하지 않는다.

첫 빌드는 편집 파일 조회 결과의 `Buffer | undefined` 타입 좁히기 한 건으로 실패했다. 수정 후 두 번째 빌드와 관련 시험을 통과했으며, [첫 실패 로그](../../runtime/evidence/C03-drafts-build1.log)를 보존했다. D1의 Linux 전체 2,941/2,941·관련 199/199은 이전 단위의 근거이고 이번 D2 검증 수치와 섞지 않는다.

이번 관련 시험은 두 실행 상태 저장 방식에서의 원문 한 번·정정 한 번, 정정 뒤 실제 문맥의 오래된 기억 거절과 최신 재회상, 변경 없음, 이전 완료 버전과 현재 잊기 상태의 구분, 권한·세션·기준 버전 거절, 원문만 반영된 부분 진행, 실제 프로세스 SIGKILL 후 재개, 두 프로세스의 같은 요청 경합, 파일 형식·링크·한도·게시 오류를 포함한다. SIGKILL은 실제 프로세스 중단 시험이며 정전이나 저장 장치의 물리 내구성을 증명하지 않는다.

## 아직 제공하거나 검증하지 않은 부분

- 브라우저 안의 파일 편집기, 파일 자동 감시, 저장 즉시 자동 적용은 없다. 사용자가 외부 편집기로 고친 뒤 명시적으로 적용한다.
- 기존 SQLite 개인 기억의 문서 이관, 저장 방식 전환·역이관·복원 절차와 PostgreSQL 연결은 후속이다.
- 현재 파일 경계는 지원 POSIX 환경의 경로 재검사다. 모든 접근의 핸들 고정, 네이티브 Windows 연결, 네트워크 파일시스템 및 전원 장애 내구성은 완료로 주장하지 않는다.
- 초안·적용 이력의 자동 정리와 물리 삭제는 없다. D1의 본문·외부 확인 기록을 함께 일관되게 되돌리는 동일 OS 계정의 변경을 탐지할 수 없다는 한계도 유지된다.
- 실제 모델/API 시험은 중단 상태다. 합성 입력과 실제 저장소·CLI/HTTP의 구조적 동작을 확인했으며 자연어 자동 기억 선별이나 모델 의미 품질의 실증으로 확대하지 않는다.
- 이번 D2에서 추가 성능 계측은 실행하지 않았다. [D1 비용 관측](C03-document-memory-cost-notes.md)을 D2의 비용이나 속도 측정으로 전용하지 않는다.

다음은 [D3 명시 이관 계획](C03-personal-memory-migration-plan.md)이다. D2의 확정 검증이 D3의 백업·복원·전환 검증을 대신하지 않는다. 이 결과는 C01·C02·C03 전체나 전체 goal 완료 선언이 아니다.
