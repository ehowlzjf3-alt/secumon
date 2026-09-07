# C07 일반 입구 연결 메모

2026-09-08. C06 다음 구현의 연결 위치를 확인한 메모다. 아래 소스 5개만 읽었으며, C07 구현·시험 통과를 뜻하지 않는다. 게시판과 지식 저장소의 기존 구현을 재사용하는 범위로 좁힌다.

## 이미 연결된 부분

| 경로 | 현재 연결과 재사용할 경계 |
| --- | --- |
| [board-ports.ts](../../runtime/src/application/board-ports.ts) | `BoardRepository`가 조회, 명령 영수증, revision 비교 커밋, 선택적 변경 조회와 닫기를 제공한다. `BoardActorProvider`가 호스트의 현재 게시판 권한을 공급한다. 새 게시판 원장을 만들 필요가 없다. |
| [knowledge-ports.ts](../../runtime/src/application/knowledge-ports.ts) | `KnowledgeRepository`가 namespace·scope별 조회/검색, 영수증/커밋, 인덱스 상태와 재구성을 제공한다. `TrustedKnowledgeActorProvider` 및 `InputAuthority`가 신원과 권한의 호스트 출처다. 모델 인자가 권한을 정하지 않는다. |
| [compose-runtime.ts](../../runtime/src/application/compose-runtime.ts) | 선택적 `board: {repository, actors, authority}`를 받으면 `BoardService`, `BoardCommands`, `BoardWatch`를 만들고 게시판 도구와 요청 도구를 공통 `ToolContracts`에 넣는다. 의무 검증, 알림, 입력 의존 관계, effect 검증/복구도 기존 workflow에 연결한다. 반환값의 `board`, `boardCommands`, `boardWatch`가 호스트 서비스 입구다. |
| [agent-turn-profile.ts](../../runtime/src/presentation/agent-turn-profile.ts) | 실제 C01 `stores.knowledge`와 호스트 지식 actor를 `composeRuntime`에 넘긴다. 개인 기억, 세션 원문 검증, 일반 모델 입구와 호스트 도구의 provider 발견도 이미 연결돼 있다. **게시판 인자는 아직 넘기지 않으므로 이 profile의 게시판 서비스는 비활성이다.** |
| [knowledge-tools.ts](../../runtime/src/application/knowledge-tools.ts) | 모델의 기존 지식 읽기 입구는 `core.memory.get`, `core.memory.search`다. 개인 기억은 명시적 `memory: 'personal'` 선택을 사용한다. 실제 도구 노출은 정책 허용 목록에도 달려 있다. 기억 내용을 새로운 Evidence로 간주하지 않는 경계를 유지한다. |

일반 profile의 지식 actor는 현재 namespace를 `local`, `personal`, scope를 해당 agent 범위로 고정하며 `canReview`, `canPublish`는 false다. 읽은 파일에는 별도의 archive 등록 입구가 없다. 따라서 C07의 아카이브 요구를 기존 지식 namespace·정본·발행 권한 중 어디에 연결할지 먼저 정해야 하며, 저장소 자체가 없다고 판단하거나 별도 저장 엔진부터 추가해서는 안 된다.

외부 도구의 `providerSources → refreshProviderTools` 경로와 게시판 조립은 서로 다른 역할이다. 게시판 core 도구는 이미 `composeRuntime`이 등록하므로 외부 provider로 다시 등록할 필요가 없다. 게시판을 여는 데 필요한 것은 저장소, 현재 actor, `InputAuthority`를 제공하는 호스트의 선택적 조립이다.

## 다음 최소 구현

1. **호스트의 선택적 게시판 등록을 일반 profile에 연결한다.** 기존 `composeRuntime` 입력 형태를 재사용해 저장소·actor·입력 권한을 전달하고, 미등록 기본값은 비활성으로 유지한다. 기존 file/SQLite 게시판 어댑터를 우선 검토하며 모델 원문이나 HTTP 인자로 저장소 경로·권한을 받지 않는다.
2. **지식/아카이브의 호스트 권한 선택을 연결한다.** 현재 고정된 namespace·scope·검토/발행 권한 중 C07에 필요한 부분만 호스트 등록으로 공급한다. 기존 C01 지식 저장소와 원문 검증을 유지하고, 별도 저장소 선택이 실제로 필요한 경우에만 factory를 추가한다. namespace 문자열만으로 접근이 허용되지 않게 한다.
3. **도구 허용 목록과 실행 권한을 함께 맞춘다.** 게시판 읽기와 쓰기 권한을 구분한다. 현재 일반 profile actor는 `allowWrites: false`이므로 게시판 쓰기를 지원할 때는 호스트 정책·actor·execution authority가 일치하도록 명시적으로 연결해야 한다. 활성화 옵션 하나로 쓰기·발행 권한을 일괄 부여하지 않는다.
4. **CLI/Web과 모델이 같은 profile 조립을 사용하게 한다.** 호스트 서비스는 반환된 `board/boardCommands/boardWatch/knowledge`를, 모델은 기존 공통 도구 경로를 사용한다. 지식 도구의 현 공개 범위는 읽기 두 가지이므로 발행이 필요하다면 기존 서비스에 대한 명시 관리 입구와 모델 도구 중 필요한 범위를 먼저 정한다. 게시판 도구나 별도 실행 루프를 중복 구현하지 않는다.
5. **등록 자원의 수명을 기존 close 흐름에 포함한다.** 부분 조립 실패와 정상 종료에서 새로 연 저장소/등록 자원을 한 번만 닫고 원 오류를 보존한다. 변경 알림·의무·입력/effect 검증은 이미 연결된 workflow 경로를 유지한다. 상세 검증 단계에서는 미등록 기본값, 선택 활성화, 권한 축소 후 재접속, namespace 분리, 중복 명령과 종료를 기존 회귀 중심으로 확인한다.

이번 메모는 연결 위치와 다음 구현 범위만 확인했다. 제품 코드·시험은 변경하거나 실행하지 않았고, CLI/Web의 C07 공개 명령이나 아카이브 발행 동작을 구현 완료로 표시하지 않는다.
