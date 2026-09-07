# operator/ — Go kubebuilder 오퍼레이터 (M3)

접근 B(ADR 0002) + Go kubebuilder(ADR 0004)에 따른 reconcile 오퍼레이터. **M3에서 구축**(M0에서는 플레이스홀더).

M3 착수 시:
- `kubebuilder init` + `kubebuilder create api --group digisecu --version v1alpha1 --kind DigitalEmployee`
- Reconciler: CR spec(desired: Running/Paused/budget/domain/persona) → Pod(상시) / Job(단발) reconcile.
- status subresource로 파드 상태를 컨트롤플레인에 노출. finalizer로 terminate 시 graceful drain(SIGTERM→grace→SIGKILL) + PVC/Job GC.
- 로컬/목: envtest 또는 kind/k3d. 실 k3s(v1.36+k3s1)는 이 머신에 설치됨.

> 엔진/스킬 무수정 원칙: 파드는 secu-agent 이미지 + `SA_PLUGINS`/`SA_SKILLS_DIRS`/`profile`/MCP env 주입으로만 구성.
