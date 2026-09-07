# C04 순차 검증 준비

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
