# deploy/k8s/ — kustomize base/overlays + CRD + per-employee 템플릿 (M3)

M3에서 구축(M0 플레이스홀더). secu-agent-skill의 상시 Deployment 모델(`agents.yaml`)은 **복제하지 않고** 참조만.

구성(M3 예정):
- `crd/` — `DigitalEmployee` CustomResourceDefinition.
- `base/` — namespace, ServiceAccount/RBAC(최소권한), ResourceQuota/LimitRange, 오퍼레이터 Deployment.
- `overlays/` — {local(kind/k3d), k3s} 환경별.
- per-employee 파드 템플릿: non-root(uid 10001) securityContext 계승, read-only rootfs 지향, 시크릿 스코프 주입, MCP 구성.

관측성(metrics-server/Loki/kube-prometheus)·Argo CD(GitOps)는 M3에 함께 도입(ADR 0002 결과).
