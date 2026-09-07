# ADR 0002 — 동적 파드 라이프사이클: CRD + 오퍼레이터 (접근 B)

- 상태: Accepted (M0)
- 관련: §3-1, DISCOVERY-AND-DECISIONS §6

## 맥락
secu-agent-skill의 현행 k3s 모델은 파이프라인 역할별 상시 Deployment(replicas:1) 4종으로, "임직원당 동적 파드"가 아니다. 요구는 채용/삭제 시 파드가 증분되는 임직원 단위 동적 프로비저닝. 접근 A(컨트롤러가 k8s API로 Pod/Job 직접), B(CRD/오퍼레이터), C(KEDA scale-to-zero) 비교.

## 결정
**접근 B**: `kind: DigitalEmployee` CRD + reconcile 오퍼레이터.
- 컨트롤플레인이 CR **spec**(desired: `Running`/`Paused`/budget/도메인/페르소나) 작성.
- 오퍼레이터가 CR → Pod(상시형) / Job(단발형)로 reconcile.
- 컨트롤플레인은 CR **status subresource + heartbeat**로 관측. 예산 하드스톱 = spec을 `Paused`로 patch.
- 매핑: 1임직원 = 1도메인 전담 = 1상시 파드, 단발 업무는 자식 Job(TTL GC).

## 근거
- 선언적·k8s-native → GitOps(Argo CD) 친화, 재조정 자동.
- 하이브리드 스케줄러(ADR 0003)와 정합: 회사(컨트롤플레인)가 desired 상태·예산·생명 통제, 파드 내부는 자율 업무.
- 초기 비용은 MVP엔 접근 A보다 크나(오퍼레이터 구축), 사용자 결정으로 선언적 경로 채택.

## 결과
- 로컬/목 ⇄ k3s 드라이버 경계 필수: 오퍼레이터 리컨사일러를 mock(in-process) 또는 kind/k3d로 M1~M3 상태기계 검증 후 실 k3s 전환.
- 파생 결정: 오퍼레이터 언어(ADR 0004 = Go kubebuilder).
- 상태기계: `hire(승인)→Provisioning→Running ⇄ Paused / →(heartbeat 실패 N)→Unhealthy→재프로비저닝|Alert / terminate→Draining(SIGTERM→grace→SIGKILL)→Deleted(파드/PVC/Job GC)`.
- 로드맵: KEDA scale-to-zero(C)는 후순위.
- 참조: paperclip `packages/plugins/sandbox-providers/kubernetes/`(pod-spec-builder·job-orchestrator·kube-client·cilium)를 파드 스펙/GC 패턴으로 차용.
