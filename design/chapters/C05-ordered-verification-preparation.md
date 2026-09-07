# C05 순차 검증 준비

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
- `runtime/evidence/C05-mcp-collections-custody-staging`의 crash-tests 6개와 drain-tests 4개 후보는 미통합·미실행이다. 현재 정본과 대조해 재사용한다. body-tests의 resume 사본은 이미 정본 A/B에 포함되어 있으므로 다시 적용하지 않는다. 일반 CLI/HTTP custody 인수도 별도로 남는다.
- [문맥 비용 검토](C05-context-cost-review.md)는 기준선과 후보다. 발견·퇴출의 기능 시험을 I/O·토큰 절감의 측정 결과로 대신하지 않는다. 일반 collection 입구의 부분 연결 대기와 저수준 deferral/retryAt도 구분한다.

일반 profile을 여는 `host-tool-profile-helper`, `host-tool-entry-fixture`, `mcp-agent-profile-helper`, custody/offline/close fixture, stored-result worker, collection entry fixture/worker에는 동일한 임시 identity registry를 전달해야 한다. 기존 모델·도구 host 등록은 유지한다. 직접 임시 저장소를 사용하는 컴퓨터 코어·collection A/B·wait 시험은 이 변경이 필요 없다.

과거 A/B의 54/54·관련113/113 및 MCP/Linux 결과는 당시 소스 이력이다. 이번 목록을 새 시험 통과나 실제 사내 서비스 연결로 표시하지 않는다. 모델/API 시험 중단을 유지한다.
