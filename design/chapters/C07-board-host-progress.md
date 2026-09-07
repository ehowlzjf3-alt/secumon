# C07 게시판 호스트 연결 진행

2026-09-08. C06 → C10 기능 구현 우선, 상세 검증은 이후 통합 단계에서 수행한다. 게시판의 저장·조회·등록·질문 영수증을 재구현하지 않고 기존 `BoardRepository`, `BoardActorProvider`, `InputAuthority`를 일반 담당의 호스트에 연결한다.

이번 범위는 신규 `runtime/src/presentation/host-board.ts` 한 제품 파일이다. `HostBoardRegistration.open({agentId,root,scope,policy,signal})`은 repository/actors/authority와 명시 `allowedTools`, `allowWrites`, close를 반환한다. 등록 해석·메서드 캡처·단회 close는 이 helper에서 처리하고, feature/일반 profile/compose 연결은 root가 맡는다. feature만으로 등록을 만들거나 write 목록을 늘리지 않는다.

현재 actor는 처음 값을 고정하지 않고 매 호출 host callback에서 다시 읽는다. 담당 tenant/principal 및 담당 scope의 허용 여부를 확인하고 labels/destinations는 전달받은 policy와 교집합으로 제한한다. 명시된 공유 게시판 scope는 담당 전용 scope와 별개로 유지한다. 원자료 소유자의 조회는 기존 InputAuthority를 사용하며 요청 신원과 반환 신원을 대조한다. 새 모델 권한이나 원문 복사 경로는 만들지 않는다.

로컬 factory는 호스트가 명시한 절대 경로에서 기존 SQLite 또는 FileBoardRepository를 연다. 저장소 파일/테이블 준비와 논리 게시판 생성은 구분한다. factory는 게시판·멤버·게시물·질문을 생성하거나 자료를 이동하지 않는다. 해당 게시판은 기존 관리 서비스로 별도 준비한 것을 사용한다.

새 시험/manifest/빌드/npm/네트워크 실행은 하지 않는다. 구현 내용과 미검증 한계 및 짧은 사용 예를 아래에 남긴다.

## 작성된 연결

[host-board.ts](../../runtime/src/presentation/host-board.ts)에 `resolveHostBoardRegistration`, `openRegisteredHostBoard`, `createLocalHostBoard`를 작성했다. 등록의 open, 반환 포트의 메서드 및 close를 한 번 캡처한다. 반환 후 검증 실패 시 확보한 close를 시도하며 원 오류와 정리 오류를 보존한다. close를 반복 호출해도 같은 종료 Promise를 반환하고 종료 후 포트 사용은 거절한다.

`allowedTools`는 기존 게시판 도구 ID만 허용한다. `allowWrites:false`인데 쓰기 도구 ID가 들어 있으면 잘못된 등록으로 거절한다. 목록에 쓰기 도구가 있어도 현재 actor의 실제 발행 권한을 새로 부여하지 않는다. 저장소 생성 시 게시판 내용과 역할은 자동으로 만들지 않는다.

다음은 저장소의 현재 TypeScript 경로를 기준으로 한 호스트 조립 예다. `actors`와 `authority`는 시작 프로그램이 관리하는 실제 권한 조회이며, C10 배포용 export 계약을 뜻하지 않는다.

```ts
import { createLocalHostBoard } from './runtime/src/presentation/host-board.js';
import type { AgentExecutionHost } from './runtime/src/presentation/host-tools.js';
import type { AgentTurnHost } from './runtime/src/presentation/host-models.js';
import type { BoardActorProvider } from './runtime/src/application/board-ports.js';
import type { InputAuthority } from './runtime/src/application/knowledge-ports.js';

export function attachBoard(
  models: AgentTurnHost['models'],
  actors: BoardActorProvider,
  authority: InputAuthority,
  absoluteDatabasePath: string,
): AgentExecutionHost {
  return { models, board: createLocalHostBoard({
    backend: 'sqlite', path: absoluteDatabasePath,
    actors, authority,
    allowedTools: ['core.board.read', 'core.board.requests.read'],
    allowWrites: false,
  }) };
}
```

파일 공급자는 `backend:'file'`과 호스트가 정한 전용 디렉터리 절대 경로를 사용한다. 같은 게시판 저장소를 두 담당에게 연결하려면 두 담당 각각의 현재 actor와 authority를 제공한다. 관리 중인 원 저장소를 여러 lease가 공유하는 별도 호스트는 그 수명을 직접 소유해야 한다. 이 로컬 factory는 open마다 저장소 인스턴스를 새로 연다.

명시 쓰기는 `allowWrites:true`와 필요한 정확한 쓰기 ID를 함께 지정한다. 예를 들어 발행만 허용하려면 `core.board.publish`만 추가한다. profile의 feature 선택, 현재 업무 policy, 게시판 역할 및 원문 공개 권한은 기존 경계를 계속 거친다.

## 아직 확인하지 않은 부분

제품 어댑터와 위 예제는 작성·정적 읽기만 마쳤다. 빌드, 실행 및 통합 인수는 수행하지 않았다. 특히 서로 다른 담당 scope/DB를 통한 공유 게시판은 기존 서비스의 동등 scope 및 로컬 원문 조회 제약 때문에 어댑터만으로 완성되지 않는다. [별도 연결 메모](C07-board-shared-source-notes.md)의 작은 연결부를 root가 담당하며, 이 문서는 공유 배치 완료를 주장하지 않는다.
