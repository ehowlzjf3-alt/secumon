# C09 여러 임무의 종료와 완료 직후 복구 결과

2026-09-08 · checkpoint383 · 기준선 `32739e5fab460fc9fd4e1de07bce6d21dae7b69a`.

업무 완료 직후 중단돼도 다음 임무 tick에서 **남은 종료 기록만 저장**하도록 수정했다. 여러 규칙의 체크포인트 본문을 마감하고 점유를 해제하며, 원 사건·커서·읽기 확인·실행 사용량·답변을 보존한다. 담당의 세션을 지우거나 완료한 모델·도구 호출을 다시 실행하지 않는다. C09 전체와 전체 goal의 완료 판정은 아니다.

## 구현

- `MissionRuntime.completedProof`가 실제 `control_selected` 완료 사건과 영수증을 찾는다. 현재 revision에서 완료 commandId를 추측하지 않는다. 담당·정책·목표·세션·자료 세대와 원 완료 상태를 대조한다.
- 완료 후 이미 저장된 각 종료 체크포인트를 사건 순서대로 확인하고 전체 WorkState 변화를 재구성한다. 허용된 마감 외에 계획·근거·사용량·다른 제공자 등이 달라졌으면 복구를 거절한다. 비교에서 업무 필드를 제외하지 않는다.
- 원 완료 시점에 활성인 규칙은 본문의 `status`, `reason`, `claim`, `pendingRun`만 종료 값으로 바꾼다. 사건이 있는 규칙에는 기존 원문 읽기 확인이 필요하다. 비어 있는 대기 규칙은 실행 점유 없이 닫고, 이미 호스트가 닫은 규칙의 원문·이유·체크포인트는 그대로 둔다.
- 정상 workflow 반환 뒤와 완료 업무의 재시작 tick이 같은 정리 경로를 사용한다. 일반 `notifications.refresh`와 공개 원문 읽기 검사는 유지한다. 중복 commit 반환 뒤에도 실제 최신 상태를 다시 검사하며, 정상 마감 경쟁은 최대 32회 안에서 재조회한다. 구독 한도는 기존 16개다.
- 일부 마감 게시 후 예외가 나면 성공으로 꾸미지 않고 호출자에게 전파한다. 다음 tick/reopen이 같은 원 완료→마감 기록을 검증하고 남은 규칙만 처리한다. 파일 저널의 `journal_commit_unknown`도 미게시로 단정하지 않는다. 다만 이번에는 SQLite의 실제 게시 후 예외를 시험했으며 해당 파일 저널 오류 자체를 주입해 실행하지 않았다.

제품 수정은 [mission-runtime.ts](../../runtime/src/application/mission-runtime.ts) 한 파일이다. 기존 담당·세션·저장소·임무 입구와 로컬 시험 모델을 재사용했다.

## 실행한 검증

Node **v24.20.0 / darwin arm64**, 같은 최종 build3에서 신규 **12/12**과 직접 관련 **22/22**, 합계 **34/34**이 통과했다. 실제 모델/API 호출은 하지 않았다.

| 실행 | 결과 | 범위 |
| --- | --- | --- |
| `npm run build` | exit0 | TypeScript 전체 빌드와 산출물 기록 |
| 신규 terminal recovery | 11/11 | 다중 규칙, 반환 후 예외, 원 영수증 오류 4개, 일부 마감 중단, idle/기존 종료 보존, 무관한 예산/구독 삭제 거절 2개, 동시 tick |
| 신규 POSIX 강제 종료 | 1/1 | 실제 완료 후 종료 게시 전 SIGKILL, 같은 SQLite 담당 재열기 |
| 기존 관련 시험 | 22/22 | 임무 runtime 9, 원문 ACK/완료 5, 상시 담당 입구 6, 게시판/임무 결합 2 |
| `npm run typecheck:core` | exit0 | 코어 타입 검사 |
| `npm run check:architecture` | 198개/위반0 | 코어 의존 경계 |

강제 종료 시험은 자식 프로세스의 원 완료 영수증·원 체크포인트·사건·전달·사용량을 관측 파일과 대조한 후 실제 SIGKILL을 보낸다. 종료/close를 확인하고 같은 SQLite 담당을 다시 연다. 복구의 모델·도구·원천 poll·send/lookup은 추가 0회이며 원 3회 모델·2회 도구 사용량을 유지한다. 종료 전 claim 기간을 줄이거나 완료 상태를 시험에서 직접 만들지 않았다. 이는 현재 macOS의 POSIX 프로세스 중단 시험으로, 정전·Linux·native Windows 검증은 아니다.

수정 전 build1은 exit0이었지만 당시 준비한 7개는 **0통과/7실패**했다. 활성 본문이 남는 실제 중단/다중 규칙 문제와 완료 영수증을 확인하지 않는 조기 반환을 재현했다. 뒤에 추가한 부분 마감·idle/기존 종료·무관 변경·동시 tick 4개는 이 최초 7개에 포함되지 않는다. build2에서는 신규11·관련22가 통과했다. 이후 검토에서 임무 목록이 비면 완료 영수증 검사를 건너뛰는 경로를 제거하고, 완료 후 임무 목록 삭제 거절 1개를 추가했다. 최종 build3에서 신규12·관련22를 모두 확인했다. 실패 원로그를 보존하며 기준선 실패를 최종 통과 수에 더하지 않는다.

[실행 체크포인트](../../runtime/evidence/checkpoint383.json) · [빌드](../../runtime/evidence/C09-terminal-build3.log) · [신규 시험](../../runtime/evidence/C09-terminal-target3.log) · [관련 시험](../../runtime/evidence/C09-terminal-target3.log) · [최종 소스 대조](../../runtime/evidence/checkpoint383-final-source.json).

소스 지문은 `bbb11a312e4f9def1dc71cdc13e569b5033c09a5c4aec84c89df8a85c71972d7`이며 산출물 2,331파일이 대조 일치했다. 모든 최종 34개는 이 빌드에서 실행했다. 앞선 checkpoint382의 115개와 합쳐 현재 소스 전체 검증으로 표시하지 않는다.

## 다음과 한계

다음은 C10의 **서로 다른 유효 release**를 이용한 check→pin→backup→update→동일 신원·세션·기억 재열기다. 같은 release의 경로만 바꾸는 no-op은 업데이트 인수가 아니다.

이번은 실제 완료 영수증에 근거한 임무 마감이다. 취소·목표 변경·일시정지의 종료 의미, 파일 저널 응답 불명 주입, 장기 기록 조회 비용은 별도 검토 범위다. C05 정책 재허용 후 완주, C06 기억 HTTP 지연·권한 사용성과 브라우저, 현재 Linux/native Windows, 실제 PostgreSQL·사내 MCP/Knox·외부 A2A·운영 설치·최종 통합은 남아 있다. 실제 모델/API 시험 중단을 유지하고 외부 서비스 연결은 0회다.

메인 프롬프트는 [공통 지침](../../runtime/src/infrastructure/agent-turn-prompt.ts)에 구현돼 [모델 어댑터](../../runtime/src/infrastructure/structured-agent-turn.ts)에 연결돼 있다. 현재 소스 확인과 실제 모델의 응답·추론 품질 검증은 구분한다. 이번 단위에서 프롬프트를 다시 만들거나 변경하지 않았다.
