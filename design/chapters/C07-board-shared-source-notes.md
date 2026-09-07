# C07 공유 게시판의 scope와 원자료 연결 메모

2026-09-08. 호스트 등록 어댑터의 정적 읽기에서 확인한 두 연결 제약과 최소 제안에서 시작했다. 아래 원 제안은 판단 근거로 보존하며, 현재는 root가 제공한 `BoardWorkSources`와 `WorkInputSource`를 기존 서비스에 연결하는 구현 단계다. 개인 담당의 DB를 합치거나 자료를 복사하지 않는다. 시험과 빌드는 수행하지 않았다.

이번 구현은 BoardService snapshot에 명시 owner의 외부 읽기 묶음을 보존하고, 원문과 최종 현재성을 같은 출처로 재확인한다. 외부 원업무는 `sourceWorks`로 유한 입력 그래프에 넘기며 일반 state 저장소나 쓰기 포트에는 fallback을 추가하지 않는다. 게시판 도구·명령·watch 및 호스트 등록에 선택 포트만 전달하고 기존 미등록 경로를 유지한다.

## 공유 scope

[BoardService](../../runtime/src/application/board-service.ts)의 `#place`는 actor의 명시 게시판 namespace/scope 권한을 이미 확인한다. 반면 `#work`는 업무 goal.scope와 게시판 scope의 동등성을 요구하고, `#source`도 게시판 scope로 accessibleEvidence를 고른다. [BoardCommands.access](../../runtime/src/application/board-commands.ts), [BoardWatch.access](../../runtime/src/application/board-watch.ts)는 같은 동등성을 검사하며, [board-tools.scoped](../../runtime/src/application/board-tools.ts)는 actor.allowedScopes를 업무 scope 하나로 줄인다. 따라서 `agent:A`와 `agent:B`인 두 담당을 같은 공유 게시판에 단순 등록하면 이 단계에서 막힌다.

최소 연결은 업무 자체의 scope를 유지하면서 게시판 scope에 대한 별도 현재 host grant를 사용하는 것이다. 담당 업무 scope와 게시판 scope 모두 명시 허용되어야 하며, 현재 tenant/principal·게시판 namespace·역할·labels·공개 조건을 유지한다. `#source`의 근거 조회는 원 업무 scope에서 수행하고 공유 게시판으로 공개해도 되는지를 별도로 검사한다. 게시판 본문을 읽었다고 다른 업무의 scope 권한이나 독립 근거가 생기지 않는다. 호스트 어댑터는 이를 위해 명시 allowedScopes를 그대로 보존한다.

## 담당별 저장소의 원자료

`BoardService.#work/#guard`는 `services.state.get`만 읽고, `#source`는 `services.artifacts.get`을 사용한다. `#workProof`도 현재 서비스의 inputs/effects/readCoverage/knowledge 검사를 거친다. 단순히 state.get을 여러 DB에서 검색하도록 바꾸면 원문 파일과 증명은 여전히 잘못된 담당에서 조회될 수 있다.

기존 [WorkInputGraph](../../runtime/src/application/work-input-graph.ts)는 [SourceInputInspection.sourceWorkIds](../../runtime/src/application/source-input-inspection.ts)를 다시 `services.state.get`으로 해석하고, 현재성 확인 때도 같은 포트를 사용한다. 게시판 서비스에서 peer 업무를 읽는 변경만으로는 보관된 게시판 결과의 재검증까지 연결되지 않는다. 일반 `scopeActor`를 공유 scope 전체로 넓히는 변경도 피해야 한다.

권고하는 최소 추가점은 게시판 전용 읽기 출처 resolver다. 호스트가 명시적으로 등록한 원 owner에 대해 work 조회와 원문 조회·기존 현재성 증명을 같은 소유자에 고정한 묶음으로 제공한다. 현재 담당의 RuntimeServices.state, 원문 저장소 및 commit 포트는 바꾸지 않는다. 새 DB/전역 검색 저장소/자료 복사는 필요 없다.

이 resolver는 board citation/post/request에서 증명한 원 workId와 owner/tenant에 한정해야 한다. BoardService의 최초 읽기와 마지막 revision/원문 현재성 재확인, 그리고 board inspection이 반환한 원업무 의존성의 graph 재확인에서 같은 출처를 사용한다. 일반 업무·개인 메모·임의 도구의 의존성 조회에 자동 fallback을 열지 않는다. owner가 다른 동일 workId나 중복 매핑은 임의 첫 결과를 선택하지 않고 거절해야 한다. 삭제·권한 철회·세대 변경은 기존 원 자료 증명을 통해 계속 무효화한다.

원문 복사 없이 기존 port를 내부에 묶을 수 있지만, 외부에 쓰기 가능한 전체 RuntimeServices를 넘기는 계약은 불필요하다. 실제 추가 타입의 위치와 기존 그래프 연결 방식은 root가 적용 범위를 정한다. profile의 close는 호스트가 반환한 수명만 종료하고 다른 담당 저장소의 임의 소유권을 취하지 않는다.

후속 통합 확인은 서로 다른 두 담당 scope/DB와 하나의 공유 게시판에서 읽기·명시 발행·원출처 재검증을 잇는 사례로 제한할 수 있다. 공유 scope 권한 없음, 원 owner 매핑 충돌, 원문 삭제/권한 축소 시 거절과 각 개인 DB 불변은 그 사례에서 함께 확인할 경계다. 현재는 검증 전 제안이다.

## 작성한 연결과 남은 조립

BoardService에 선택 `workSources`를 추가했다. 로컬 업무가 없을 때만 게시물 역할·인용의 owner·요청 참여 역할에서 결정한 신원으로 resolve한다. 로컬에 같은 ID가 있으나 owner가 다르면 외부로 재검색하지 않는다. 현재 담당의 읽기/발행 대상 업무는 기존 로컬 조회를 유지한다. 같은 snapshot에서 한 workId에 서로 다른 owner를 주장하면 거절한다.

외부 업무의 state/artifact/current를 같은 source에서 읽고 최종 guard도 그 source에서 재확인한다. 입력 그래프 수집 중에는 재귀 current 호출을 건너뛰고 외부 의존성을 `sourceWorks:{workId,source:resolved.inputs}`로 전달한다. inspection의 현재성 버전에 source ID도 포함했다. 일반 state/commit/artifact 저장 포트에는 전역 fallback을 추가하지 않았다.

게시판 scope와 원 업무 scope는 모두 현재 actor가 명시 허용해야 한다. 원 근거는 원 업무 scope로 조회한다. board 도구·요청 도구·명령·watch는 명시 공유 grant를 잘라내지 않으며, board 입력 reader만 현재 board actor를 다시 읽어 일반 그래프의 업무 scope와 분리한다. BoardCommands의 효과 증명 검사는 board provider 또는 board 도구의 영수증만 대상으로 하여 archive 영수증을 오염시키지 않는다.

호스트의 `OpenedHostBoard`와 `LocalHostBoardOptions`에는 선택 `workSources`를 전달했다. 원 source 객체별로 고정한 wrapper를 재사용하며 조회 메서드와 owner, profile 수명을 캡처한다. 원 출처의 authority를 독자 policy로 바꿔 전달하지 않는다. 같은 source 객체를 다른 owner에 매핑하면 거절한다.

root가 맡은 남은 조립은 profile → compose → 각 board 서비스로 workSources 전달, WorkInputGraph의 sourceWorks 유한 검증, 명시 owner registry를 위한 기존 runtime source 노출이다. 이 문서와 담당 6개 제품 파일은 작성 후 동결하며 빌드·시험·외부 호출은 실행하지 않았다. 실제 두 담당 통합 동작은 아직 검증 완료로 표시하지 않는다.
