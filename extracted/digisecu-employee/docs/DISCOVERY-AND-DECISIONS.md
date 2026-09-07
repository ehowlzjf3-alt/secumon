# digisecu-employee — 착수 발견(Discovery) & 결정지(M0)

> 상태: **결정 대기(코드 없음)**. 킥오프 §7의 1·2단계 산출물.
> 세 참조 저장소(`~/project/{paperclip, secu-agent, secu-agent-skill}`)를 지정 핵심 파일 + 저장소 전반 교차검증한 결과와, 그로부터 도출한 도메인 모델·web 정보구조·웹 스택·동적 파드 접근안·M0 결정 질문을 담는다.
> 원칙 재확인: **엔진/스킬 무수정**, **SMB 재구현 금지**, **디지털 임직원 "표현"이 1순위**.

---

## 1. 검증 요약 & 킥오프 요약과의 불일치 (§7-1)

세 저장소는 킥오프 요약과 **대체로 일치**한다. 설계에 영향을 주는 불일치/보강 사항만 아래에 정리한다. (경미한 버전 오차는 표 하단.)

### 1-A. 설계에 영향을 주는 발견 (중요)

| # | 항목 | 킥오프 서술 | 실제 | 영향 |
|---|------|------------|------|------|
| D1 | **paperclip k8s** | "k8s/k3s 매니페스트 없음, 개념만 차용" | 컨트롤플레인 배포용은 없음(맞음). **그러나** `packages/plugins/sandbox-providers/kubernetes/`에 에이전트 워크로드를 **k8s Job/Pod로 동적 프로비저닝하는 완성 드라이버** 존재: `pod-spec-builder.ts`, `job-orchestrator.ts`, `kube-client.ts`, `cilium-network-policy.ts`, `manifests/operator-prerequisites.yaml`, `PAPERCLIP_EXECUTION_MODE=kubernetes`. 7종 샌드박스 프로바이더(cloudflare/daytona/e2b/exe-dev/**kubernetes**/modal/novita) 중 하나. | **§3-1 동적 파드 오케스트레이터의 직접 참조 자산.** "접근 A(컨트롤러가 k8s API로 Pod/Job 직접 프로비저닝)"를 처음부터 새로 설계할 필요 없이 이 드라이버 패턴을 차용 가능. |
| D2 | **서브에이전트 = persona 자산** | "페르소나를 `agent/agents/*.md`(복수)에 매핑" | 실제 `agent/agents/`에는 **단 1개**(`finding_narrator.md`)뿐이고, 그마저 persona가 아니라 "finding 위험내용 백필(read→enrich)" **업무형** 서브에이전트. frontmatter 필드는 `name / description / task_type(필수) / when_to_use / input_keys / profile` — **`title`/`reportsTo`/`tone` 없음, `tools`/`model` 없음**. 마크다운 **본문은 현재 로더가 미사용**. 모델 선택은 `profile:`, 도구 노출은 `task_type` + 등록형 unlock tools로 결정. 서브에이전트는 env/CLI가 아니라 **LLM이 `AgentTool`로 호출**해 워커 subprocess로 스폰. | **§3-6 갭이 생각보다 큼.** 메커니즘은 있으나 persona 자산은 사실상 비어 있음. 우리는 임직원별 `<persona>.md`를 **신규 저작**해야 하고(무수정 재사용이 아니라 무수정 "확장"), persona↔`task_type`/`profile` 매핑 규칙을 우리가 정의해야 함. |
| D3 | **도메인 DB 물리 배치** | "단일 DB vs 스코프 분리는 미정" | skill `state_domain.py`가 **엔진 코어와 같은 Postgres·같은 DB**를 쓰고(모듈 docstring 결정⑧), 엔진 코어 `secu_agent.state.connect()` **풀을 그대로 재사용**. 도메인 테이블은 이 DB 안에 소유권만 이전. | **도메인 DB 물리 배치는 이미 고정**(엔진+스킬 공유 1 DB). 우리가 결정할 건 "**컨트롤플레인 테이블**(Employee/audit/secret/task/approval)을 이 DB에 섞을 것인가, 별 DB/스키마로 분리할 것인가"로 좁혀짐. |
| D4 | **state_domain 테이블 수** | "12 테이블" | 실제 **28개** `CREATE TABLE`(docstring의 "12종"은 stale). `pipeline_heartbeat`, `control_flag`, `pipeline_run`, `mail_thread/message/reply_decision/reverify_result`, 각 도메인 `*_report_thread` 등 포함. `state_domain`이 유일 접근 경로임은 확정(132개 파일이 import, `connect()` 정의 유일). | web의 "업무/메일/보고" 뷰(§5 화면 4·6)가 읽을 대상이 12개가 아니라 28개. 또한 **이미 heartbeat/control_flag/pipeline_run 테이블이 존재** → 파드 상태·cron-control을 새로 만들 필요 없이 여기에 얹을 수 있음. |
| D5 | **레이어 규칙 보편성** | "application은 service/webapp import 금지(전 도메인)" | **SMB·dev_web은 준수**(아키텍처 테스트로 강제). **그러나 github/confluence의 `application/`은 `service`를 import**(`services/github/application/scanner.py`, `services/confluence/application/reporter.py`에서 `from service import state_domain`, `service.services.*`). | "application 무-infra import"는 **전역 불변식이 아님**. 우리 신규 코드는 SMB/dev_web의 엄격 버전을 계승하되, 기존 skill이 부분적으로만 지킨다는 사실을 알고 접근. |

### 1-B. 경미한 오차 (참고, 설계 무영향)

- paperclip: DB 테이블 ~130 → **실제 125**. `zod`는 **v3**(^3.24.2), v4 아님. adapter 계약은 "단일 `execute()`"가 아니라 `execute()` + `testEnvironment()` 필수 + ~25개 선택 훅. wakeup 원자 체크아웃은 `SKIP LOCKED`가 아니라 **status-flag 낙관적 UPDATE**(`WHERE status='queued' ... RETURNING`) + per-agent in-process mutex.
- secu-agent: Bedrock Anthropic은 **코어 의존성 아님**(선택 extra `[bedrock]`), 기본 프로파일은 `codex`(내부 게이트웨이/OpenAI Responses). `pyyaml` 의존성 추가. 자체 스케줄러는 **60초 폴링 tick + croniter**(sleep-until-cron 아님) + self-wakeup 도구.
- secu-agent-skill: SMB webapp 6번째 라우트는 `targets`가 아니라 **`agents`**(`targets`는 dev_web 라우트). jenkins는 tools+skill "만"이 아니라 **agent_type도**(구 hunter) 있음(단 runner 없음=반쯤 만든 템플릿 맞음). 파드/포트/uid 10001/kustomize base·overlays/안전 불변식 전부 확정.
- secu-agent MCP: `MCP_INTERNAL_HOST`/`MCP_EXTERNAL_HOST`가 **`.env.example`에 미문서화**(실 `.env`·yaml에만) → 파드별 MCP 프로비저닝 시 명시 필요.

### 1-C. 확정된(일치) 핵심 사실

- **엔진 무수정 확장 메커니즘 확인**: `SA_PLUGINS`(`plugins.py`, import 부작용으로 `register_*`, fail-loud), `SA_SKILLS_DIRS`(`agent/skills/__init__.py`, 코어 우선 first-wins). `plugin/bootstrap.py`가 agent_type 6종(구 hunter)·finding 분류·evidence judge·browser 검증 게이트·**fanout 어댑터 14종**(smb_task/report_mail/reply_verify + dev_web/github/confluence)·skill_unlock 도구·task_type canonicalizer·instruction preamble·memory scope·**register_schema×4**(P2 네임스페이스, dormant)를 등록. 코어 온보딩 계약 = `secu-agent/docs/ATTACHING-A-DOMAIN.md`.
- **엔진 계층**: `chat_session → ralph_controller(Ralph 루프 + goal judge, no-progress-limit=3) → engine(단일턴, read-only 도구 병렬)`, `goal_manager`. `worker_pool.py`는 spec당 fresh subprocess, SIGTERM→grace(5s)→SIGKILL, fail-closed(spec당 정확히 1 completion).
- **SMB 안전 불변식** 전부 확인: read-only, credential record-only, POP3 passive+DELE 금지+dedup(UID=x-cms-mailid>Message-ID>uidl), PII 마스킹/path-jail, lockout reactive, claim=share/host·subnet, egress allowlist, autosend opt-in/fail-closed(`SMB_REMEDIATION_MAIL_MODE="dssoc_only"`, `SA_DELIVERY_RECIPIENT_ALLOW=""`=차단).
- **paperclip 차용 자산 위치 확인**: adapter registry(`server/src/adapters/registry.ts`), heartbeat/wakeup(`services/heartbeat.ts` + `agent_wakeup_requests`), 승인(`schema/approvals.ts`)+감사(`activity_log.ts`), 예산 하드스톱(`services/budgets.ts`), 시크릿 AES-256-GCM(`secrets/local-encrypted-provider.ts`)+버전(`company_secret_versions`)+스코프(`company_secret_bindings`), 조직도(`agents.reportsTo` self-FK).

---

## 2. 세 레포에서 차용/비차용 요약 (§7-2)

### 2-A. `paperclip` — 백본(회사/컨트롤 플레인 개념)
- **차용**: ① adapter registry + `execute()`류 런타임 계약(BYO 런타임), ② heartbeat + wakeup 큐(낙관적 status-flag 체크아웃 + coalescing + per-agent mutex), ③ 승인 게이트 + 감사로그 + 예산 하드스톱(scope pause), ④ 시크릿(AES-256-GCM/버전/스코프 바인딩), ⑤ 조직도(`reportsTo` self-FK) + company-scoped 멀티테넌시 컬럼, ⑥ **k8s sandbox-provider 드라이버(D1)** — §3-1 접근 A의 참조 구현, ⑦ (선택) UI 디자인토큰/shadcn 패턴.
- **비차용**: paperclip 130여 테이블 전체 스키마(과대), 7종 클라우드 샌드박스 프로바이더 중 k8s 외 나머지, 두 갈래 플러그인 시스템 전부(우리는 단순화). paperclip을 **복제/포크하지 않고 개념·패턴만** 우리 `control-plane/`에 재구현.

### 2-B. `secu-agent` — 실행 엔진(임직원의 "두뇌", 무수정)
- **차용(런타임 attach)**: 엔진 프로세스 자체를 파드 안에서 실행. `SA_PLUGINS`/`SA_SKILLS_DIRS`/`profile`/MCP env로만 구성. 서브에이전트 메커니즘(`agent/agents/*.md`, `AgentTool` 스폰)을 persona 로딩 훅으로 사용. `worker_pool` SIGTERM→grace→SIGKILL 시맨틱을 파드 `terminationGracePeriodSeconds`와 정합.
- **비차용/주의**: 엔진 코드는 **한 줄도 수정 안 함**. 엔진 자체 스케줄러(60s tick+croniter+self-wakeup)는 "이중 스케줄러" 주인 결정(§3-5)에서 다룸. persona 자산은 신규 저작(D2).

### 2-C. `secu-agent-skill` — 도메인 콘텐츠(임직원의 "업무", 무수정 참조)
- **차용(재사용)**: SMB E2E 파이프라인(collector/task/report_mail/reply_verify)을 **그대로** "SMB 담당 임직원"의 업무로 attach. DDD 레이어 규칙(SMB/dev_web 엄격판) 계승. `state_domain`을 도메인 상태의 **유일 읽기 경로**로 사용(28 테이블, `pipeline_heartbeat`/`control_flag`/`pipeline_run` 포함). 안전 불변식 전량 계승. kustomize base/overlays·uid 10001·securityContext 패턴 계승.
- **비차용/신규**: **역할별 상시 Deployment 모델(`agents.yaml` 4-Deployment)은 복제하지 않음** → 임직원당 동적 파드로 새 설계(§3-1). 바닐라JS webapp(8767 등)은 신규 web으로 대체하되 원본은 무수정 보존(§7 결정). SMB 로직 **재구현 금지**.

---

## 3. 디지털 임직원 도메인 모델 초안 (§3-2)

> 계약 = 단일 진실원. 아래는 **컨트롤플레인이 소유**하는 신규 엔티티(도메인 상태 28테이블은 `state_domain` 유일 경로로 별도 접근).

```
DigitalEmployee {
  id                 uuid
  name               text            # "김보안" 등 인격형 이름
  title              text            # 직함: "SMB 보안 담당"
  persona            text            # → agent/agents/<persona>.md (신규 저작, task_type 필수)
  reportsTo          uuid?           # self-FK (조직도)
  org                text            # 소속 조직(단일조직이면 상수)
  role               text            # 권한 역할
  permissions        jsonb           # 세부 권한
  budgetMonthlyCents int             # 예산 하드스톱
  spentMonthlyCents  int
  assignedDomains    text[]          # SMB | dev_web | github | confluence (MVP=단일)
  mailIdentity       jsonb           # { knoxSender, pop3User, sendMode } (§3-2 메일, 기본 dev-safe)
  runtime            jsonb           # { profile, mcp:{splunk,gti,wiki,ticket,knox}, skillsDirs }
  lifecycleState     enum            # Hired|Provisioning|Running|Paused|Unhealthy|Draining|Terminated
  podRef             jsonb?          # { namespace, name/jobName, driver:'mock'|'local'|'k3s' }
  heartbeat          jsonb           # { lastBeatAt, status, currentTask }
  companyId          uuid            # 멀티테넌시(단일조직이면 1행)
  createdAt / updatedAt
}

Task {                              # 위임(§0-3): 사람이 임직원에게 배정
  id, employeeId, goal, status, queue, domain, findingsSummary?, createdBy, ts
}
Approval {                          # 위험 행동 승인 게이트(§3-4)
  id, action(enum: hire|enable_send|terminate|delete_pod|budget_override),
  target, requestedBy, state(pending|approved|rejected), gate, decidedBy?, ts
}
AuditLog {                          # 라이프사이클·승인·발송 전량
  id, actor, actorType, event, entityType, entityId, ts, payload
}
Secret {                           # 암호화/버전/스코프(§3-4)
  id, employeeId, scope, cipher(AES-256-GCM), version, createdAt
}
```

- **매핑 규칙(신규 정의 필요, D2)**: `persona` → 파드 기동 시 로드할 `agent/agents/<persona>.md`(우리가 저작, `task_type` = 담당 도메인 유형). per-persona LLM = frontmatter `profile:`. 도구 노출 = `task_type` + 등록형 unlock tools.
- **파드 상태 반영**: `lifecycleState` + `heartbeat` + `podRef`를 web 임직원 상세/조직뷰에 폴링 표시. 기존 `pipeline_heartbeat`(state_domain)와 컨트롤플레인 heartbeat를 분리하되 화면에서 합성.

---

## 4. web 정보구조 / 라우트 초안 (§0 서사 기준 — "HR + 매니저 콘솔 + 직원의 책상")

| 화면(§5 DoD) | 라우트 | 은유 | 핵심 정보구조 |
|---|---|---|---|
| 로비/대시보드 | `/` | 매니저 콘솔 홈 | 근무 중 직원 수, 대기 승인, 오늘의 finding, 예산 소진 현황 |
| ③ 조직도 | `/team` | HR 콘솔 | reportsTo 트리, company-scoped 뷰 |
| ① 임직원 목록 | `/employees` | 직원 명부 | 카드: 이름/직함/페르소나/상태/heartbeat/담당도메인/예산 |
| ①·④ 임직원 상세 | `/employees/:id` | 직원의 책상 | 페르소나·현재 태스크·큐·최근 finding·예산/권한·메일 정체성·파드 상태 |
| ② 채용/온보딩 | `/hire` | 채용 위저드 | 이름·직함·역할·상사·도메인·페르소나·예산·메일·권한 → **승인 게이트** |
| ⑦ 승인 큐 | `/approvals` | 거버넌스 | hire/발송활성화/terminate/파드삭제/예산초과 게이트 |
| ④ 업무/티켓 | `/tasks` | 업무 배정 | 임직원별 잡·큐·finding 요약(SMB 파이프라인 **조회만**) |
| ⑥ 보고/메일 | `/reports` | 상사에게 보고 | 임직원이 보낸 리포트 메일 스레드(`mail_thread`) |
| ⑤ 감사/타임라인 | `/audit` | 감사 | 라이프사이클·승인·발송 이력 |
| ⑦ 설정/안전 | `/settings` | 안전 배지 | 발송 모드(dev-safe/`dssoc_only`), 인증/세션 |

② 라이프사이클 조작(hire/pause/resume/terminate)은 `/employees/:id`와 `/approvals`에 인라인. ⑧ 실데이터 왕복은 `/employees` 목록 1건으로 M1 충족.

---

## 5. 웹 스택 비교 + 추천 (§4)

| 관점 | A: React/TS 풀스택(paperclip식) | B: FastAPI + 경량 프론트 | C: 하이브리드(Py 백 + React 프론트) |
|---|---|---|---|
| (1) 임직원 표현 UX | ★★★ 리치 UI 최강(조직도/승인/실시간) | ★ 바닐라JS는 8화면·상태관리 한계 | ★★★ 프론트 동일 |
| (2) 파드 상태 실시간성 | ★★★ TanStack Query 폴링/WS 성숙 | ★★ 수동 구현 | ★★★ |
| (3) 언어 일원화 | ★ 엔진(Py)과 이원화 | ★★★ 파드/MCP/POP3와 단일 | ★ 이원화 |
| (4) 기존 자산 재사용 | ★★★ paperclip UI·스키마·k8s 드라이버 | ★★ skill webapp 계승 | ★★ 양쪽 부분 |
| (5) 계약=단일 진실원 | ★★★ zod 타입 직접 공유 | ★ 약함 | ★★ OpenAPI→타입 생성(드리프트 리스크, CI 게이트 필요) |

**추천: A(React/TS 풀스택)를 주축으로, 도메인상태 접근만 얇은 Python 사이드카로 M4에 도입.** 근거:
- 1순위 목표가 "임직원 표현"이므로 UX 표현력(관점 1·2)이 결정적 → A/C 우위.
- 계약=단일 진실원(§3-3)에서 A가 zod 직접 공유로 가장 강함. C의 OpenAPI 드리프트는 한 단계 약함(킥오프도 동의).
- **언어 이원화 우려는 이 아키텍처에서 저비용**: 컨트롤플레인은 엔진 코드를 import하지 않고 **파드 스펙 주입 + 공유 Postgres + REST**로만 붙는다. 유일한 Python 필수 지점은 `state_domain` 접근(화면 4·6, M4+)과 (선택) skill의 POP3/Knox 코드 재사용. 이건 M4에 **얇은 Python "도메인 읽기 게이트웨이"**(state_domain 유일 경로를 감싼 read-only FastAPI)로 도입하면 §3-3/§6를 지키면서 최소 표면.
- **M0~M3은 fake execute + mock/local 드라이버라 도메인 상태가 없음** → 순수 A(TS 프론트+TS 컨트롤플레인)로 충분, Python 사이드카는 정확히 필요한 M4에 도입(복잡도 지연).
- paperclip의 k8s sandbox-provider 드라이버(TS, D1)를 오케스트레이터로 차용하면 접근 A도 TS로 일원화 가능 → 컨트롤플레인 단일언어 유지.

→ **정리**: 프론트+컨트롤플레인+오케스트레이터 = **TS**(React19+Vite+Tailwind+shadcn+TanStack Query+react-router / Express5+Drizzle+Postgres / zod). 엔진-인접 Python 표면(도메인 읽기 게이트웨이, POP3/Knox glue) = M4에 최소 도입.

---

## 6. 동적 파드 접근안 트레이드오프 (§3-1)

| 접근 | 요지 | 장점 | 단점 | 권고 |
|---|---|---|---|---|
| **A: 컨트롤러가 k8s API로 Pod/Job 직접 프로비저닝** | hire→파드 생성, terminate→삭제. 상시형=장기 Pod/per-employee Deployment(replicas1), 단발=Job(TTL GC) | **paperclip k8s 드라이버(D1) 그대로 차용 가능**, MVP 빠름, 명령형 제어 단순 | 컨트롤러가 상태 재조정 로직 직접 소유 | **MVP 출발점(권장)** |
| B: CRD/오퍼레이터(`kind: DigitalEmployee`) | 선언적·k8s-native | GitOps 친화, 재조정 자동 | 초기 비용 큼 | 로드맵(M3 이후) |
| C: Knative/KEDA scale-to-zero | wakeup 큐 깊이 기반 오토스케일 | 유휴 비용 0 | 관측성·운영 복잡 | 후순위 로드맵 |

**핵심 설계 못박기 — 로컬/목 ⇄ k3s 드라이버 인터페이스 분리**: 오케스트레이터는 단일 인터페이스(`provision/pause/resume/terminate/status`) 뒤에 **① mock(in-process)**, **② local(docker/podman)**, **③ k3s** 드라이버를 둔다. M1~M3는 mock/local로 상태기계 검증, 이후 k3s로 전환. (paperclip이 배포 타깃을 adapter로 추상화한 것과 동형, 그리고 fake `execute()` 업무 실행 목과는 **별개 관심사**.)

파드 상태기계: `hire(승인)→Provisioning→Running ⇄ Paused / Running→(heartbeat실패 N)→Unhealthy→재프로비저닝|Alert / terminate→Draining(SIGTERM→grace→SIGKILL)→Deleted(파드/PVC/Job GC)`.

> **[M0 확정] 접근 B(CRD/오퍼레이터) 채택.** 사용자 결정으로 MVP부터 선언적 k8s-native 경로. 함의:
> - `kind: DigitalEmployee` CRD 정의 + reconcile 오퍼레이터가 CR→Pod/Job 프로비저닝. M3 = "드라이버 직접 호출"이 아니라 **CRD 스키마 + 오퍼레이터 구축**(비용 M3 집중).
> - **하이브리드 스케줄러와 정합**: 컨트롤플레인이 CR **spec(desired: Running/Paused/budget)** 작성 → 오퍼레이터가 reconcile → 컨트롤플레인은 CR **status subresource + heartbeat**로 관측. 예산 하드스톱 = spec을 Paused로 patch.
> - **로컬/목 드라이버 경계 여전히 필수**: 오퍼레이터 리컨사일러를 mock(in-process)로 두거나 kind/k3d 로컬 클러스터로 M1~M3 상태기계 검증.
> - **GitOps(Argo CD) 친화도 상승**: CR이 선언적이라 GitOps 도입이 자연스러워짐 → 관측성/GitOps 시점 재검토 대상.
> - 미해결 파생 결정: **오퍼레이터 언어/프레임워크**(Go kubebuilder / Python kopf / TS) — 컨트롤플레인 TS와 별개 언어 가능성(3번째 언어).

---

## 7. 그 외 핵심 결정 — 추천안 (사용자 확정 필요)

- **§3-5 이중 스케줄러 주인 → 추천 (c) 하이브리드**: 컨트롤플레인이 파드 생명·예산·heartbeat 관측/제어(wakeup 큐 = 파드 실행 허가/pause/예산정지), 파드 **내부**는 엔진 자체 cron/self-wakeup으로 도메인 반복(SMB collector 300s, task loop)을 자율 수행. 컨트롤플레인은 per-target 점검 cadence를 재구현하지 않음(§1/§6 준수).
- **§3-8 크로스-파드 클레임 → 추천: 기존 `state_domain` 클레임 경로 재사용**. task claim=share / discovery claim=host·subnet는 이미 공유 DB의 claim 행으로 프로세스 간 직렬화됨(다중 파드 = 다중 worker subprocess와 동형). 새 락 발명 금지. 임직원↔타깃 범위 파티셔닝으로 경합 감소. **M3 DoD에서 2+ 파드 동일 share 경합 실검증**.
- **§3-3 컨트롤플레인 DB 경계 → 추천: 같은 Postgres 서버의 별도 DB(또는 별도 schema)**. 도메인 DB는 엔진+스킬 공유 1 DB로 이미 고정(D3) → Drizzle 마이그레이션이 도메인 테이블을 절대 건드리지 않도록 컨트롤플레인 테이블은 물리 분리. 도메인 상태는 `state_domain` 유일 경로(M4 Python 게이트웨이).
- **임직원↔파드↔도메인 → 추천: MVP는 1임직원 = 1도메인 전담 = 1상시 파드**, 단발 업무는 자식 Job. 상시형 우세(SMB=collector cron 상주).
- **멀티테넌시 → 추천: 단일 조직(DS DSSOC)**. `companyId` 컬럼은 남기되 1행 고정, 멀티테넌트 UI 미구현. **인증 → MVP 로컬 세션**, 사내 SSO는 (사용자 확인 필요) 로드맵.
- **메일 개별 ID → 추천: M4까지 dev-safe 유지**(`dssoc_only`, autosend fail-closed). M5에서 임직원별 개인 Knox/POP3를 web 구성 + **명시적 opt-in + 승인 게이트 + 감사로그** 뒤에서만 활성. 실계정/도메인/허용목록 = (사용자 확인 필요), 승인 전 dev-safe.
- **기존 skill webapp(8767 등) → 추천: 신규 web으로 대체하되 원본 무수정 보존**. 도메인 파이프라인 상세뷰는 재구현 대신 M4에 프록시/딥링크로 재사용 검토.
- **저장소 배치 → 추천: pnpm monorepo**(`web/ control-plane/ orchestrator/ contracts/ deploy/k8s/ docs/`), 엔진/스킬은 **복제/서브모듈 아님 → 이미지 빌드 시 attach**(PYTHONPATH + SA_PLUGINS). 관측성/GitOps(Argo/Loki/Prometheus)는 **M3+**(실 k3s 드라이버 도입 시) 착수.

---

## 8. M0 결정 체크리스트 (§7)

| # | 결정 | 상태 | 확정값 |
|---|------|------|--------|
| 1 | 웹 스택 | ✅ 확정 | **A: React/TS 풀스택** + 도메인상태만 M4 Python read 게이트웨이 |
| 2 | 컨트롤플레인 언어 + DB | ✅ 확정 | **TS Express + 같은 Postgres 별도 DB/schema** (Drizzle가 도메인 28테이블 불가침) |
| 3 | 동적 파드 접근안 | ✅ 확정 | **접근 B: CRD `kind: DigitalEmployee` + 오퍼레이터** (파생: 오퍼레이터 언어/프레임워크 미정, 로컬/목 필수) |
| 4 | 이중 스케줄러 주인 | ✅ 확정 | **하이브리드** (회사=생명·예산·heartbeat / 파드=엔진 자체 cron 자율) |
| 3b | 오퍼레이터 언어/프레임워크 | ✅ 확정 | **Go kubebuilder / controller-runtime**. 로컬/목: mock 리컨사일러(in-process) 또는 kind/k3d로 M1~M3 검증. **결과 스택 = 3언어**(TS 컨트롤플레인·web / Go 오퍼레이터 / Python 도메인게이트웨이·엔진attach) |
| 6 | 임직원↔파드↔도메인 매핑 | ✅ 확정 | **1임직원 = 1도메인 전담 = 1상시파드**, 단발 업무는 자식 Job |
| 7 | 멀티테넌시 + 인증 | ✅ 확정 | **단일 조직, SSO 없음, 로컬 세션**. 임직원별 Knox/POP3 개인화 = 파드에 **env/시크릿 스코프 주입**(§3-2와 정합) |
| 10 | 저장소 배치 + 관측성/GitOps | ✅ 확정 | **pnpm monorepo + 엔진/스킬 attach(복제 안 함)**. 관측성·Argo CD는 **M3**(실 k3s·오퍼레이터 등장 시) |
| 5 | 크로스-파드 클레임 조율 | 🕒 M3 게이트 | 추천: state_domain 기존 claim 경로 재사용, M3 DoD 실검증 |
| 8 | 메일 개별 ID 정책 | 🕒 M5 게이트 | 추천: M4까지 dev-safe, M5 env/시크릿 개인화 opt-in+승인+감사 |
| 9 | 기존 skill webapp | ✅ 확정 (ADR 0006) | **폐기 — 우리 web이 finding/report 전량 담당**. 원본 저장소 무수정 보존하되 webapp 미사용. 도메인 데이터는 state_domain read-only 렌더. |
| 11 | 출근지(Workplaces) | ✅ 확정 (ADR 0006) | **등록형 워크스페이스 + 디렉토리 분리**(`web/src/workspaces/<domain>/`) + 제네릭 엔진 1벌. M1에 mock 프로토타입, 실 연동 M4. |
| 12 | 무수정 원칙 | ✅ 완화 (ADR 0007) | 사용자 소유·운영 전 → **신중한 수정 허용**. 단 **안전 불변식·코어 attach·SMB 재구현 금지는 유지**. |
| 13 | 관리 UI · 파드 | ✅ 확정 (ADR 0007) | finding 관리 = **단일 제네릭 React 관리 UI**(도메인 webapp 폐기), **파드=순수 워커**(UI 전부 콘솔), 워크스페이스=**조합형 섹션(열린 레지스트리)**. |
| 6b | 에이전트 taxonomy · 조직 | ✅ 확정 (ADR 0008) | **임직원(LLM)=오케스트레이터·전략·워커·HR / 잡(코드)=collector**. 조직도=오케스트레이션 트리(팀장→HR+도메인 오케스트레이터→전략·워커). **A2A(제어)+DB큐(데이터)**. "1임직원=1파드"→"1도메인=오케스트레이터+N워커". 워커 핫스타트. |

> **전 근간 결정 확정(1·2·3·3b·4·6·7·10).** 5·8·9는 해당 마일스톤에서 잠금(추천안 유지). → **M0 스캐폴드 착수 가능.**

### 확정 저장소 레이아웃 (M0)
```
digisecu-employee/
  web/            # (A) React19+Vite+Tailwind+shadcn+TanStack Query+react-router (TS)
  control-plane/  # (B) Express5 REST + Drizzle + Postgres(별도 DB) (TS)
  operator/       # (C) Go kubebuilder — kind: DigitalEmployee CRD + reconciler (M3)
  contracts/      # (E) zod 단일 진실원 (TS, web↔control-plane 공유)
  deploy/k8s/     # base/ + overlays/ + CRD + per-employee 템플릿 (M3)
  docs/           # DISCOVERY-AND-DECISIONS.md, adr/
  .env.example / README.md / pnpm-workspace.yaml / package.json
  # secu-agent / secu-agent-skill = 이미지 빌드 시 attach (복제 안 함)
  # domain-gateway/ (Python read gateway, state_domain 유일 경로) = M4에 추가
```
