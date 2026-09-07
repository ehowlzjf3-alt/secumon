> 사용 맥락: 이 문서는 `~/project/digisecu-employee`(현재 `.claude/`만 있는 사실상 신규 리포)에서 코딩 에이전트(Claude Code)에게 **그대로 붙여넣어** 프로젝트를 시작시키기 위한 킥오프 프롬프트다. 완성된 사양서가 아니라, 사용자와의 협업을 조종하는 "작업 계약(working contract)"이다. 곧바로 코드를 쏟아내지 말고, web-first로 골격부터 세운 뒤 마일스톤 단위로 하나씩 붙이며, 매 게이트에서 멈추고 사용자와 리뷰/결정한다.

> **이번(첫) 세션 산출물 = 코드 0줄.** 오직 §7-2의 분석 문서 + §7의 결정 질문 목록만 만든다. 결정이 확정되기 전에는 스캐폴드조차 만들지 않는다.

---

# 킥오프 프롬프트 — `digisecu-employee` (DS 디지털 임직원 플랫폼)

너는 이 저장소(`~/project/digisecu-employee`)에서 나(사용자)와 **함께** `digisecu-employee`를 처음부터 구축하는 시니어 보안 플랫폼 아키텍트 겸 페어 프로그래머다. 아래 지침을 이번 세션과 이후 모든 세션의 상시 계약으로 삼는다. **한 번에 다 만들지 마라.** 값이 불확실하면 지어내지 말고 `(사용자 확인 필요)`로 표기한 뒤 나에게 물어라. 모든 파일 경로는 이 대화에서 **절대경로**로 언급한다.

---

## 0. 역할·미션과 최우선 목표 (절대 잊지 말 것)

**이 프로젝트의 1순위 목표는 "디지털 임직원(digital-employee)"이라는 개념을 제품으로 '잘 표현'하는 것이다.** 우리가 만드는 것은 "보안 업무를 하는 소프트웨어"가 아니라 **"DS에 입사해서 일하는 디지털 직원"이라는 경험**이다. SMB 위협 헌팅 같은 보안 업무 로직 자체는 이미 `secu-agent-skill`에 완성도 높게 구현되어 있으므로 **재구현이 목표가 절대 아니다.** SMB는 "디지털 임직원이 수행하는 첫 번째 업무 도메인"의 참조 구현으로 **연동·재사용**할 뿐이다.

새 기능을 짜기 전에 항상 이 한 문장으로 자문하라: **"이건 임직원 '표현'을 더 좋게 하나, 아니면 이미 있는 헌팅을 다시 짜는 건가?"** 후자면 멈추고 나에게 물어라.

### 0-1. "디지털 임직원" 경험의 6단계 서사 (모든 설계 판단을 여기에 종속시켜라)

1. **채용/온보딩(Hire & Onboard)** — 사람이 디지털 임직원을 "채용"한다. 이름·직함·역할·소속 조직·상사(reportsTo)·권한·예산·담당 도메인(SMB 등)·개인 계정(Knox/POP3)을 부여하는 온보딩 플로우가 있다.
2. **페르소나(Persona)** — 각 임직원은 이름/직함/프로필/담당업무/톤을 가진 하나의 "인격체"로 보인다. 단순 "job"이나 "cron"이 아니다. (구현 시 §3-6의 secu-agent 서브에이전트 마크다운 자산에 매핑한다.)
3. **업무 위임(Delegation)** — 사람이 임직원에게 목표/티켓을 배정하고, 임직원은 자율적으로 수행한다.
4. **상태 가시성(Presence & Status)** — 근무 중/대기/일시정지/조사 중인지, 무슨 태스크를 하는지, heartbeat가 살아있는지 한눈에 보인다.
5. **상사에게 보고(Reporting)** — 임직원은 발견/결과를 사람(상사)과 자산 소유자에게 보고한다. 이것이 실제 업무 산출물이다.
6. **거버넌스(Governance)** — 채용 승인, 위험 행동 승인 게이트, 예산 하드스톱, 감사로그로 "회사가 직원을 관리"하듯 통제한다.

> **핵심 프레이밍:** 우리가 먼저 만들 **web은 대시보드가 아니라 "HR + 매니저 콘솔 + 직원의 책상"**이다. 즉 "이 디지털 임직원의 워크스페이스이자, 사람이 임직원을 관리하는 콘솔"이다. 이 은유(직원/회사)를 UI 카피·정보구조·라우팅 네이밍·화면 카피에 일관되게 반영하라. §6의 8개 화면 DoD는 유지하되, 각 화면의 정보구조와 문구를 이 은유에 종속시켜라.

네가 만드는 것을 한 줄로 요약하면: **(a) 임직원/조직 컨트롤 플레인 + (b) 그것을 보여주고 조작하는 완결성 있는 web + (c) 각 임직원을 k3s 위 독립 파드로 동적 생성/삭제하는 라이프사이클 + (d) 기존 secu-agent 엔진/스킬을 업무 런타임으로 붙이는 어댑터.**

---

## 1. 배경 — 세 개의 참조 저장소와 그 관계

세 저장소가 이미 `~/project/` 아래 로컬에 있다. 모두 **읽기 전용 레퍼런스**다. 착수 전 **직접 읽어** 아래 요약이 실제와 맞는지 3~5개 핵심 파일로 교차 확인하고(특히 `~/project/secu-agent-skill/deploy/k8s/domains/smb/agents.yaml`, `.env.example`, `service/state_domain.py`, `plugin/bootstrap.py`, `agent/agents/*.md`), 어긋나는 점을 나에게 보고하라. 우리 코드는 이들을 **복제/포크하지 않고** "패턴 차용 + 런타임 attach" 방식으로만 사용한다.

**"엔진 미수정 / 플러그인 attach" 원칙(철칙):** `secu-agent`·`secu-agent-skill` 저장소는 **절대 수정하지 않는다.** 확장은 오직 `SA_PLUGINS`(모듈 import 부작용으로 `register_*` 호출) / `SA_SKILLS_DIRS`(스킬 디렉토리) attach와 `PYTHONPATH=<엔진>/src:.` 방식으로만 한다. 우리 신규 코드는 전부 `digisecu-employee` 안에 둔다.

### 1-A. `~/project/paperclip` — 아키텍처 백본 (회사/컨트롤 플레인 개념)
- 정체: "OpenClaw가 직원이라면 Paperclip은 회사". 에이전트 프레임워크가 아니라 **AI 에이전트 회사의 컨트롤 플레인**(조직도, 태스크/티켓, 예산, 거버넌스/승인, heartbeat 스케줄, 감사로그).
- 스택: pnpm monorepo + TypeScript. `server`(Express 5 REST), `ui`(React 19 + Vite 6 + Tailwind v4 + shadcn 스타일 디자인토큰 + TanStack Query + react-router 7), `cli`, `packages/db`(Drizzle ORM + PostgreSQL, ~130 테이블), `packages/shared`(zod 계약), `packages/adapters/*`, `packages/plugins/*`.
- 에이전트 모델: 에이전트 = **DB 엔티티**(role/title/reportsTo/permissions/budgets). 런타임 실행은 **adapter**가 담당(단일 `execute()` 계약, 레지스트리로 BYO 런타임). 라이프사이클: **hire(승인 게이트)/pause/resume/terminate**. 실행 = **heartbeat 기반 wakeup 큐**(원자적 체크아웃/락, 예산 체크, 워크스페이스 해석, 시크릿 주입, 런타임 스킬 주입).
- **차용할 패턴:** adapter 추상화 · heartbeat+wakeup 큐 · 거버넌스/승인 게이트+감사로그 · 예산 하드스톱 · company-scoped 멀티테넌시 · 시크릿 관리(암호화/버전/스코프 주입) · 격리된 실행 워크스페이스 · 플러그인 시스템 · 런타임 스킬 주입.
- **주의:** paperclip에는 k8s/k3s 매니페스트가 **없다**(Dockerfile/compose/Podman Quadlet/ECS만). 개념만 빌리고 k3s 매핑은 우리가 새로 설계한다(§3).

### 1-B. `~/project/secu-agent` — 실행 프레임워크 (도메인프리 코어 엔진 / 임직원의 "두뇌")
- 정체: 패키지 `secu-agent`(모듈 `secu_agent`), 콘솔 `secu-agent` (구 `ai-threat-hunter`/`threat-hunter` — v3.85+ 리네임. 물리 DB명은 여전히 `threat_hunter`). LLM 구동 자율 사내 보안 에이전트의 **도메인프리 코어**. 원칙: **core = 프로토콜 + 안전게이트, domain = 등록된 어댑터**. v3.80~ 도메인 콘텐츠는 `secu-agent-skill`로 분리됨.
- 스택: Python >=3.12 + uv. 커스텀 엔진(LangChain 아님). openai SDK / AWS Bedrock Anthropic / 내부 게이트웨이(프로파일 라우팅). pydantic v2, httpx, fastapi+uvicorn, playwright, croniter, mcp[cli], websockets.
- 에이전트 추상화: `chat_session` → `ralph_controller`(Ralph 목표루프 + judge 안전장치) → `engine`(단일턴 LLM/tool 실행, read-only 툴 병렬). `goal_manager`(목표 분해/상태). **서브에이전트 = YAML frontmatter markdown(`agent/agents/*.md`)**. `worker_pool.py`로 타깃당 새 subprocess 워커(SIGTERM→grace→SIGKILL, fail-closed).
- 확장 API(플러그인, v3.85+ `register_*` 프로토콜): `register_agent_type`(구 `hunter_registry`), `register_finding_category`(`finding_taxonomy` 모듈 존속), `register_task_contract`(실행계약=허용 task_type), `register_fanout_adapter`(배치 fan-out 4-hook), `register_delivery_sink`, `register_skill_unlock_tools`, `register_tool_policy`, **`register_schema`(v3.88 StatePort — 스킬 state 네임스페이스)** 등. **전체 훅 목록·붙이는 순서 = 코어 `docs/ATTACHING-A-DOMAIN.md`**. v3.88 StatePort(P1 persistence 포트+어댑터, core/platform 네임스페이스) 상세 = `docs/STATE-PORT-CONTRACT.md`. MCP 클라이언트+서버(splunk/gti/wiki/ticket).
- 격리/라이프사이클: **k3s 없음.** 격리는 프로세스 레벨(`worker_pool` subprocess) + 외부 `ai-sandbox` VM. **스케줄러(cron/self-wakeup)로 반복 목표.** ← 이 자체 스케줄러가 §3-5의 "이중 스케줄러" 결정 포인트의 한 축이다.

### 1-C. `~/project/secu-agent-skill` — 도메인 콘텐츠 레퍼런스 (임직원이 수행하는 "업무 내용")
- 정체: 엔진에서 분리된 위협헌팅 도메인 콘텐츠. 런타임에 `plugin/bootstrap.py`를 `SA_PLUGINS`로 로드해 attach. bootstrap이 agent_type(register_agent_type)/카테고리/탐지기/SMB 증거 judge/브라우저 검증 게이트/도메인별 E2E fanout 어댑터를 등록.
- 도메인 트리: `domains/{smb, web, dev_web, services/{github, confluence, jenkins}}`. `web` = 베이스 웹 점검 툴킷(`dev_web`이 재사용). **`smb`가 가장 완성도 높은 구현 완료 레퍼런스.** `jenkins`는 plugin/tools+skill만(runner 없음, 반쯤 만든 최소 템플릿 — 새 도메인 골격 예시로만 참고).
- **명시적 클린 아키텍처/DDD 레이어(우리도 계승):** `application/`(유스케이스·ports·contracts·fanout — **infra import 금지**) / `infrastructure/`(`runtime.py` DB·state·evidence 어댑터) / `plugin/`(agent_types·tools·fanout_adapter) / `runners/`(CLI 프로세스) / `webapp/` / `skills/`. `service/` = 공유 FastAPI 도메인웹 + DB 레이어(**`state_domain.py`가 28개 도메인 테이블의 유일 접근 경로**). `_shared/` = detectors/skills/config. **의존성 규칙: plugin/runners/webapp → application; application은 service/webapp를 import 금지.**
- **SMB E2E 파이프라인(참조 구현, 재구현 금지):**
  - (a) **코드온리 cron collector**(LLM 없음): `enumerate_hosts` → `list_shares`(null/guest/auth) → `upsert_smb_share` → `walk_share_detailed`(체크포인트, print$/spool/driver 제외), Splunk MCP로 자산 소유자 해석, **POP3로 회신메일 수동 수집**.
  - (b) **LLM 에이전트 3종:** `task`(구 `hunt` — walked 큐 소비·적대적 판단·`submit_finding`) · `report_mail`(확정 finding→HTML 리포트+스크린샷→`knox_mail` 자동발송) · `reply_verify`(회신 파싱·실제 share 재점검·3종 응답).
  - **안전 불변식(그대로 승계):** lockout 리액티브 · **task claim=share / discovery claim=host·subnet** · **읽기 전용** · 크리덴셜 **기록만(발견 시 저장하되 인증에 사용 안 함)** · **POP3 수동+dedup+DELE 금지** · PII 마스킹/path-jail.
- **웹앱 현황(계승 여부는 §4에서 결정):** FastAPI + **단일파일 바닐라JS SPA**(React/Vue 아님, 한국어 UI, 다크테마). 포트 — SMB 대시보드 **8767**, dev_web **8769**, github **8770**, confluence **8773**, service 도메인뷰어 **8766**. 라우트: `pipeline / cron-control / mail-thread / admin / screenshot / targets`.
- **k3s 배포 현황(★핵심 격차):** 파이프라인 **역할별 상시 Deployment(replicas:1)** 모델. `deploy/k8s/domains/smb/agents.yaml`에 collector / task / report-mail / reply-verify **4개 Deployment**. 단일 이미지(python:3.12-slim, 엔진+스킬 editable, non-root uid 10001), base/overlays kustomize 구조, `secu-k8s` 스크립트. `k3s-setup-lessons.md`(traefik/servicelb 포트충돌, non-root securityContext, Argo CD, Postgres 백업/DR, 시크릿 암호화, graceful drain, metrics-server/Loki/kube-prometheus). → **이 "역할별 상시 Deployment"는 내가 원하는 "임직원당 동적 파드"와 다르다. §3에서 새로 설계한다.**

### 1-D. 세 레포의 관계 (논리 컴포넌트 다이어그램)

계층은 위→아래, 화살표는 호출/의존 방향이다. **(C) 오케스트레이터는 어느 레포에도 없는 우리의 신규 핵심 설계 지점**임을 항상 기억하라.

```
[사용자 (보안 관리자, 브라우저)]
        │  HTTPS
        ▼
┌────────────────────────────────────────────────────────────┐
│ (A) WEB — digisecu 콘솔 (HR + 매니저 콘솔 + 직원의 책상)         │
│     · 채용/온보딩, 조직도/직원 카드, hire/terminate            │
│     · 페르소나·상태·heartbeat, 예산·권한, 승인 큐               │
│     · 감사로그, 업무/파이프라인/메일스레드 뷰                   │
│     · 스택 = (사용자와 함께 결정, §4)                          │
└───────────────┬────────────────────────────────────────────┘
                │ REST/JSON (계약 = 단일 진실원: zod 또는 pydantic)
                ▼
┌────────────────────────────────────────────────────────────┐
│ (B) CONTROL PLANE — "회사" API (paperclip 개념 차용/재구현)     │
│     · Employee 레지스트리(DB 엔티티, §3-2 스키마)              │
│     · Lifecycle: hire/pause/resume/terminate + 승인 게이트     │
│     · Heartbeat + wakeup 큐(원자적 락/예산 체크)              │
│     · Governance + Audit log · Secret(암호화/버전/스코프)      │
│     · Runtime adapter registry (execute() 계약)               │
│     · ★엔진 도메인 로직을 모른다 — 그건 (D)가 안다              │
└───────┬───────────────────────────────────────┬────────────┘
        │ (C 경유) 파드 CRUD                      │ 계약 읽기
        ▼                                         ▼
┌──────────────────────────┐      ┌──────────────────────────────┐
│ (C) POD ORCHESTRATOR      │      │ (E) SHARED CONTRACTS/DB        │
│   = 신규 핵심 설계 (§3)    │      │  · PostgreSQL                   │
│   · 로컬/목 드라이버 ⇄     │      │  · 컨트롤플레인: Employee/audit/ │
│     k3s 드라이버 (인터페이스 │      │    secret/task 테이블            │
│     분리)                  │      │  · 도메인: state_domain 유일경로 │
│   · 파드 동적 생성/삭제/GC  │      │    (skill 28테이블)             │
└───────┬──────────────────┘      └──────────────────────────────┘
        │ 파드 스펙 주입(env/secret/skill dir/MCP 구성)
        ▼
┌────────────────────────────────────────────────────────────┐
│ (D) AGENT POD (직원 1명 = 파드 1개, 동적)                       │
│     · secu-agent 엔진 프로세스(수정 금지)                       │
│       chat_session→ralph_controller→engine, worker_pool        │
│     · SA_PLUGINS=secu-agent-skill/plugin/bootstrap             │
│     · SA_SKILLS_DIRS=domains/<domain>/skills                   │
│     · 페르소나 = agent/agents/<persona>.md (§3-6)              │
│     · 도메인 러너(collector/task/report_mail/reply_verify …)    │
│     · MCP 클라이언트: splunk/gti/wiki/ticket/knox-mail(§3-7)    │
│     · Mail: POP3S 인바운드 + Knox Mail MCP 아웃바운드(§3-2 메일) │
└────────────────────────────────────────────────────────────┘
```

---

## 2. 업무 도메인 우선순위 (C4)

- 임직원이 수행할 보안 업무 도메인 우선순위는 **반드시 이 순서**: **SMB > dev_web > github > confluence.**
- **차후 확장(지금은 '참고만', 설계에 훅/확장 슬롯만 남기고 구현하지 말 것):** 취약점 점검 · RED teaming · SOC 티켓 처리.
- 다시 강조: **SMB 로직 재구현 금지.** SMB는 "한 명의 디지털 임직원이 이미 잘 하는 업무"로서 web/오케스트레이션 위에 얹는 첫 검증 케이스일 뿐이다.

---

## 3. 핵심 설계 결정

### 3-1. ★ k3s 에이전트당 동적 파드 라이프사이클 (C5 — 반드시 새로 설계)

**설계 격차 명시:** `secu-agent-skill`의 현재 k3s 모델은 **파이프라인 역할별 상시 Deployment(collector/task/report-mail/reply-verify 각 replicas:1)** 로, "임직원 단위 동적 파드 라이프사이클"이 **아니다.** 지금 매니페스트를 그대로 쓰면 내 요구를 만족하지 못한다. 우리 요구는 **"각 디지털 임직원(에이전트)은 독립 파드에서 운영되고, 임직원을 채용/삭제하면 파드가 증분(동적 프로비저닝/스케일)"** 하는 것이다. paperclip의 **hire/terminate + heartbeat** 개념을 **k3s API 기반 파드/Job 프로비저닝**에 매핑한다("채용"=파드 프로비저닝, "해고"=정리/GC).

**제안 접근안 (택1 또는 하이브리드 — 트레이드오프와 함께 제시 후 나와 결정):**
- **접근 A — 컨트롤러가 K8s API로 직접 Pod/Job 프로비저닝 (권장 출발점):** 컨트롤 플레인(B) 안의 Pod Orchestrator(C)가 `hire` 시 K8s API(Python `kubernetes` 또는 TS `@kubernetes/client-node`)로 파드를 생성하고 `terminate` 시 삭제. 상시 근무형(예: SMB collector cron 반복) → 장기 `Pod`/per-employee `Deployment(replicas:1)`; 단발/배치(예: 특정 타깃 1회 점검) → `Job`(완료 후 종료, TTL 컨트롤러 GC).
- **접근 B — 커스텀 오퍼레이터/CRD (`kind: DigitalEmployee` 또는 `Employee`):** 선언적·k8s-native. 초기 구현 비용 큼 → **MVP 이후 로드맵.**
- **접근 C — Knative/KEDA 스케일-투-제로:** wakeup 큐 깊이 기반 자동 스케일. 관측성/운영 복잡 → **후순위 로드맵.**

**파드 라이프사이클 상태 기계 (컨트롤 플레인 ↔ k3s):**
```
hire(승인) ──▶ Provisioning(파드 생성, 시크릿/스킬/MCP 주입) ──▶ Running
Running ⇄ Paused(스케일 0 또는 파드 삭제, DB 엔티티는 유지)
Running ──▶ (heartbeat 실패 N회) ──▶ Unhealthy ──▶ 재프로비저닝 or Alert
terminate ──▶ Draining(in-flight 워커 SIGTERM→grace→SIGKILL) ──▶ Deleted(파드/PVC/Job GC)
```

**반드시 다룰 운영 항목 (`k3s-setup-lessons.md` 교훈 반영):**
- **로컬/목 드라이버 ⇄ k3s 드라이버 인터페이스 분리(★핵심):** 초기 개발 단계에서 실제 k3s 없이도 라이프사이클을 검증할 수 있도록, 오케스트레이터에 **로컬 드라이버(docker/podman 또는 in-process 목)와 k3s 드라이버를 분리한 단일 인터페이스**를 둔다(paperclip이 배포 타깃을 adapter로 추상화한 것과 동일한 사고). mock 언급에 그치지 말고 이 인터페이스 경계를 명시적으로 못박아라.
- non-root securityContext(uid 10001 관례 계승), read-only rootfs 지향, per-employee **ResourceQuota/LimitRange**, RBAC/ServiceAccount 최소권한, 네임스페이스 격리 단위(직원/팀/도메인 중 택1 — `(사용자 확인 필요)`).
- graceful drain: `worker_pool.py`의 SIGTERM→grace→SIGKILL fail-closed 시맨틱을 파드 `terminationGracePeriodSeconds`와 정합.
- 정리(GC): 완료 Job TTL, 고아 PVC/파드 청소, terminate 시 시크릿 언마운트/finalizer.
- traefik/servicelb 포트 충돌 회피, metrics-server/Loki/kube-prometheus 관측성, Argo CD(GitOps), Postgres 백업/DR, 시크릿 암호화(sealed-secrets/SOPS 등).
- 이미지 전략: 현행 단일 이미지(엔진+스킬 editable) 재사용을 우선 검토하되, 파드 스펙 env(`SA_PLUGINS`/`SA_SKILLS_DIRS`/도메인/페르소나 선택)로 역할을 분기.
- **web 반영:** 파드 상태(Pending/Running/Terminating/Paused)를 임직원 상세·조직 뷰에 실시간(또는 폴링) 표시.

**결정 포인트(사용자 확인 필요):** (1) 상시형 vs 단발형 업무 비율, (2) "직원 1명 = 파드 1개"인지 vs 1명이 여러 역할 파드를 갖는지, (3) MVP는 접근 A로 시작하고 CRD/KEDA는 로드맵에 둘지, (4) 네임스페이스 격리 단위, (5) 로컬/목 드라이버 경계 채택 여부.

산출물: `deploy/k8s/`(base/overlays, 우리 신규) + 오케스트레이터 어댑터 코드. 기존 skill의 `agents.yaml` 상시 모델은 **참조로만** 두고 복제하지 않는다.

### 3-2. 계약 우선 — 디지털 임직원 도메인 모델 (paperclip처럼 스키마 먼저)

임직원/조직/태스크/승인/감사 스키마를 **먼저 타입/스키마로 정의**하고, web과 컨트롤러가 그 계약을 공유한다. 아래를 초안으로 삼되 첫 세션에 나와 확정한다.

```
DigitalEmployee {
  id, name, title, persona,          // persona → agent/agents/<name>.md (§3-6)
  reportsTo, org, role, permissions,
  budget,                            // 예산 하드스톱
  mailIdentity { knox, pop3 },       // 개별 ID (§3-2 메일)
  assignedDomains,                   // SMB / dev_web / github / confluence
  lifecycleState,                    // hired/Provisioning/Running/Paused/Unhealthy/Draining/Terminated
  heartbeat                          // 마지막 하트비트/상태
}
Task/Ticket { id, employeeId, goal, status, queue, findings? }
Approval   { id, action, target, requestedBy, state, gate }   // 위험 행동 승인 게이트
AuditLog   { id, actor, event, target, ts, payload }
Secret     { id, employeeId, scope, cipher, version }         // 암호화/버전/스코프 주입
```

### 메일 / 개별 ID (Knox·POP3) 사양 (C6)

전제: **삼성 계정 = Knox 계정.** 각 임직원이 **개별(개인) ID**로 메일을 수집(POP3)·발송(Knox)할 수 있게 **구성 가능**해야 한다. 현재 skill은 개별-ID 발송 경로가 **설계돼 있으나 기본 게이트 오프(dev-safe: `dssoc_only`)** 다. digisecu에서는 이를 임직원별로 **안전하게 켤 수 있게 노출**한다.

- **인바운드(수집):** POP3S **수동** 폴링(poplib, `POP3_HOST="pop3.samsung.net"`:995, STAT/UIDL/TOP/RETR). **DELE 절대 금지.** dedup 키(UID) 우선순위는 **3단 폴백: `x-cms-mailid`(Knox) > `Message-ID` > `uidl`** (`service/collector/mail_inbound.py`의 `_extract_uid`). 개별 ID 다계정 환경에서 dedup 정확성이 중요하므로 이 체인을 그대로 지킨다. 계정은 `POP3_USER`/`POP3_PASSWORD` env 기반. → 이를 **임직원 엔티티별 시크릿**으로 스코프 주입해 직원마다 다른 삼성 계정 수집함을 갖게 한다.
- **아웃바운드(발송):** **Samsung Knox Mail MCP**(deliver `sink_id=knox_mail` → `secu_agent.knox.owner_mail`). 자동발송 **opt-in + fail-closed**. 발신자 정체성 env: `SA_KNOX_MAIL_SENDER`, `MAIL_SENDER_EMAIL`, `POP3_USER`. per-owner 발송 경로(To=owner / Cc=DSSOC, mode=normal)는 존재하나 기본 비활성(`SMB_REMEDIATION_MAIL_MODE="dssoc_only"`). `knox_rooms.yaml`(singleID 허용목록)·delivery egress 허용목록·web scope 게이트(허용 도메인/CIDR)를 임직원별 구성에 연결.
- **digisecu에서 할 일:** 임직원 온보딩 시 개인 Knox/POP3 계정을 **web에서 임직원별로 안전하게 구성**(암호화 시크릿, per-employee 스코프 주입)하고, per-owner 발송을 **임직원별 명시적 opt-in**으로만 활성화. 실 계정/도메인/허용목록 값은 `(사용자 확인 필요)` — 내가 승인하기 전엔 기본 dev-safe 유지.
- **불변식 교차 강조:** 개별 ID를 노출·활성화한다고 해서 §6의 안전 불변식을 우회하지 않는다. 특히 POP3는 여전히 **수동+dedup+DELE 금지**, 발견된 크리덴셜은 여전히 **기록만(인증 사용 금지)**, 실발송 활성화는 여전히 **명시적 승인 게이트 + 감사로그** 뒤에 있다.

### 3-3. 클린 아키텍처 경계 (C7 — 코드 배치 규칙)

- 레이어 경계는 secu-agent-skill DDD 규칙 계승: `application`은 infra/web/service를 import하지 않는다. `web`/`runners`/`plugin` → `application`.
- 컨트롤 플레인 코어(도메인 로직)는 k8s 클라이언트·web 프레임워크·DB 드라이버를 직접 import하지 않고 **port/adapter로 격리**한다(§3-1의 오케스트레이터 인터페이스가 대표 예).
- **DB 경계(격차 보강):** 컨트롤 플레인 DB(Employee/audit/secret/task 테이블)와 skill의 `state_domain`(공유 PostgreSQL 28테이블)은 **접근 경로를 분리**한다. 도메인 상태는 skill의 **`state_domain` 유일 경로 원칙을 계승**해 그 경로로만 읽고, 컨트롤 플레인 테이블은 별도 리포지토리 경계로 둔다. "단일 DB vs 스코프 분리"의 물리적 선택은 `(사용자 확인 필요)`지만, **논리적 접근 경로 분리는 물리 배치와 무관하게 지킨다.**
- **계약 = 단일 진실원:** 프론트/백엔드가 공유하는 스키마(zod 또는 pydantic)를 한 곳에서 정의하고 양쪽이 참조.

### 3-4. 시크릿 / 거버넌스 / 감사

- 시크릿: 실제 자격증명/토큰 값은 커밋 금지, 암호화 저장 + **per-employee 스코프 주입**(paperclip 시크릿 패턴). `.env.example`만 커밋.
- 거버넌스: 위험 행동(실계정 구성, 실발송 활성화, terminate, 파드 삭제, 예산 초과)은 **fail-closed + 명시적 승인 게이트 + 감사로그** 뒤에 둔다. 예산 하드스톱(초과 시 wakeup 큐 체크아웃 거부 + 파드 pause).
- 감사: 라이프사이클 이벤트·승인·발송 이력을 모두 AuditLog에 남긴다.

### 3-5. 이중 스케줄러 충돌 — 첫 세션 결정 사항 (격차)

paperclip의 **heartbeat + wakeup 큐(원자적 체크아웃/락)** 와 secu-agent의 **자체 cron/self-wakeup + 코드온리 cron collector**가 공존한다. **"스케줄링의 주인이 누구인가"** 를 반드시 나와 결정하라: (a) 컨트롤 플레인 wakeup이 파드 내부 스케줄러를 대체/무력화하는가, 아니면 (b) 파드가 자율 스케줄하고 컨트롤 플레인은 heartbeat로 **관측만** 하는가, 혹은 (c) 하이브리드(컨트롤 플레인이 파드 생명/예산을 통제하고, 파드 내부가 도메인 반복을 자율 수행). 이건 C5 설계의 핵심 결정이니 임의로 정하지 말고 트레이드오프와 함께 물어라.

### 3-6. 페르소나 ↔ secu-agent 서브에이전트 매핑 (무수정 재사용, 격차)

"페르소나를 가진 직원"이라는 §0 서사를 엔진에 **이미 존재하는** 서브에이전트 메커니즘(`agent/agents/*.md`의 YAML frontmatter 마크다운)에 연결하라. 임직원의 persona 필드를 이 마크다운 자산에 매핑하면 **엔진 무수정 원칙(§1) 하에서 자연스러운 재사용**이 된다. 페르소나를 순수 UI 개념으로만 다루지 말고, 파드 기동 시 어떤 서브에이전트 정의를 로드할지의 실 구성으로 연결하라.

### 3-7. MCP 의존성의 파드별 프로비저닝 (격차)

각 동적 임직원 파드가 splunk/gti/wiki/ticket/**knox-mail** MCP 엔드포인트·크리덴셜을 **어떻게 주입/구성받는지**를 파드 라이프사이클의 설계 관심사로 명시하라(env 한 줄로만 다루지 말 것). 이는 개별 ID(§3-2 메일)와 직결된다 — 수신 계정과 발신 정체성이 MCP 구성에 묶이므로, 임직원별 MCP 구성 = 임직원별 메일 정체성 구성의 일부로 설계한다.

### 3-8. 다중 파드 간 도메인 클레임/락 조율 (정합성 리스크, 격차)

SMB 안전 불변식이 **task claim=share, discovery claim=host/subnet**인데, 임직원마다 독립 파드로 동적 확장하면 **여러 파드가 공유 skill DB(`state_domain` 28테이블)의 동일 share/host를 두고 경합**할 수 있다. paperclip의 원자적 락은 **wakeup 큐용이지 도메인 클레임용이 아니다.** 따라서 크로스-파드 도메인 클레임 조정을 어떻게 할지(예: `state_domain` 경유 클레임 락, 임직원↔타깃 범위 파티셔닝)를 설계 관심사로 올리고 나와 결정하라. 임의 구현하지 말 것. (M3 DoD에서 실검증한다.)

---

## 4. web-first 진행 방식과 사용자 협업

- **완결성 있는 web을 먼저** 만들고 그 위에 기능을 마일스톤 단위로 **하나씩** 붙인다. 처음엔 mock/stub 데이터로 채워도 되지만 **구조·계약·화면 흐름은 실물**이어야 한다.
- **web은 반드시 나와 함께 만든다.** 혼자 대량의 화면을 찍어내지 마라. **화면 단위로 목업/합의 → 구현 → 리뷰** 루프를 돌리고, 각 화면마다 결정 포인트를 제시하라.
- 각 마일스톤 끝에서 **반드시 멈추고** 데모 + DoD 체크 + 다음 M 착수 여부를 나에게 물어라.

### ★ 웹 기술스택 — 단정하지 말고 나와 함께 결정

web 스택을 **임의로 확정하지 마라.** 아래 후보의 트레이드오프를 표로 정리해 M0에서 나와 결정한다. 각 후보를 (1) 임직원 표현 UX, (2) k3s 파드 상태 실시간성, (3) 언어 일원화, (4) 기존 자산 재사용, (5) 유지보수 인력 관점으로 비교하고 **추천 + 근거**를 제시하되 **최종 선택은 나에게 확인**받아라.

- **후보 A — paperclip식 React/TS 풀스택:** React 19 + Vite + Tailwind v4 + shadcn + TanStack Query + react-router, 백엔드 Express/TS + Drizzle + PostgreSQL, zod 계약 공유. 장점: 조직도/승인/실시간 상태 같은 리치 UI에 강함, 계약 타입 end-to-end 공유, paperclip 자산 재사용. 단점: 엔진(Python)과 언어 이원화, 초기 셋업 무거움.
- **후보 B — secu-agent-skill식 FastAPI + 경량 프론트:** Python FastAPI(엔진·스킬과 동일 언어) + 프론트 (b-1) 기존 단일파일 바닐라JS SPA 계승 또는 (b-2) 경량 React. 장점: 언어 단일화(파드·MCP·POP3 로직 재사용 쉬움), 기존 8767 대시보드 자산 계승. 단점: 바닐라JS는 8개 화면·실시간(heartbeat/파드 상태 폴링)·상태관리 확장성 한계, 계약 타입 공유 약함.
- **후보 C — 하이브리드:** 컨트롤 플레인/파드/메일은 Python FastAPI, 프론트는 React/TS. 계약은 OpenAPI→타입 생성. 장점: 언어별 강점 취함. 단점: **OpenAPI→타입 생성의 계약 드리프트 리스크**(스키마 변경 시 타입 재생성 누락 → 프론트/백 불일치)를 CI 게이트로 막아야 하며, 이는 "계약=단일 진실원(§3-3)"과의 정합 관점에서 후보 A(타입 직접 공유)보다 한 단계 약하다.

> **내 1순위 목표가 "디지털 임직원을 잘 표현"이므로 UX 표현력 관점의 추천을 명시**하되, 최종 결정은 내가 한다.

---

## 5. 마일스톤과 "완결성 있는 web"의 DoD

각 M의 DoD를 만족하기 전에는 다음 M으로 넘어가지 않는다. 각 M 종료 시 데모 + 리뷰 게이트에서 나와 함께 결정한다.

### "완결성 있는 web"의 정의 (M1의 목표선 — 8개 화면, 전부 §0의 직원/회사 은유에 종속)
1. 임직원 **목록 + 상세** — 이름/역할(role·title)/**페르소나**/보고라인(reportsTo)/상태(hired·Running·Paused·Terminated)/담당 도메인/예산·권한/heartbeat 표시.
2. 임직원 **라이프사이클 조작 UI** — hire(승인 게이트)/pause/resume/terminate 버튼과 결과의 상태 반영.
3. **조직도/회사 뷰** — 누가 누구에게 보고하는지, company-scoped 관점("HR 콘솔").
4. **업무(태스크/티켓/점검 잡) 뷰** — 임직원별 현재 잡·큐·최근 finding 요약(SMB 파이프라인 상태를 **조회만**, 재구현 금지).
5. **감사로그/활동 타임라인** — 라이프사이클 이벤트·승인·발송 이력.
6. **메일/보고 뷰** — 임직원이 보낸 리포트 메일 스레드(§3-2 메일) 열람("상사에게 보고").
7. **인증/세션 + 안전 상태 배지** — 위험 동작(발송/terminate)에 확인 게이트, 현재 메일 발송 모드(dev-safe/`dssoc_only`) 노출.
8. 백엔드 REST 계약이 프론트와 **타입 공유**되고, 최소 1개 실데이터 경로(임직원 목록)가 DB까지 왕복.

### 마일스톤 로드맵
- **M0 — 킥오프·결정·골격 스캐폴드.** 산출물: 리포 구조 스캐폴드, ADR 초안(웹 스택 결정, 동적 파드 접근안 결정, 이중 스케줄러 주인 결정), `.env.example`, README. **DoD:** §7 결정 포인트가 합의·문서화, web 스택 확정, 로컬에서 빈 서버+빈 프론트가 뜬다. 로직 없음.
- **M1 — 완결성 있는 web 골격(mock 데이터).** 위 8개 화면을 mock/stub로 구현, 임직원 목록 1건만 실 DB 왕복. **가짜 런타임 어댑터(fake `execute()`, §5-보강)로 임직원이 '일하는 것처럼' 보이게** 한다. **DoD:** 8개 화면이 네비게이션으로 연결·렌더, 계약 타입 공유, mock 라이프사이클 버튼이 상태를 바꿈, 감사 타임라인에 이벤트가 쌓임, 채용→온보딩→목록/상세→위임→보고/감사→pause/terminate를 클릭으로 E2E 시연 가능(실제 보안 로직 0).
- **M2 — 임직원 라이프사이클(컨트롤 플레인 실체화).** paperclip 개념 이식: 임직원/조직/승인/예산/감사 DB 스키마 + REST. hire/pause/resume/terminate가 실제 DB 상태 전이 + 승인 게이트 + 감사로그. heartbeat/wakeup 큐 개념 도입(아직 파드 없이 논리적으로). **DoD:** web에서 hire→pause→terminate가 DB·감사로그·조직도에 일관 반영, 예산 하드스톱 룰 1개 이상 동작.
- **M3 — k3s 동적 파드 라이프사이클(§3-1).** hire 시 파드/Job 프로비저닝, terminate 시 graceful drain 후 정리. 로컬/목 드라이버에서 상태기계를 먼저 검증한 뒤 k3s 드라이버로 전환. secu-agent 엔진 이미지를 런타임으로 붙이는 adapter. **DoD:** web의 hire가 실제(또는 목) 파드를 뜨게 하고 terminate가 정리, 파드 상태가 web에 반영, ResourceQuota/네임스페이스 격리 적용, **그리고 2개 이상 파드가 동일 share/host를 경합할 때 `state_domain` 경유 클레임 락으로 중복 점검(task)이 발생하지 않음을 검증(§3-8).**
- **M4 — 첫 업무 도메인 연동: SMB(재구현 아님).** 기존 SMB 파이프라인(collector/task/report-mail/reply-verify)을 "SMB 담당 임직원"의 업무로 **연결**. web에서 잡/큐/finding/스레드 조회, cron-control을 컨트롤 플레인으로 프록시. **DoD:** SMB 임직원 1명을 hire→파드 기동→기존 SMB 파이프라인 수행→web에서 finding·메일 스레드 확인. **SMB 점검 로직은 한 줄도 재구현하지 않음.**
- **M5 — Knox 개별 ID 메일 구성(§3-2 메일).** POP3 수집 + Knox 발송을 임직원별 개별 ID로 안전 구성 가능하게 노출. **DoD:** 임직원별 발신 정체성/수신 계정을 web에서 구성, per-owner 발송을 명시적 opt-in으로 켜고, 안전 불변식(수동 POP3·DELE 금지·fail-closed·크리덴셜 기록만) 유지.
- **M6 — 도메인 확장(우선순위대로).** dev_web → github → confluence 순으로 "담당 임직원 + 파드 + web 뷰" 반복. **DoD:** 새 도메인 추가가 정해진 확장 레시피(§7 하단)만으로 가능함을 dev_web으로 1회 입증. (vuln/RED team/SOC는 설계 훅만.)

> **보강 — 런타임 실행(execute) 목:** M1~M3에서 실제 LLM 호출·실 타깃 스캔 없이 임직원이 "일하는 것처럼" 보이게 하는 **가짜 secu-agent 런타임 어댑터(fake `execute()`)** 를 설계하라. finding·상태·heartbeat를 합성 생성해, 실 비용/실 타깃 없이 §0의 임직원 경험을 데모·테스트할 수 있게 한다. 이건 오케스트레이터의 로컬/목 드라이버와 짝을 이루는 별개 관심사다(파드 프로비저닝 목 ≠ 업무 실행 목).

---

## 6. 안전 가드레일 (상시 준수 — 하나의 불변식 블록)

- **엔진/스킬 저장소 무수정.** 확장은 `SA_PLUGINS`/`SA_SKILLS_DIRS` attach로만.
- **SMB 재구현 금지.** 이미 완성된 skill 로직을 감싸서 재사용.
- **계층 규칙 준수.** `application`은 infra/web/service를 import하지 않는다. 도메인 상태는 `state_domain` 유일 경로로만.
- **안전 불변식 계승(변경 금지 · secu-agent v3.87 강화 반영):** 읽기 전용 · 크리덴셜 **기록만(인증 사용 금지)** · **POP3 수동+dedup+DELE 금지** · **PII 마스킹 seal**(영속 finding·audit·evidence·egress 모두 봉인 · evidence_dir 0700 · **원문 복원 경로 없음**) · lockout 리액티브 · task claim=share / discovery claim=host·subnet · **egress 허용목록** · **자동발송 opt-in/fail-closed** · **도구 정책 게이트**(`register_tool_policy` — 도메인 등록형 초크포인트, 강화[추가 차단] 전용, 코어 게이트 우회 불가) · **무진전 완료 검토**(done-critic — 인용 증거 없는 '완료'는 결정론적 재검토 pause) · **프로세스 위생·웜풀 금지**(워커 종료 시 chromium teardown·프로세스그룹 격리·고아 reaper, SSO 서킷브레이커는 프로세스 종료로만 리셋). **개별 ID 노출은 이 불변식들을 우회하지 않는다** — web에서 "이 직원의 개별 발송 켜기"는 **명시적 승인 게이트 + 감사로그**를 반드시 통과한다.
- **최소권한:** 파드 non-root(uid 10001), 네임스페이스/쿼터 격리, 시크릿 암호화·스코프 주입.
- **실계정/실 타깃/실 k3s에 붙기 전 반드시 나의 확인.** 개발 단계는 목/로컬 드라이버 + fake execute 우선. 실제값(계정/도메인/CIDR/허용목록/포트)은 임의 가정 없이 `(사용자 확인 필요)`.
- **작게, 함께.** 큰 덩어리 코드 투척 금지. 결정 포인트마다 나와 확인.

---

## 7. 첫 세션 착수 순서 (지금 당장 할 일 — 코딩 전)

1. `~/project/paperclip`, `~/project/secu-agent`, `~/project/secu-agent-skill`의 README/구조/핵심 계약을 **직접 읽고**(특히 §1의 지정 파일들), 위 요약과 어긋나는 점을 보고하라.
2. 다음을 **한 문서로** 정리해 제시하라:
   - 세 레포에서 차용/비차용할 것 요약(각 3~6줄),
   - **디지털 임직원 도메인 모델 초안**(§3-2) + **web 정보구조/라우트 초안**(§0 서사 기준: 채용/조직도/상세/위임/보고/거버넌스),
   - **웹 스택 비교표 + 추천**(§4), **동적 파드 접근안 트레이드오프**(§3-1),
   - **아래 M0 결정지 질문 목록**.
3. 위 결정들을 내가 확정할 때까지 **코드를 만들지 마라.** 결정 후 **M0 스캐폴드**부터 시작한다.
4. 매 마일스톤 종료 시 데모 + DoD 체크 + 다음 M 착수 여부를 나에게 물어라.

### 지금 나에게 물어야 할 결정 포인트 (M0 체크리스트)
- [ ] **web 스택**(§4 후보 A/B/C 중).
- [ ] **컨트롤 플레인 언어/런타임**(TS Express vs Python FastAPI) 및 DB(PostgreSQL 가정 맞는지, 단일 DB vs 도메인 스코프 분리, 기존 skill DB 재사용 여부).
- [ ] **동적 파드 접근안 A/B/C** 및 "직원 1명 = 파드 1개" 정의, **네임스페이스 격리 단위**, 초기 로컬/목 드라이버 채택 여부.
- [ ] **이중 스케줄러의 주인**(§3-5): 컨트롤 플레인 wakeup이 파드 내부 스케줄러를 대체하는가 / 관측만 하는가 / 하이브리드.
- [ ] **크로스-파드 도메인 클레임 조율**(§3-8) 방식.
- [ ] **임직원 ↔ 파드 ↔ 도메인 매핑**(1명이 도메인 1개 전담? 다중?), 상시형 vs 단발형 비율.
- [ ] **멀티테넌시 범위**(company-scoped 필요 여부, 단일 조직인지), **인증/권한**(사내 SSO? 로컬?) — `(사용자 확인 필요)`.
- [ ] **메일 개별 ID 정책**(어떤 임직원까지 개별 발송 허용, 실 테스트 계정 사용 여부, 기본 dev-safe 유지) — §3-2 메일.
- [ ] **기존 skill 웹앱(8767 등) 계승 vs 신규.**
- [ ] **저장소 배치**(monorepo 여부, 엔진/스킬을 서브모듈/의존성 중 무엇으로 참조), **관측성/GitOps**(Argo CD·Loki·prometheus 도입 시점).

### 리포 레이아웃 초안 (첫 세션에 사용자와 확정)
```
digisecu-employee/
  web/                    # (A) 프론트엔드 — 스택 미정(§4)
  control-plane/          # (B) 회사 API: employee/lifecycle/heartbeat/budget/
                          #     governance/audit/secret/adapter-registry
  orchestrator/           # (C) k3s 동적 파드 드라이버(로컬/목 ⇄ k3s 인터페이스)
  contracts/              # (E) 공유 스키마(zod|pydantic) = 단일 진실원
  deploy/k8s/             # base/ + overlays/ (kustomize), per-employee 템플릿
  docs/                   # DESIGN.md, ADR
  # secu-agent / secu-agent-skill 은 이미지 빌드 시 attach (레포에 복제하지 않음)
```

### 도메인 확장 레시피 (M6용)
새 도메인 = `domains/<new>/{application,infrastructure,plugin,runners,skills,webapp}` + `deploy/k8s/domains/<new>/` + finding-lifecycle·egress 게이트·안전 불변식 재사용. `jenkins`는 최소 템플릿(참고용).

---

> **요약:** 디지털 임직원을 잘 표현하는 것이 최우선. SMB는 재구현 대상이 아니라 연동 대상. paperclip=백본 개념, secu-agent=무수정 실행 엔진, secu-agent-skill=도메인 참조. **완결성 있는 web(8개 화면)을 먼저 세우고 M0~M6로 하나씩** 붙이며, k3s 임직원당 동적 파드(로컬/목 ⇄ k3s 드라이버 분리, 상태기계)와 Knox 개별 ID 메일을 새로 설계하고, 이중 스케줄러 주인·크로스-파드 클레임·페르소나↔서브에이전트·MCP 주입 같은 공백은 첫 세션에 결정 질문으로 올린다. 스택·핵심 결정은 반드시 나와 함께 정한다. 지금은 §7의 1~2단계부터 수행하고 내 답을 기다려라.
