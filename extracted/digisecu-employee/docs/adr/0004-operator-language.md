# ADR 0004 — 오퍼레이터 언어: Go kubebuilder / controller-runtime

- 상태: Accepted (M0)
- 관련: ADR 0002, DISCOVERY-AND-DECISIONS §8(3b)

## 맥락
접근 B(CRD/오퍼레이터, ADR 0002) 채택으로 reconcile 오퍼레이터의 언어/프레임워크를 결정해야 함. 후보: Go kubebuilder, Python kopf, TS 자체 컨트롤러.

## 결정
**Go kubebuilder / controller-runtime**.
- `operator/` 디렉토리에 kubebuilder 프로젝트. CRD `kind: DigitalEmployee`(group/version 추후 확정) + Reconciler.
- 로컬/목: envtest 또는 kind/k3d로 M1~M3 검증(실 k3s는 이 머신에 이미 설치됨 — v1.36+k3s1).

## 근거
- controller-runtime은 k8s 오퍼레이터의 사실상 표준으로 가장 성숙·견고(reconcile·watch·finalizer·status subresource 일급 지원).
- CRD 검증·webhook·RBAC 생성 등 툴체인 완비.

## 결과
- **스택이 3언어**가 됨: TS(web·control-plane·contracts) / Go(operator) / Python(M4 도메인 게이트웨이·엔진 attach). 유지보수 인력 부담을 수용.
- 컨트롤플레인(TS)↔오퍼레이터(Go) 계약은 CRD 스키마(YAML/OpenAPI v3)가 경계. zod 계약과 CRD 스키마의 정합은 M3에서 codegen/검증 게이트로 관리.
- 폐기안: Python kopf(런타임 단순하나 성숙도↓), TS 오퍼레이터(언어 일원화되나 생태계 얇음).
