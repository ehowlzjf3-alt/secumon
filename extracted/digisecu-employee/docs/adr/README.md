# ADR (Architecture Decision Records)

M0에서 확정한 근간 결정. 상세 근거·검증은 [../DISCOVERY-AND-DECISIONS.md](../DISCOVERY-AND-DECISIONS.md).

| # | 제목 | 상태 |
|---|------|------|
| [0001](0001-web-stack.md) | 웹 스택 = React/TS 풀스택 (paperclip식) | Accepted |
| [0002](0002-dynamic-pod-approach.md) | 동적 파드 = CRD `kind: DigitalEmployee` + 오퍼레이터 (접근 B) | Accepted |
| [0003](0003-dual-scheduler-owner.md) | 이중 스케줄러 주인 = 하이브리드 | Accepted |
| [0004](0004-operator-language.md) | 오퍼레이터 = Go kubebuilder/controller-runtime | Accepted |
| [0005](0005-control-plane-and-db.md) | 컨트롤플레인 = TS Express + 별도 Postgres DB | Accepted |
| [0006](0006-workplaces.md) | 출근지 = 자체 web 전량 · 등록형 · 디렉토리 분리 | Accepted |
| [0007](0007-relax-no-modify-and-management-ui.md) | 무수정 완화 · 단일 관리 UI · 파드 순수 워커 · 조합형 섹션 | Accepted |
| [0008](0008-agent-taxonomy-and-org.md) | 에이전트 taxonomy · 오케스트레이션 조직 · A2A/DB 통신 | Accepted |
