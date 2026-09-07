# P4 — role 스킬(hr·orchestrator·strategy) 설계

> 목표: 조직 역할(HR·매니저·전략)도 스킬로. "모든 임직원 = 코어 엔진 + 스킬 1개".
> 근거: 정찰(스킬 저작·엔진 role 지원·digisecu 인터페이스) + codex 자율성 경계 자문. 상위: `CLEAN-AGENT-ARCHITECTURE.md`.
> P1(코어 포트) 독립. 코어 개선은 최소만(대화형 페르소나 일반화는 선택·후속).

---

## 1. 지도 원칙 (codex) — role = "control-plane에 종속된 LLM 의사결정 모듈"

세 역할 모두 **주권적 직원이 아니라**, LLM은 **제안/계획/우선순위만 자율**, 실행·수명주기·예산·인가는 **결정론적 control-plane**:

| role | LLM 자율(제안·계획) | 결정론 게이트(control-plane·코드, 재구현 금지) |
|---|---|---|
| HR | 인력수요 분석·도메인/인원 추천·근거·대안 | 실 hire/terminate = 승인게이트+사람. 제안도 rate-limit·중복차단·해고 보호속성 금지·최소관찰기간 |
| orchestrator | 승인된 워커풀+예산봉투 안 작업분해·우선순위·모니터 | 워커생성·파드삭제·예산증액·pause/resume = 게이트/거부. 폭주차단(max워커·fan-out깊이·토큰/시간·circuit breaker) 모델 밖 |
| strategy | 승인된 타깃인벤토리 안 우선순위·타이밍 | claim=share/host·read-only·egress 매 tool-call 검증. 신규타깃=제안만·스캔편입=별도승인 |

**핵심 방어선**: 에이전트는 목표·정책·예산·감사·kill-switch 수정 불가, **자기 요청 승인 불가**(권한분리). A2A 출력=provenance 붙은 비신뢰 데이터. TOCTOU(제안→실행)는 scope/예산/정책 버전 고정+실행직전 재검증. done-critic도 LLM→안전경계 아님(독립 watchdog+결정론 invariant+kill-switch).

## 2. 엔진 anatomy (정찰) — role 스킬을 어떻게 만드나

- **스킬 최소집합**: `<name>/SKILL.md`(frontmatter name==디렉토리명) + `SA_SKILLS_DIRS`. tools/agent_type 불필요(순수 플레이북). 참고 최소 실행형=jenkins(SKILL.md+agent_type+tools).
- **role agent_type 등록 자유**: `register_agent_type("hr")` 무제약(UX 게이트, 코어 무수정·plugin 부수효과). 단 "등록됨"은 라벨일 뿐.
- **페르소나 결정 지점**: 대화형(chat)은 `task_type=='operator'`에서만 도구/스킬/서브에이전트 동적합성(페르소나=보안 오케스트레이터 하드코딩). 그 외 task_type→system_generic degrade. **워커/서브에이전트는 `register_task_contract(system_prompt=…)`가 페르소나 공급**(서브에이전트 .md body는 미사용).
- **role 워커 완성 4훅**(코어 0줄): register_agent_type + register_task_type_alias + register_task_toolset + register_task_contract(role 페르소나·terminal_tools·budget). 자율루프는 기존 RalphController 재사용(GoalTool 포함 시).
- **외부(control-plane) 호출**: MCP 서버 래핑(정합) 또는 custom Tool plugin. **WebFetch는 loopback 차단**이라 부적합.

## 3. digisecu 인터페이스 (role tools가 호출할 표면)

- **HR** persona=`people_ops`. tools=승인요청 생성(제안): `POST /api/hires`·`/terminate`·`/budget-override`·`/enable-send`(전부 fail-closed pending→root 승인). HR은 제안만·승인 못 함(APPROVER=root).
- **orchestrator** persona=`*_sentinel`(도메인별). 표면=org read(`GET /api/org`·`/employees`) + gateway 관측(`/gw/queue/depth`·`/gw/findings`). pause/resume(`POST …/pause|resume`)은 **무게이트 직접전이** → 자율 노출 주의. 워커위임/A2A=**미존재**(설계 필요).
- **strategy** persona=`*_strategist`. collector는 임직원 소유 Tool(job). 실행표면=engine collector runner(control-plane 밖), digisecu는 gateway `QueueDepth.strategy` 관측만.
- **persona→agent_type 바인딩 공백**: role persona 전부 로스터 존재하나 `runtime-mapping.ts`가 null 반환 → **P4가 people_ops→hr·smb_sentinel→orchestrator(smb)·smb_strategist→strategy(smb) 바인딩 추가**.

## 4. 결정 & 추천 (열린 질문 해소)

| # | 결정 | 추천 |
|---|---|---|
| D1 실행모드 | 대화형(사람과 채팅) vs 워커/서브에이전트(operator 위임·bounded) | **워커형 first-cut** — 대화형은 operator 페르소나(보안편향) 충돌·코어개선 필요. 워커형은 `register_task_contract`로 role 페르소나 공급, 코어 0줄. (대화형 role은 후속: operator_core를 role-중립화하는 코어개선과 함께.) |
| D2 control-plane 호출 | MCP 래핑 vs custom Tool | **custom Tool plugin** first-cut(httpx로 control-plane REST 호출, register_task_toolset). MCP 래핑은 후속 정합. |
| D3 orchestrator 위임 | 신규 A2A/delegatedTask 표면 | **first-cut 제외** — 기존 표면(observe+propose)만. A2A는 별도 설계(codex: capability 발급·provenance·TTL). |
| D4 pause/resume 자율노출 | 자율 orchestrator에 직접 | **미노출** — orchestrator는 observe+propose만. 직접 mutate 금지(codex: 수명주기=control-plane). |
| D5 자율성 강제 | LLM 프롬프트 vs 코드 | 프롬프트 아닌 **control-plane 결정론 게이트**(이미 구축) + role 스킬은 propose-only tools. |

## 5. first-cut 설계 (워커형·propose-only·코어 0줄·A2A 없음)

각 role = 자기완결 스킬 패키지:
```
skills/<role>/                 # skills/hr, skills/orchestrator, skills/strategy
  SKILL.md                     # role 플레이북(정체성·when_to_use·안전규칙·triggers)
  worker.md                    # 워커 계약(자율 경계·propose-only 규칙)
  src/<role>/
    agent_type.py              # register_agent_type("hr")
    tools.py                   # custom Tool: control-plane 요청 엔드포인트 래핑(propose)
    contract.py                # register_task_contract(system_prompt=role 페르소나, terminal_tools)
    bootstrap.py               # 위 등록 + register_task_toolset
```
- **hr**: ProposeHireTool/ProposeTerminateTool → `POST /api/hires`·`/terminate`(pending 생성). 관측: org read. 페르소나=인사담당(제안만·해고 신중·근거 필수).
- **orchestrator**: ObserveDomainTool(org+queue read) + ProposeBudgetTool/ProposeEnableSendTool(승인요청). 페르소나=도메인 매니저(bounded envelope·propose-only).
- **strategy**: ObserveQueueTool(gateway) + ProposeTargetScopeTool(신규타깃 제안, 실 편입은 별도승인). 페르소나=전략·수집운영.
- **runtime-mapping.ts**: role persona→role agent_type 바인딩 추가(work persona와 대칭).
- 안전: 전부 propose-only(직접 mutate 0), control-plane 게이트가 실행, HR 자기승인 불가, per codex TOCTOU/scope 고정.

## 6. phasing
- **P4a ✅ 완료(2026-07-12)**: first-cut 3 role 스킬 저작 + runtime-mapping 바인딩 + 등록 검증.
  - `secu-agent-skill/roles/{hr,orchestrator,strategy}/`: SKILL.md + worker.md + plugin/{<role>_plugin.py, tools.py} + roles/_shared.py(control-plane/gateway httpx 헬퍼).
  - 각 role: `register_agent_type` + `register_task_toolset`(propose-only tools) + `register_task_contract`(role 페르소나·terminal_tools). 코어 0줄.
  - 도구: hr(observe_org·propose_hire·propose_terminate), orchestrator(observe_domain·propose_budget_override·propose_enable_send), strategy(observe_queue·recommend_scan_priority). 전부 propose/advisory·직접 mutate 0.
  - 배치 규약: `SA_SKILLS_DIRS=roles`(부모, 하위 role 디렉토리 로드), `SA_PLUGINS=roles/<role>/plugin/<role>_plugin.py`(고유 stem — bootstrap.py 동명 충돌 회피). 파드는 role별 단일 스킬 pin(SkillsSelection).
  - `contracts/runtime-mapping.ts`: `RoleSkill`·`roleSkillFor(persona)`·`skillBindingFor(domain,persona)` — people_ops→hr·*_sentinel→orchestrator·*_strategist→strategy. 시드 9종 바인딩 검증(hr1·orch4·strat4).
  - **검증**: 엔진 등록(agent_type·toolset·contract·SKILL.md·페르소나) 3종 전부 통과 + monorepo 빌드 green.
- **P4b(후속)**: 대화형 role(코어 operator_core role-중립화 — 코어 세션 조율) · orchestrator A2A/delegatedTask 표면 설계(codex: capability 발급·provenance·TTL) · control-plane MCP 래핑 · role 파드 SkillsSelection 배선(control-plane/operator) · 런타임 E2E(control-plane 띄우고 propose 도구 실호출).

## 7. ★ 권한분리 하드닝 (적대적 검증 필수 발견 — paperclip 방어의 실제 강제)

P4a 적대적 검증: propose-only·코어무수정 = **holds**. 그러나 power-separation = **weak** — 현재 안전이
"role 툴셋에 approve/egress 도구가 없다"는 **역량 부재**에 의존할 뿐 control-plane이 강제하지 않는다.
즉시 조치(완료) + 필수 후속:

- **[완료] approval id 비노출**: propose 도구가 approval id를 LLM에 반환하지 않게 수정(self-approve 재료 차단).
- **[완료] orchestrator 페르소나 정합**: pause/resume이 무게이트임을 정확히 반영(위협모델 과대선언 제거).
- **[완료·control-plane, 이 repo] approve/reject 인증 + 요청자≠승인자 강제**(2026-07-12): 실행(approve/reject)에
  `APPROVER_TOKEN`(Bearer) 게이트 — 미보유 요청은 403 `approver_unauthenticated`. 제안/요청 엔드포인트는 개방 유지
  (에이전트 propose 정상). 자율 에이전트는 control-plane 직접호출이라 토큰이 없어 승인 불가 → propose→self-approve
  paperclip 차단. 추가로 SoD 가드 `appr.requestedBy==APPROVER.id → 409 self_approval`(신원 실체화 시 실효되는
  forward-compat 층). 토큰 비교는 sha256+`timingSafeEqual` 상수시간. `APPROVER_TOKEN` 미설정=dev 후방호환(부팅 경고 1회).
  web dev는 vite 프록시가 `/api`에 서버측 토큰 주입(브라우저 미노출) → 사람(UI)은 승인, 에이전트(직접호출)는 403.
  **E2E(라이브 DB) 검증**: no-token/wrong/near-miss→403 · correct→200 · self(reqBy=root)→409 · 무설정 인스턴스→200.
  구현: `control-plane/src/index.ts`(approverTokenOk·approve/reject 게이트·SoD·boot 경고)·`web/vite.config.ts`·`.env.example`.
  후속(운영): vite 주입은 dev 배선 — 프로덕션은 실 승인자 신원(세션/SSO)로 `APPROVER.id`·`requestedBy`를 실체화해 SoD를 활성화.
- **[완료·확장, 2026-07-12 codex B/D]**: operator mutation(pause/resume/disable-send/usage/telemetry)도 `requireApprover`
  게이트(에이전트가 kill-switch 무력화·위조 usage로 auto-hardstop DoS 차단). 토큰 미설정=**기본 deny(fail-closed)**,
  무인증 dev는 `ALLOW_INSECURE_DEV_APPROVER=true` 명시 opt-in만(NODE_ENV 오타 fail-open 회피). dist 재빌드로 stale-dist 우회 차단.
  E2E: 무토큰→403·토큰→200·opt-in→200·prod/기본→403.
- **★ 미해결 한계(codex D — 정직 기록, 프로덕션 필수)**:
  1. **Vite confused-deputy(HIGH)**: dev vite 프록시가 `/api` 전체에 토큰을 ambient 주입 → :5173에 닿는 **동일 호스트 프로세스**(브라우저 아님)도 승인/운영 조작 우회 가능. dev(단일 사용자·localhost) 한정 허용, **프로덕션은 인증된 운영자 세션(BFF/SSO)** 필수 — vite ambient 주입 제거. Origin 검사는 위조 가능해 불충분.
  2. **proposer 인증 부재(MED)**: 제안 엔드포인트(hire/terminate/…)는 개방이 맞으나 `requestedBy='hr'` 하드코딩이라 실제 호출자 무관하게 기록 → 감사 위조·SoD 무력·hire 큐 DoS(rate-limit/quota 없음). 프로덕션은 **proposer 신원 인증 + rate-limit/quota + 실제 actor 귀속** 필요.
  3. **telemetry**: pod(기계) 표면이라 배선 시 사람 승인자 토큰 재사용 금지 — 별도 `TELEMETRY_TOKEN`/workload identity/mTLS 필요(현재 off·caller 없음, 임시로 approver 게이트로 닫아 둠).
- **[필수·엔진/코어] role task_type MCP allowlist**: `_register_mcp_tools`(tools/__init__.py:156)가 role registry에도
  egress-capable MCP를 무조건 실음 → role 파드엔 generic HTTP/fetch MCP를 **구성하지 않거나** role registry 빌드에서
  egress MCP를 배제. 코어 세션 조율.
- **[운영] role 파드 격리**: role 에이전트는 control-plane 요청 엔드포인트(제안)·gateway read만 닿는 네트워크 정책.

## 8. 열린 질문(사용자 확인)
- 배치 확정: `secu-agent-skill/roles/<role>/`(무수정 해제로 skill repo 하위 채택). SA_SKILLS_DIRS=roles·SA_PLUGINS=roles/<role>/plugin/<role>_plugin.py.
- 대화형 role(P4b): operator 페르소나 role-중립화(코어개선)를 언제 코어 세션과 진행할지.
