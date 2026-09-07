# C05 순차 검증 준비

## Checkpoint374 — 도구·기억·스킬의 선택과 정리

실행 완료: 이 단계의 기존 451개와 신규 crash/drain10개가 통과했다. 이전201개를 포함한 선택 고유662개이며 실행별 소스 범위는 [결과](C05-ordered-verification-result.md)에 구분했다. 남은 것은 collection custody-only 일반 CLI/HTTP 인수와 현재 소스 비용 최적화 측정·검증이다. 아래 당시 준비 목록을 전체 미실행 목록으로 해석하지 않는다.

이전 단위는 `0ceef23`으로 코드·결과·잔여 기록을 게시했다. 이번에는 전체 도구 본문을 항상 문맥에 넣지 않고 발견 카드 → 필요한 본문 조회 → 현재 출처 검증 → 재사용 또는 미사용 정리로 이어지는 기존 기능을 확인한다. 기억의 담당 격리와 접근 철회, 스킬 원본/버전 변경, 실제 사용에 따른 문맥 유지·퇴출, 같은 결과 재사용의 정산을 아래 기존 8파일로 검증한다. 기능 시험과 실제 토큰/I/O 절감 측정을 구분한다.

`tool-catalog-lifecycle`, `tool-efficiency-runtime`, `knowledge-tools`, `evidence-discovery`, `guidance-lifecycle`, `guidance-resource-lifecycle`, `context-guidance`, `context-selection`을 checkpoint373 build3의 고정 산출물에서 실행한다. 이들과 독립적으로 C03 복구 관리 오류/CLI 인수를 작성하고, 후속 MCP profile fixture의 임시 registry/종료 연결을 정리한다. 이미 확인한 C05 host/computer 묶음은 다시 실행하지 않는다. 실행·수정 결과는 체크포인트와 결과 문서에 별도로 추가한다.

## Checkpoint373 — 일반 쓰기·컴퓨터 host 입구

실행 완료: 신규 26개와 관련 175개, 선택 고유 201개를 확인했다. 첫 관찰의 준비 진전 누락과 시험 fixture를 교정했다. [실행 결과·소스별 범위](C05-ordered-verification-result.md). 아래 준비 목록 중 host·컴퓨터 선택 묶음은 이 결과를 따르며, 전체 목록을 다시 실행할 필요는 없다. 도구·기억·스킬 및 MCP 후속과 crash/drain 인수는 남아 있다.

도구 등록과 실제 업무 실행 연결을 분리해 확인한다. 기존 host 조립·StructuredAgentTurnAdapter·CLI/Web·SyntheticComputerDriver를 재사용한다. 임시 파일에 쓰는 어댑터는 원문 artifact와 효과 영수증을 직접 대조하며, 컴퓨터 어댑터는 기존 관찰·두 단계 입력·결과 검증을 사용한다. SQLite/file-journal 담당에서 CLI의 쓰기와 로컬 HTTP의 컴퓨터 실행을 확인하고 같은 업무 재접속에서 입력 횟수가 늘지 않는지 검사한다. 쓰기 허가가 없는 경우 실제 입력이 없어야 한다. 실제 모델·사용자 화면·사내 서비스는 호출하지 않는다.

기존 host profile/entry fixture는 임시 registry를 공유하도록 수정한다. 별도 등록 시험은 명시 writeTools/computerTools, 영수증 reader와 계약 검증, 충돌/권한 거절을 확인한다. 기존 기능을 다시 구현하지 않고 입구에서 드러나는 결함만 제품에 반영한다. 실행·수정 결과는 후속 기록으로 남긴다.

2026-09-08 · checkpoint372의 읽기 검토다. 현재 C03/C04 실행 뒤 사용할 목록이며 C05 후속 시험을 실행한 결과는 아니다. 아래 파일은 `runtime/src/tests/<이름>.test.ts`에 있다.

| 확인 범위 | 재사용할 기존 시험 |
| --- | --- |
| 일반 host·쓰기 증명 | `host-tools`, `host-provider-tools`, `host-tool-profile`, `host-tool-entry`, `effect-proofs` |
| 컴퓨터 관찰·행동·증명·재개 | `computer-use`, `computer-use-proof`, `computer-use-recovery` |
| 도구·기억·스킬 발견과 정리 | `tool-catalog-lifecycle`, `tool-efficiency-runtime`, `knowledge-tools`, `evidence-discovery`, `guidance-lifecycle`, `guidance-resource-lifecycle`, `context-guidance`, `context-selection` |
| MCP 원응답 보관·서버 없는 재개 | `mcp-read-tools`, `mcp-response-capture`, `mcp-stored-result-recovery`, `mcp-custody-entry`, `mcp-custody-profile-close`, `mcp-offline-entry` |
| Collection·page·wait | `mcp-collection-host-tools`, `mcp-stored-read-collections`, `mcp-collection-entry`, `mcp-read-waits`, `mcp-read-waits-recovery`, `mcp-read-settlement-recovery` |
| Collection custody A/B | `mcp-collection-custody`, `stored-read-usage`, `mcp-collection-accounting`, `mcp-collection-custody-context`, `mcp-collection-custody-resume` |

별도로 메울 인수 공백은 다음과 같다.

- checkpoint364의 `writeTools/computerTools` 일반 CLI/Web host 연결은 이번 로컬 인수에서 확인했다. 실제 모델·GUI·사내 연결과 플랫폼 인수는 별도다.
- `runtime/evidence/C05-mcp-collections-custody-staging`의 crash6/drain4 후보는 checkpoint374에서 정본에 통합·검증했다. body-tests의 resume 사본은 이미 정본 A/B에 포함되어 있어 다시 적용하지 않았다. collection custody-only 일반 CLI/HTTP 인수는 별도로 남는다.
- [문맥 비용 검토](C05-context-cost-review.md)는 기준선과 후보다. 발견·퇴출의 기능 시험을 I/O·토큰 절감의 측정 결과로 대신하지 않는다. 일반 collection 입구의 부분 연결 대기와 저수준 deferral/retryAt도 구분한다.

일반 profile을 여는 `host-tool-profile-helper`, `host-tool-entry-fixture`, `mcp-agent-profile-helper`, custody/offline/close fixture, stored-result worker, collection entry fixture/worker에는 동일한 임시 identity registry를 전달해야 한다. 기존 모델·도구 host 등록은 유지한다. 직접 임시 저장소를 사용하는 컴퓨터 코어·collection A/B·wait 시험은 이 변경이 필요 없다.

과거 A/B의 54/54·관련113/113 및 MCP/Linux 결과는 당시 소스 이력이다. 이번 목록을 새 시험 통과나 실제 사내 서비스 연결로 표시하지 않는다. 모델/API 시험 중단을 유지한다.
