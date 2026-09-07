# C05 순차 검증 준비

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

- checkpoint364의 `writeTools/computerTools`가 일반 CLI/Web host 조립을 통해 실제 실행기로 이어지는지 확인한다. 기존 `composeRuntime.computerTools` 직접 주입 시험만으로 이 입구를 통과 처리하지 않는다.
- `runtime/evidence/C05-mcp-collections-custody-staging`의 crash-tests 6개와 drain-tests 4개 후보는 미통합·미실행이다. 현재 정본과 대조해 재사용한다. body-tests의 resume 사본은 이미 정본 A/B에 포함되어 있으므로 다시 적용하지 않는다. 일반 CLI/HTTP custody 인수도 별도로 남는다.
- [문맥 비용 검토](C05-context-cost-review.md)는 기준선과 후보다. 발견·퇴출의 기능 시험을 I/O·토큰 절감의 측정 결과로 대신하지 않는다. 일반 collection 입구의 부분 연결 대기와 저수준 deferral/retryAt도 구분한다.

일반 profile을 여는 `host-tool-profile-helper`, `host-tool-entry-fixture`, `mcp-agent-profile-helper`, custody/offline/close fixture, stored-result worker, collection entry fixture/worker에는 동일한 임시 identity registry를 전달해야 한다. 기존 모델·도구 host 등록은 유지한다. 직접 임시 저장소를 사용하는 컴퓨터 코어·collection A/B·wait 시험은 이 변경이 필요 없다.

과거 A/B의 54/54·관련113/113 및 MCP/Linux 결과는 당시 소스 이력이다. 이번 목록을 새 시험 통과나 실제 사내 서비스 연결로 표시하지 않는다. 모델/API 시험 중단을 유지한다.
