# C04 순차 검증 준비

## Checkpoint372 실행 단위

후속 결과: 호스트 전달 연결과 fixture 준비를 적용한 build2가 통과했고, 남은15파일107개를 확인했다. [현재 결과](C04-ordered-verification-result.md). 아래는 실행 전에 작성한 계획이다.

호스트 등록표는 담당 ID와 실제 폴더를 연결해 복사본의 혼선을 막는 저장소다. `chat` 입구에서도 `init`·`work`와 같은 신뢰된 경로를 전달해야 한다. 기존 `createLocalContractHost()`의 모델 등록에 `hostOptions`를 병합해 넘기고, CLI의 등록 모델 실행과 지정 등록표 생성 여부를 한 시험에서 확인한다. 별도의 사용자 CLI 옵션이나 제품 환경변수는 추가하지 않는다.

나머지 기존 C04 시험은 임시 담당 폴더와 같은 임시 등록표를 사용하도록 준비한다. 이미 통과한 핵심5파일51개는 반복하지 않는다. 소스를 동결한 뒤 빌드하고 일반/복합, 문맥/재접속, 목표 변경/입구의 남은15파일과 위 회귀를 실행한다. 실제 모델/API 연결은 중단 상태를 유지한다. 이 문단은 계획이며 결과는 별도 결과 문서에 기록한다.

checkpoint371에서 현재 소스·기존 C04 계획과 결과를 읽어 정리했다. 이 문서는 실행 결과가 아니다. 모델/API 실제 시험은 계속 중단한다. 파일은 `runtime/src/tests/<이름>.test.ts`이며 실행 때 실제 종료 결과를 사용한다.

| 묶음 | 기존 시험 |
| --- | --- |
| 가설·계획·반론·완료 판정 | `model-runtime`, `agent-response-completion`, `agent-turn-service`, `agent-turn-adapter`, `synthetic-agent-turn` |
| 일반·복합 턴 | `agent-turn-profile`, `agent-turn-flow`, `agent-turn-boundaries`, `complex-agent-turn` |
| 문맥·재접속·등록 모델 | `agent-turn-previous`, `agent-turn-compact`, `agent-turn-window-flow`, `model-input-profile-runtime`, `registered-agent-flow` |
| 목표 변경·빠른 응답·입구 | `agent-goal-change`, `agent-goal-change-compact`, `agent-goal-change-cli`, `agent-turn-cli`, `agent-turn-web`, `web-view-state` |

`session-flow-helpers`와 `session-compact-flow-helpers`의 임시 registry는 이미 연결했다. `agent-turn-flow-helpers`와 직접 profile/store를 여는 flow·complex·profile·registered-flow·compact·window·goal-compact·web 및 CLI 두 파일은 같은 fixture registry 주입이 필요하다. 기존 판정·원문·모드·시험 수를 유지하고 CLI는 기존 isolated worker를 재사용한다.

확인한 제품 연결 누락은 `runAgentCli`의 `chat` 분기가 trusted `hostOptions`를 `runAgentTurnCli`에 전달하지 않는 점이다. 하위 profile은 이미 `identityRegistryDirectory`를 지원한다. 수정할 때 `runAgentTurnCli`의 기본 `createLocalContractHost()`를 단순 registry 객체로 대체하면 안 된다. 기존 모델·도구 등록을 보존하며 registry만 병합하거나 별도 trusted 인자로 전달한다. 아직 수정·빌드·시험하지 않았다.

이 묶음은 합성 응답과 로컬 실행 연결을 확인한다. 실제 모델 추론 품질·사내 서비스·원격 플랫폼 인수는 별도다. C03의 남은 복구 경계를 기록한 뒤 순차 진행하며 통과한 C01~C03 묶음을 이유 없이 다시 실행하지 않는다.
