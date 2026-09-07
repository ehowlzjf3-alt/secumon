# digisecu-employee

**DS 디지털 임직원 플랫폼** — "보안 업무를 하는 소프트웨어"가 아니라 **DS에 입사해서 일하는 디지털 직원**의 경험.

> web은 대시보드가 아니라 **HR + 매니저 콘솔 + 직원의 책상**이다.
> SMB 등 보안 업무 로직은 `secu-agent-skill`에 이미 완성돼 있으므로 **재구현하지 않고 연동**한다.

## 무엇을 만드는가
(a) 임직원/조직 컨트롤 플레인 + (b) 그것을 보여주는 완결성 있는 web + (c) 임직원을 k3s 위 독립 파드로 동적 생성/삭제하는 라이프사이클 + (d) 기존 secu-agent 엔진/스킬을 업무 런타임으로 붙이는 어댑터.

## 디지털 임직원 6단계 서사
채용·온보딩 → 페르소나 → 업무 위임 → 상태 가시성 → 상사에게 보고 → 거버넌스.

## 아키텍처 (요약)
```
[브라우저] → (A) web(React/TS) → (B) control-plane(Express/TS, 별도 Postgres)
                                     │
                                     ├─ (C) operator(Go kubebuilder): kind: DigitalEmployee CRD → Pod/Job
                                     └─ (E) contracts(zod 단일 진실원)
(D) Agent Pod = 임직원 1명: secu-agent 엔진(무수정) + SA_PLUGINS(secu-agent-skill) + 페르소나 + MCP
```
- 상세 발견/결정: [docs/DISCOVERY-AND-DECISIONS.md](docs/DISCOVERY-AND-DECISIONS.md) · ADR: [docs/adr/](docs/adr/)
- 워커가 실제로 호출하는 LLM 백엔드: [docs/LLM-BACKEND.md](docs/LLM-BACKEND.md) (서빙 인프라 구성은 이 저장소 밖 — private-llm-hands-on)

## 리포 구조
| 디렉토리 | 역할 | 언어 | 상태 |
|---|---|---|---|
| `web/` | HR+매니저 콘솔+직원의 책상 | TS (React19+Vite+Tailwind) | M0 골격 |
| `control-plane/` | 회사 API | TS (Express5+Drizzle) | M0 골격 |
| `contracts/` | 공유 스키마 단일 진실원 | TS (zod) | M0 골격 |
| `operator/` | CRD + reconcile 오퍼레이터 | Go (kubebuilder) | M3 |
| `deploy/k8s/` | kustomize + CRD + 파드 템플릿 | YAML | M3 |
| `docs/` | 발견/결정/ADR | — | — |
| `domain-gateway/` | state_domain read 게이트웨이 | Python (FastAPI) | M4 |

> `secu-agent` / `secu-agent-skill` 은 복제하지 않고 **이미지 빌드 시 attach**(PYTHONPATH + SA_PLUGINS).

## 개발 (M0)
```bash
pnpm install
pnpm dev            # control-plane(:8080) + web(:5173) 동시 기동
# web http://localhost:5173 에서 control-plane 연결 배지 확인
```
개별 기동: `pnpm dev:control-plane` / `pnpm dev:web`. 타입체크: `pnpm typecheck`.

## 마일스톤
- **M0** 킥오프·결정·골격 스캐폴드 ← 현재
- M1 완결성 web 골격(mock 데이터, 8화면) — 사용자와 화면 루프
- M2 컨트롤플레인 실체화(라이프사이클·승인·예산·감사)
- M3 k3s 동적 파드(CRD + 오퍼레이터, 로컬/목 → k3s)
- M4 SMB 도메인 연동(재구현 아님) + Python 도메인 게이트웨이
- M5 Knox 개별 ID 메일 구성
- M6 도메인 확장(dev_web → github → confluence)

## 안전 가드레일 (상시)
엔진/스킬 무수정 · SMB 재구현 금지 · `application`은 infra/web import 금지 · 도메인 상태는 `state_domain` 유일 경로 · 읽기전용/크리덴셜 기록만/POP3 수동+DELE 금지/PII 마스킹/egress 허용목록/autosend fail-closed · 파드 non-root(uid 10001) · 실계정/실타깃/실 k3s 연결 전 사용자 확인.
