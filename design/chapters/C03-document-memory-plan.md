# C03 문서형 기억: Markdown 정본과 기존 기억 생애 연결

2026-09-07 · D1 지원 POSIX 검증 완료 · D2/D3 후속

[D1 결과](C03-document-memory-result.md): 같은 소스 Linux 전체 2,941/2,941·관련 199/199. 다음은 [D2 편집 초안 적용](C03-document-draft-plan.md)이다. 아래 착수 결정·초기 제안은 이력이며 현재 구현 결과와 구분한다.

## D1 착수 결정 — Checkpoint 241

이후 기술 선택은 기존 goal의 위임 범위에서 확정했다. SQLite 기본값(v1 설정)은 유지하고, 새 담당의 명시적 `init --personal-memory documents`만 v2 설정의 `storage.personalMemory = { backend: 'documents', storeId }`를 사용한다. 업무 기억의 `storage.memory`는 SQLite이며, 개인 문서 정본은 해당 담당의 `memory/documents` 아래에 둔다. v2 최초 설정 작업에도 같은 선택을 먼저 저장해 중단 뒤 기본값으로 바뀌지 않게 한다. 복제는 새 담당·저장소 ID만 만들고 기억은 복사하지 않는다.

설정 배정과 문서 저장소 초기화 완료는 별도 영수증이다. `.secumon/personal-memory-profile.json`은 배정, `.secumon/document-memory-ready.json`은 문서 저장소 등록 완료를 나타낸다. 완료된 저장소가 없어지면 자동 재생성·SQLite 대체를 하지 않는다. 개인 범위만 문서 repository로 보내며, 기존 기억 서비스·도구·CLI/Web·packet/frame은 같은 조합 저장소를 사용한다.

정본은 덮어쓰지 않는 Markdown 게시 기록이며 record와 command receipt가 파일 한 개로 확정된다. D1 한도는 namespace 4,096개 기록·64MiB, 개별 파일256KiB로 시작한다. 초안 편집·명시 적용은 D2에서 연결한다. 기존 SQLite 개인 데이터 이행은 별도 D3 범위다. 이 문단은 착수 당시 결정이다. D1의 최종 검증은 맨 위 결과 링크를 따른다. 직전 SQLite 개인 기억 검증은 C03-personal-memory-result.md/verification.json에 보존한다.

**Checkpoint242 검토 보강:** 변경 기록만으로는 마지막 파일 삭제가 정상 과거 이력과 구분되지 않았다. namespace 밖 `witness-<scope 지문>`에 scope·sequence·파일 지문만 저장하는 불변 게시 확인 기록을 추가한다. 본문과 명령 receipt는 Markdown 한 파일에 함께 남는다. 읽기·중복 응답 전에 확인 기록과 대조하고 필요한 동기화를 끝낸다. 완전한 본문만 게시되고 중단된 경우 검증된 누락 확인 기록만 재생성하므로, 기존 서비스의 get/receipt 선행 조회도 복구할 수 있다. 확인 기록보다 짧아진 본문 이력은 과거 버전으로 대신하지 않는다. 본문과 확인 기록을 함께 되돌리는 동일 OS 계정 변경은 외부 신뢰 기준 없이 탐지할 수 없으며 이 보장에 포함하지 않는다.

**기본 개인 기억은 SQLite로 유지한다. 문서형 저장소는 명시적으로 등록한 범위에서 선택하며, 그 범위의 기억 정본은 Markdown 파일에만 둔다.** 같은 기억 본문을 SQLite에도 쓰고 양방향 동기화하는 방식은 채택하지 않는다. 첫 사용자 흐름은 문서 저장소에서도 기존의 기억하기 → 새 대화에서 검색·선택 → 정정·잊기 → 재시작을 이어 주고, 편집한 Markdown을 같은 출처·버전 검사로 적용하는 것이다.

아래는 최초 제안 당시의 코드 관찰과 D2/D3를 포함한 설계다. D1에서 확정한 계약은 맨 위 결정과 결과 문서를 기준으로 하며, D2/D3는 아직 구현하지 않았다.

## 1. 유지할 결정과 현재 코드의 연결 지점

| 유지할 내용 | 현재 코드와 다음 연결 |
| --- | --- |
| 코어는 기억 저장 제품을 모른다 | [knowledge-ports.ts](../../runtime/src/application/knowledge-ports.ts)의 `KnowledgeRepository`와 `KnowledgeCommit`을 구현한다. 조회·영수증·CAS·색인 계약을 파일용 서비스로 다시 만들지 않는다. |
| 개인 기억의 소유자는 조직·담당·사용자다 | 같은 포트의 `KnowledgeStoreScope`와 `scopedKnowledgeRepository`를 사용한다. sessionId는 출처이며 소유 범위가 아니다. |
| 등록·정정·잊기와 출처 검사는 서비스 책임이다 | [knowledge-service.ts](../../runtime/src/application/knowledge-service.ts)의 `forPersonal/remember/revisePersonal/forgetPersonal/get/search/validateDependencies`를 그대로 통과한다. 파일 저장소가 출처를 임의 생성하지 않는다. |
| 현재의 사용자 기억은 적용된 발언을 출처로 한다 | [session-knowledge-sources.ts](../../runtime/src/application/session-knowledge-sources.ts), [session-originals.ts](../../runtime/src/application/session-originals.ts), [knowledge-contracts.ts](../../runtime/src/application/knowledge-contracts.ts)를 재사용한다. 대화 원문은 기존 channel 저장소에 남는다. |
| 검색과 이번 업무에서의 사용은 다르다 | [personal-memory-service.ts](../../runtime/src/application/personal-memory-service.ts)의 선택·현재성 검사, [personal-memory-context.ts](../../runtime/src/application/personal-memory-context.ts), 기존 compiler/frame/recovery 연결을 유지한다. 파일을 검색했다고 자동 선택하지 않는다. |
| 기존 SQLite 기본값과 업무 기억은 유지한다 | [sqlite-knowledge.ts](../../runtime/src/infrastructure/sqlite-knowledge.ts), [sqlite-knowledge-owner.ts](../../runtime/src/infrastructure/sqlite-knowledge-owner.ts)의 owner·scope·이행 계약을 보존한다. 첫 문서 단위는 개인 기억 범위만 연결하고, 업무 Evidence 기억은 기존 SQLite를 사용한다. |
| 파일 읽기·게시의 기존 OS 경계를 활용한다 | [host-metadata-files.ts](../../runtime/src/infrastructure/host-metadata-files.ts)의 제한된 안정 읽기와 [host-file-mutations.ts](../../runtime/src/infrastructure/host-file-mutations.ts)의 영역 생성·덮어쓰기 없는 게시를 사용한다. profile 전용 오류 래퍼나 DB owner 형식을 기억 형식으로 복사하지 않는다. |
| 실제 사용자 경로에 연결한다 | [agent-stores.ts](../../runtime/src/infrastructure/agent-stores.ts), [local-profile.ts](../../runtime/src/presentation/local-profile.ts), [local-personal-memory.ts](../../runtime/src/presentation/local-personal-memory.ts), 기존 CLI/Web 개인 기억 화면·도구를 조합 지점에서 연결한다. |

**기존 `FileJournalStateRepository`는 WorkState와 실행 영수증을 저장하는 state backend이며 memory backend가 아니다.** 그 객체에 KnowledgeRecord를 넣거나 file-journal 설정을 문서 기억 선택으로 해석하지 않는다. 파일 게시·중단 복구에서 이미 확인한 원칙과 저수준 공통 경계만 재사용한다.

착수 당시 `AgentConfigSchema.storage.memory`와 openAgentStores는 SQLite 전용이었다. D1은 v2 personalMemory 선택과 개인/업무 router를 추가했으며, 업무 기억의 storage.memory는 계속 SQLite다.

## 2. 범용 기억과 이번 사용자 편집의 범위를 구분한다

이번 C03의 `session_user_receipt` 출처는 **사용자가 명시적으로 기억하라고 지정한 발언**이다. 현재 계약은 본문과 원문 인용의 일치를 요구한다. Markdown 본문을 고쳤는데 예전 발언의 receipt를 그대로 붙이면 유효한 정정이 아니다.

이것은 장기기억 전체가 항상 사용자 발언이어야 한다는 뜻이 아니다. 이후 담당이 자율적으로 경험·실패·학습 결과를 기록하는 경우에는 그 기록을 뒷받침하는 별도 provenance, 즉 **출처와 형성 과정** 유형을 추가할 수 있다. 서비스가 그 유형의 범위·현재성·기록 권한을 검사하면 같은 문서 저장·검색·참조·회상 경로를 사용한다. 모든 기억에 사람의 입력이나 승인을 요구하는 코어 규칙을 만들지 않는다.

따라서 문서 코덱은 `KnowledgeRecord`와 버전이 있는 출처 구조를 직렬화한다. 저장소에 `body === userQuote` 같은 업무 의미를 별도로 하드코딩하지 않는다. 현재 지원하는 계약 버전을 엄격히 파싱하고, 새 출처 유형은 domain/application 계약이 추가된 뒤 명시적으로 지원한다. 모르는 출처 유형을 빈 출처나 일반 텍스트로 낮춰 받아들이지 않는다.

## 3. 한 정본을 위한 우선안: 게시된 문서와 편집 초안

권장안은 **게시된 Markdown 변경 기록이 정본이고, 사용자 편집 파일은 적용 전 초안**인 구조다. 초안은 검색·get·의존성·모델 입력에 포함되지 않는다. 이는 문서와 DB의 이중 정본이 아니라, 편집 중인 변경과 적용된 기록의 구분이다. 사용자는 실제 `.md` 파일을 편집할 수 있지만 편집기 저장 자체가 기억의 출처·버전을 변경하지는 않는다.

| 선택지 | 평가 |
| --- | --- |
| 단일 `.md` 파일의 직접 편집을 즉시 활성화 | 쉬워 보이지만 동일 revision에서 내용만 바뀌거나 반쯤 저장된 파일이 읽힌다. 현재의 CAS·중복 요청·출처 계약을 그대로 만족하지 못하므로 첫 구현으로 권장하지 않는다. |
| Markdown과 SQLite를 모두 정본으로 유지 | 어느 쪽이 최신인지와 삭제·충돌·복구 규칙이 하나 더 생긴다. 제외한다. |
| Markdown 게시 기록 정본 + 명시적으로 적용하는 `.md` 초안 | 기존 기억 서비스의 출처·정정·잊기와 연결 가능하다. 덮어쓰지 않는 게시를 사용해 C01 변경 API를 확대하지 않고 시작할 수 있다. 우선 제안이다. |

게시 기록은 일반 Markdown으로 읽을 수 있게 한다. 파일 앞의 제한된 JSON 메타데이터에는 소유 범위·기억 ID·버전·출처·명령 영수증·이전 기록 지문을 두고 본문은 UTF-8 Markdown으로 저장한다. `KnowledgeRecord.body`를 별도 DB/JSON 정본에도 저장하지 않는다. 정확한 구분자와 newline 처리, 인용 필드의 표현은 작은 코덱에서 정하고 재구성한 record를 기존 schema로 검증한다. 파서는 YAML의 임의 객체 생성·템플릿·include·스크립트 실행을 지원하지 않는다.

렌더링은 저장 의미와 별개다. 첫 CLI/Web은 기존 텍스트 표시를 사용하며 Markdown에 적힌 HTML·이미지·외부 링크를 자동 실행하거나 요청하지 않는다. 모델에게는 개인 기억이라는 기존 구분과 현재성 검사 뒤에 전달한다.

게시된 파일을 사용자가 직접 편집·삭제·이름 변경해 형식이나 연결이 깨지면 `변경된 정본 확인 필요`로 거절한다. 오래된 버전을 대신 활성화하거나 파일 없음으로 잊기를 추정하지 않는다. 정상 편집 경로는 초안 생성·적용이고, 정본 손상 복구는 별도의 명시 작업이다.

## 4. 저장 소유자·등록·백엔드 선택

등록된 root는 지속 `storeId`와 C01의 `agentId`를 갖는다. 폴더명, 현재 실행 디렉터리, 문서 제목에서 담당 ID를 새로 만들지 않는다. 첫 구현은 담당 하나가 소유한 로컬 문서 root만 허용한다. 여러 담당이 공유하는 문서 root의 등록·권한·동시 운영은 후속이며 SQLite의 명시 shared 모드는 그대로 유지한다.

개인 기억의 내부 키는 `tenantId + agentId + principalId + partition + namespace + memoryId`다. 경로에는 이 튜플의 지문 같은 안전한 단일 이름을 쓰고 기록에는 실제 논리 ID를 저장해 서로 대조한다. 제목·사용자 ID·모델 인자를 경로 문자열로 직접 이어 붙이지 않는다. 디렉터리를 이동해도 등록된 담당 ID는 유지되고, 다른 담당으로 복제했다고 개인 기억의 소유자가 자동 바뀌지 않는다.

호스트가 고정한 selector를 받는 작은 `KnowledgeRepository` 조합 구현에서 개인 범위만 문서 저장소로 보내고 기존 업무 범위는 SQLite로 보낸다. `KnowledgeService.forPersonal()`과 개인 도구까지 같은 조합 저장소를 받아야 한다. UI의 `personalKnowledge` factory만 바꾸면 내부 도구가 원래 SQLite 개인 분기에 남을 수 있으므로 충분하지 않다. 문서 저장소 열기 실패를 SQLite fallback으로 바꾸지 않는다.

첫 연결은 새 담당의 명시적 문서 등록에 한정하는 것을 제안한다. 현재 기본 설정의 `memory: sqlite` 의미를 조용히 바꾸지 않고, 새 설정 버전에서 개인 저장 선택을 별도로 표현한다. 예를 들어 업무 기억은 SQLite, 개인 기억은 `documents + registrationId`로 지정할 수 있다. 정확한 필드명은 구현 전 결정한다. 새 설정을 모르는 구버전이 `unsupported schema`로 거절하도록 해야 한다. 구버전이 문서 선택을 무시하고 같은 개인 범위의 SQLite에 쓰는 경로는 허용하지 않는다.

기존 비어 있지 않은 SQLite 개인 기억의 전환은 첫 단위에 넣지 않는다. 후속 이관은 쓰기 중지 → 문서 후보에 원 ID·revision·receipt·출처 보존 → 대조 → 호스트의 단일 저장 선택 전환 순서가 필요하다. 전환 이후 원 SQLite는 개인 범위의 읽기/쓰기 정본이 아니며 구버전 접근도 거절해야 한다. config 교체의 원자성까지 확인하지 않은 상태에서 자동 이관·자동 되돌리기를 제공하지 않는다.

## 5. 한 파일 게시로 record·receipt를 함께 확정한다

첫 구현에는 별도 DB 트랜잭션이나 변경 가능한 `HEAD.json`을 추가하지 않는 방식을 제안한다. 한 소유 범위·namespace의 게시 기록을 순서가 있는 Markdown 파일로 저장하고, **완전히 검증된 연속 기록에서 현재 기억·영수증·검색 상태를 계산한다.** 헤드란 현재까지 적용된 마지막 기록을 뜻한다. 정식 파일 한 개의 게시가 유일한 변경 확정점이다.

D1 구현에서는 위 Checkpoint242의 불변 게시 확인 기록을 추가했다. 성공 응답에는 이 보조 기록과 디렉터리 동기화까지 요구한다. 변경 가능한 HEAD나 두 번째 본문 정본은 만들지 않는다. 저장소는 새로 열었거나 파일 메타데이터·정본 prefix가 바뀐 때 동기화를 수행하며, 같은 검증된 prefix의 반복 조회에서는 완료한 동기화를 재사용한다. 파일 현재성·출처 검사는 계속 수행한다.

기억 변경 파일 한 개에는 다음을 함께 넣는다.

- 저장 형식 버전·소유 범위·게시 순서·이전 파일 지문.
- 기존 `KnowledgeCommit`의 expectedRevision, commandId, commandDigest.
- 다음 `KnowledgeRecord` 전체를 복원할 수 있는 메타데이터와 Markdown 본문.
- 기록 무결성을 대조할 지문. 지문은 전자서명이나 동일 OS 계정의 악의적 수정 방어를 뜻하지 않는다.

`commit()`은 먼저 같은 scope·memoryId·commandId의 영수증을 조회한다. 같은 digest면 원래 revision을 반환하고 다른 digest면 충돌이다. 새 명령만 현재 기억 revision의 CAS, 전이 규칙, 파싱·bytes 한도를 검사한 뒤 `다음 순서.md`를 no-overwrite로 게시한다.

두 프로세스가 같은 다음 이름을 만들면 한쪽만 게시한다. 다른 쪽은 정식 기록을 다시 읽어 자신의 중복 요청인지, 같은 기억의 CAS 충돌인지, 다른 기억의 변경 뒤 재시도할 수 있는지 구분한다. 재시도는 한도가 있고 원래 expectedRevision을 임의로 올리지 않는다. 파일명만 앞서 있거나 기록 사이가 비어 있는 경우 높은 번호를 바로 최신으로 취급하지 않는다.

별도 본문 사본 없이도 여러 기억 ID가 같은 namespace에 있을 수 있다. 게시 순서는 namespace 안의 변경 순서이고 각 기억의 revision은 기존 의미를 유지한다. 인수 범위는 작은 개인 기억 저장소이며, 큰 공유 지식 저장소의 처리량을 이 방식으로 이미 확보했다고 주장하지 않는다.

검색은 이 정본에서 만든 파생 색인을 사용한다. 첫 버전은 제한된 메모리 색인으로 충분하며 SQLite 색인 파일을 추가할 필요는 없다. `indexHead/candidates/rebuildIndex/markIndexError`를 빠뜨리지 않는다. 기억 변경과 그 검색 가능 상태는 같은 게시 prefix에서 계산하고, 색인 실패/복구 기록이 영속적으로 필요하면 같은 namespace의 작은 제어 기록으로 남긴다. 제어 기록에는 기억 본문을 넣지 않는다. 재시작 시 실제 재구성 전 `ready`를 선언하지 않는다.

색인과 캐시에는 소유 범위·정본 prefix 지문·검색어·권한 지문을 포함한다. 캐시가 가리킨 ID는 `get`과 기존 원문 검사를 다시 통과한다. 손상된 최신 기록을 빼고 오래된 색인으로 완전한 검색이라고 표시하지 않는다. 파일 목록/내용이 조회 중 바뀌면 bounded retry 또는 현재성 오류다.

## 6. 사람이 Markdown을 편집하는 실제 흐름

아래 명령 이름은 제안이며 이번 문서에서 CLI 기능을 추가한 것은 아니다.

1. 사용자는 기존 CLI/Web에서 기억을 등록한다. 선택된 문서 backend의 정본에 게시되며, SQLite의 같은 개인 키에는 본문을 쓰지 않는다.
2. `기억 편집 파일 만들기`는 현재 카드와 revision으로 새 `.md` 초안을 만든다. 호스트가 생성한 적용 ID, 원 기억 ID·base revision·owner·본문 지문을 함께 묶는다. 초안의 ID/경로가 저장 권한을 부여하지 않는다.
3. 사용자는 제목/본문을 편집한다. 편집기의 임시 파일 후 rename 저장도 초안에서는 허용할 수 있지만 적용 시 현재 경로를 다시 안정적으로 읽는다. 이전에 열었던 다른 inode를 무조건 적용하지 않는다. 심볼릭 링크 등 안전하지 않은 형태는 거절한다.
4. `편집 적용`은 현재 담당·사용자, 원 base revision, 적용 대상 업무와 최신 입력을 확인한다. **이번 사용자 발언형 기억의 본문 변경**은 기존 `local-personal-memory.ts`의 `new_input` 흐름처럼 편집한 문구를 사용자가 보낸 새 발언으로 먼저 저장·적용하고, 그 receipt를 `revisePersonal()`의 출처로 사용한다. 첫 버전은 적용 대상 대화/업무를 명시한다. 알 수 없는 모델 호출이나 숨은 업무를 새로 만들지 않는다.
5. 원문 receipt 저장 뒤 기억 게시 전에 중단돼도 같은 적용 ID와 본문 지문으로 재개한다. 사용자의 명시 적용 한 번이 재시작 뒤 발언 두 개 또는 정정 두 번이 되지 않아야 한다. 같은 적용 ID로 다른 편집 내용을 보내면 충돌이며 새 적용 요청을 만든다.
6. 새 revision을 게시한 뒤 기존 선택·프레임·늦은 모델 계획의 현재성을 다시 검사한다. 기억을 고쳤다고 기존 선택을 몰래 새 버전으로 바꾸지 않는다. 사용자가 이번 업무에서 사용할 버전을 다시 선택한다.
7. `잊기`는 기존 `forgetPersonal()`로 활성 상태를 철회하는 새 기록을 게시한다. 초안 삭제·원본 파일 삭제는 잊기 명령이 아니다. 과거 Markdown 버전·대화·백업의 물리 삭제는 보장하지 않는다. 새 검색/회상/재시작/중복 과거 명령으로 활성 기억이 살아나지 않아야 한다.

미래의 자율 경험 기록은 사용자 편집 2~4단계를 반드시 거칠 필요가 없다. 신뢰한 실행기가 자신의 기록 권한과 해당 provenance 검증을 갖고 동일한 `KnowledgeService`/repository 변경 경로를 호출한다. 별도의 저장 우회나 무출처 메모를 허용하는 확장은 아니다.

## 7. 파일 경계·중단·내구성

현재 공통 파일 API는 지원 POSIX에서 경로와 객체를 재확인하는 구현이다. 디렉터리 핸들 기준으로 모든 접근이 고정되었다고 표현하지 않는다. native Windows의 독립 선행 구현을 import했다고 Windows 지원을 켜지 않는다.

- **등록 전:** 실제 root·부모와 엔진 금지 영역, owner, 지원 플랫폼·필수 저장 동기화 능력을 검사한다. Windows 미지원이나 요구한 내구성 미지원이면 정식 기억 생성 전에 거절한다. 현재 POSIX 모드 검사를 Windows ACL 검사로 대신하지 않는다.
- **읽기:** 검사된 private 디렉터리에서 `readStableRegularFile()`로 일반 파일·소유자·권한·크기·동일 객체를 검사한다. 디렉터리는 private, 개인 기억·초안도 기본 private로 생성한다. 다른 사용자에게 읽히는 편집기 저장 결과를 자동 chmod해 인수하지 않는다.
- **게시:** 같은 영역의 후보에 쓰고 파일 sync → 덮어쓰기 없는 정식 이름 게시 → 디렉터리 sync → 결과 재확인을 수행한다. 정본 변경은 기존 파일 overwrite/rename에 의존하지 않는다. 크로스 볼륨 이동·네트워크/동기화 폴더는 첫 지원 범위 밖이다.
- **링크:** symlink·특수 파일·외부 hardlink·경로 탈출을 거절한다. 게시 중 남은 pending과 정식 파일의 정확한 동일 객체 쌍은 별도로 검증한다. UUID 모양 이름이라는 이유만으로 자기 후보로 인수하거나 삭제하지 않는다. 원인과 정리 오류는 함께 남긴다.
- **불명확한 결과:** `FileMutationFault.status.publication`과 sync 상태를 보존한다. 게시 후 실패를 미실행으로 돌리지 않는다. 재호출은 정식 파일·command receipt·digest를 먼저 확인하고 필요한 sync를 마친 뒤 완료를 확정한다. 기존 후보를 보았다고 새 commandId를 발급하지 않는다.
- **중단:** 후보만 남은 경우와 정식 기록이 게시된 경우를 구분한다. 검증된 정식 기록이 없으면 후보를 검색 결과에 넣지 않는다. 정식 기록이 있으면 중복 변경 없이 재개한다. 지원하지 않는 고아 파일 정리는 명시 오류·정리 필요로 남기며 무조건 전체 삭제하지 않는다.
- **외부 편집 경합:** 직접 편집으로 정본 chain/bytes가 달라지면 최신 기억 사용을 중단한다. 초안 rename은 저장 중 변경으로 취급하고 안정된 한 버전만 적용한다. 조회 중 손상된 파일을 못 읽었다고 다른 사람/다른 backend의 동명 기억을 찾지 않는다.

공통 API에는 현재 일반 용도의 안전한 디렉터리 목록 API가 없다. 첫 문서 저장소의 목록은 bounded enumeration과 root 참조 전후 검사로 구현하고 이 제한을 기록한다. 메타데이터·sync·게시 API를 다시 추출하는 프로젝트로 확대하지 않는다. native 연결이 필요한 목록/정리 경계는 실제 Windows 지원의 잔여로 남긴다.

초기 제안 한도는 namespace당 게시 기록 4,096개·정식 파일 합계 64 MiB, 개별 파일 256 KiB다. 기억 body/source의 기존 더 작은 schema 한도와 실제 모델 입력의 8 KiB 개인 카드 한도는 별도로 유지한다. pending에도 독립 개수·bytes 한도를 둬 정상 한계에서 한 번의 중단 뒤 재개가 막히지 않게 한다. 초과는 명시 오류이며 절단·옛 기록 자동 삭제로 해결하지 않는다. 정확한 값은 codec 최대 크기와 작은 로컬 계측 후 확정한다.

프로세스 강제 종료 후 복구 시험과 전원 차단 내구성은 다르다. 파일/디렉터리 sync를 수행했다는 사실을 정전·SMB·Windows의 미실행 시험 통과로 바꾸지 않는다. 같은 OS 계정의 무제한 셸이 정본과 등록 정보를 함께 고치는 것을 논리 scope나 해시만으로 막았다고 주장하지 않는다.

## 8. 작은 구현 순서와 인수 기준

| 단위 | 한 사용자 결과 | 변경을 검토할 파일 범위 |
| --- | --- | --- |
| **D1. 등록된 새 문서 기억 저장소의 끝까지 연결** | 새 담당에서 문서 저장을 명시 선택하고 CLI/Web의 기존 기억하기 → 새 대화 검색·선택 → 실제 frame → 정정·잊기 → reopen이 동작한다. 두 state backend와 memory backend 선택은 독립이다. 같은 개인 키의 SQLite 정본은 생성하지 않는다. | 새 `document-knowledge.ts`와 필요한 작은 codec/등록 helper, `KnowledgeRepository` 조합 구현. `agent-profile-contracts.ts`의 설정 버전, `agent-stores.ts`, `local-profile.ts`의 타입·선택 연결. 기존 기억 service/출처 계약은 재사용한다. |
| **D2. Markdown 편집을 기억 정정으로 적용** | 초안 파일을 직접 고친 뒤 적용하면 새 사용자 receipt와 기억 revision이 연결된다. 중간 종료 후 같은 적용 요청을 재개하고 오래된 초안·다른 owner를 거절한다. CLI에서 파일 경로를 보여 주고 Web에서도 적용 결과/출처를 확인한다. | 작은 편집 명령 조립, `local-personal-memory.ts`, CLI/Web의 최소 입력 연결. 본문 파싱을 UI·도구마다 복제하지 않는다. |
| **D3. 필요한 기존 데이터 이관** | 실제 사용자에게 이관 필요가 있을 때만 별도 계획한다. 원 ID/출처/영수증을 유지한 이관과 단일 backend 전환·구버전 거절을 입증한다. | 등록·이관 명령과 backend 선택의 원자적 전환. D1/D2 완료의 숨은 선행 조건으로 넣지 않는다. |

D1은 codec이나 저장 helper만 작성하고 끝내는 단위가 아니다. 서비스·개인 도구·실제 CLI/Web·frame 연결까지 한 흐름을 완성한다. D2에서는 일반 편집기의 rename을 실제로 사용한 파일과 수정 버전을 시험한다. D1/D2가 인수되면 PostgreSQL·자동 임베딩·문서 공유·대규모 색인·Windows 잔여 때문에 C04 범용 대화·추론을 무기한 미루지 않는다.

필요한 회귀는 다음에 집중한다.

- 같은 ID·commandId를 쓰는 다른 tenant/agent/principal의 record·receipt·색인·캐시·ref 격리. 기존 scope 생략/위조가 개인 영역에 들어가지 않음.
- 실제 C01 stores와 같은 기억 서비스에서 SQLite/문서 선택, 기억 등록·검색·도구·선택·frame·reopen·정정·잊기. 사용자 기억이 Evidence나 compact 요약으로 자동 승격되지 않음.
- 같은 기억의 동시 CAS, 서로 다른 기억의 게시 경쟁, 중복 명령, 기록 빈틈/잘못된 이름/변조/한도 초과, 동일 ID의 tombstone 뒤 과거 명령 재전송.
- 후보 write, 파일 sync, 정식 게시, 디렉터리 sync, 응답 직전의 실패·실제 자기 worker SIGKILL. record/receipt가 나뉘어 하나만 적용되지 않음. 게시 후 오류의 원 cause·미확정 상태 보존.
- 적용 receipt만 저장한 상태/기억 게시한 상태의 중단, 새 입력 도착·기억 정정과 오래된 초안 적용의 경쟁. 원문 이력·사용량은 보존되고 옛 프레임/계획을 재사용하지 않음.
- 실제 조회 파일·bytes·파싱·색인 재구성·캐시 비용을 기록한다. 검증하지 않은 성능 향상이나 토큰 절감률을 적지 않는다. 기존 C03 일반 시험을 통째 복제하기보다 공통 생애 시나리오를 새 adapter에 연결한다.

## 9. 구현 전 결정할 사항과 남길 범위

우선 결정은 세 가지다. **(a)** 사용자 편집은 적용 전 초안으로 시작하는 UX를 채택할지, **(b)** 첫 문서 backend를 새 담당의 개인 기억에 한정하는 범위와 설정 버전, **(c)** Markdown envelope/게시 prefix·한도와 색인 오류 영속 방식이다. 이 문서는 이 선택을 사용자에게 이미 승인받았거나 제품에 적용한 것으로 기록하지 않는다.

자율 경험 provenance 확장, 기존 SQLite 이관, 문서 root의 다중 담당 공유, 대량 이력 정리, 파일/백업 물리 삭제, PostgreSQL/임베딩, 일반 Windows·네트워크 파일시스템 지원은 후속이다. 이들 중 미래 자율 기억은 사람 승인 전제를 추가하는 일이 아니라 출처 유형·기록 권한·검증을 확장하는 일이다.

문서 작성으로 기존 NAS 소스 pin이나 제품/시험/scripts를 바꾸지 않았다. 문서 저장 어댑터의 코드·파일시스템 시험·CLI/Web 관찰·실제 모델 품질 검증은 아직 수행하지 않았다.

## 10. D1 착수 후 확정한 작은 보강 — 구현 중, 검증 전

위 순수 문서 chain만으로는 재시작 뒤 마지막 `잊기` 파일이나 namespace 폴더 전체가 사라진 경우를 과거의 정상 prefix와 구분할 수 없다. 구현 검토에서 이를 확인하여 namespace 바깥의 같은 등록 root에 **본문 없는 immutable witness**를 추가하기로 했다. witness는 소유 범위·게시 순서·정본 파일의 digest만 가지며, 기억 본문이나 명령 영수증의 두 번째 정본이 아니다.

정식 Markdown 파일 하나가 record와 receipt의 변경 확정점이다. 그 뒤 `witness-<범위 지문>/<순서>.json`을 게시·동기화한다. 첫 호출에서 게시 후 오류가 나면 `published/unknown`와 원 cause를 보존하며 성공으로 바꾸지 않는다. 다음 `get/receipt/indexHead`도 완전한 정식 파일만 있는 suffix를 검증하여 누락 witness와 barrier를 제한적으로 복구한 뒤 반환할 수 있다. 기존 서비스가 `commit`보다 `get/receipt`를 먼저 호출하므로 복구를 commit 재호출에만 가두지 않는다.

witness가 요구하는 정식 파일이 없거나 지문이 다르면 옛 기억을 반환하지 않는다. 같은 prefix를 다시 읽을 때는 파일 메타데이터 토큰·디렉터리 객체·본문 chain을 재검사하고 이미 동기화한 동일 prefix의 불필요한 fsync를 피한다. 존재하지 않는 임의 사용자 범위는 이 캐시에 등록하지 않는다. 정본과 witness를 함께 과거로 되돌리거나 제거하는 동일 OS 계정의 조작까지 탐지한다고 주장하지 않는다.

최초 등록의 owner 후보만 남은 경우, 명시적 initializer는 private/owned/regular·한도 검사와 **완성된 기대 owner JSON 일치**를 통과한 후보만 재개 근거로 삼는다. 그 후보를 정본으로 인수하거나 삭제하지 않고 새 owner를 게시한다. 반쯤 쓴 후보나 다른 owner 후보는 `cleanup_required`로 거절하며 자동 복구 미지원으로 남긴다. supplied agent root의 0755는 owner-writable로 허용하고 실제 문서 root와 namespace는 private를 유지한다.

`KnowledgeRecord.body`의 저장 위치는 Markdown이고 기존 출처의 quote는 메타데이터에 같은 문구를 포함할 수 있다. 이것은 물리적인 문자열 중복 제거를 보장하는 형식이 아니며, 동일 개인 기억을 SQLite에 별도 정본으로 저장하지 않는다는 뜻이다. D1 외부 저장 선택/완료 표시는 부모 구현의 별도 불변 assignment/ready 기록으로 관리한다. 구버전 진입 거절과 기존 기억 이관은 그 연결의 실제 검증 범위에 따라 판단한다.
