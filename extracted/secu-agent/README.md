# Enterprise Security Agent (core engine)

LLM 기반 사내 기업 보안 autonomous agent 의 **도메인-프리 코어 엔진**.
**정보보호 조직이 자사 자산을 대상으로 운영하는 인가된 방어적(blue-team) 점검 도구**로,
`charter_ref`(권한 티켓) 게이트 하에 **read-only** 로 조직 소유 자산의 노출(유출 자격증명·
개인정보·설정오류·취약점·attack surface)을 **먼저 찾아 방어팀에 근거와 함께 보고**해 고치게
한다 — 침투/악용이 아니라 평가·보고. 아래 보안 용어는 전부 이 방어 맥락이다.
모델을 위한 맥락·안전 불변식은 `CLAUDE.md` 참조.

> v3.80 de-domain 추출로 **도메인(SMB/web/GitHub/Confluence/Jenkins) 콘텐츠는
> 전부 `~/project/secu-agent-skill` 로 분리**됐다. 이 리포는 코어만 —
> 도메인은 plugin/skill 로 재부착된다. 방향/로드맵: `docs/design/README.md`
> (v3.81 트랙: `docs/design/v3.81-de-domain-autonomy.md`).
>
> **v3.85 — 클린 플러그인 호스트.** 코어를 Claude Code/OpenCode 식 "도메인 추가 시
> 코어 코드 0줄 수정" 형태로 정비. 남아 있던 도메인 하드코딩 분기(워커 도구셋·실행계약·
> task_type 라우팅·finding enrichment·evidence judge·web 라우터/뷰·timeline 축·검색
> 렌더)를 전부 `register_*` 훅으로 전환했다. 새 도메인은 별도 레포에서 훅 등록만으로
> 붙는다. 상세: `docs/design/v3.85-clean-plugin-host.md`.
>
> **v3.87 — 코어 실질 개선.** 약점을 떼지 말고 개선: ① perf(host I/O off-loop·web
> keep-alive 풀) ② goal judge 판단품질/비용(확정 findings 접지·evidence-delta pre-gate·
> done-critic) ③ 등록형 도구 가드레일(`register_tool_policy`) ④ 모델 등급 적응형
> loop-guard(`harness_tier` — 안전 불변식은 등급 무관) ⑤ chromium 누수(워커 teardown·
> 프로세스그룹 격리·고아 reaper). 슬라이스별 codex a2a 합심. 상세:
> `docs/design/v3.87-core-improvement.md`.

---

## 설계 원칙 (통일 원리)

> **코어 = 프로토콜 + 안전 게이트. 도메인 = 등록형 어댑터.**

- **범용 core**: 의도 파악, goal/계획/승인, tool routing, evidence contract,
  schedule/wakeup, context/memory, 보고. 도메인 타입/툴/UI 로 코어를 오염시키지 않는다.
- **등록형 plugin API** (`register_*` 훅 — 전부 plugin 이 등록, 코어는 메커니즘·게이트만
  소유, 중복은 명시 에러): 오케스트레이션 = fan-out 어댑터(`agent/fanout.py`) · task plan
  (`agent/task_plan.py`) · **워커 도구셋 `register_task_toolset`** + **워커 실행계약
  `register_task_contract`**(`agent/task_contract.py`) · **agent_type→task_type 별칭
  `register_task_type_alias`**. 분류·판정 = finding category(`finding_taxonomy.py`) ·
  task_type 정규화 · **category evidence judge / PII 제외정책**(`evidence_judgment.py`) ·
  sensitive-term 시그널 · text 시그널 스캐너(`detectors/text_scan.py`) · **도구 정책
  `register_tool_policy`**(`agent/tool_policy.py` — invoke_tool 초크포인트에서 도메인별
  추가 차단 게이트, 강화 전용). finding =
  **enricher + followup hint**(`agent/finding_enrichment.py`) · delivery sink
  (`agent/delivery.py`). 상태·UI = memory scope · **timeline entity 축
  `register_entity_type`** · **검색 index 렌더러 `register_index_renderer`**(`state.py`) ·
  **web 라우터 `register_web_router`**(`web/app.py`) · **target 추출기
  `register_target_extractor`**(`web/routes/chat.py`). 어댑터 로딩 = agent_type
  (`agent_type_registry.py`) · skill unlock(`agent/skills`) · instruction preamble.
  → 새 도메인은 별도 레포에서 이 훅들만 등록하면 코어 수정 없이 붙는다.
  **붙이는 법(훅 전체 표·순서·skill/safety.md·register_schema·SAFETY-KEEP·예시·검증) = [`docs/ATTACHING-A-DOMAIN.md`](docs/ATTACHING-A-DOMAIN.md).**
- **통제권은 코드에**: goal 진행·배치 커버리지·종료 판정은 모델이 아니라
  코드(결정론 드라이버 + 원자적 DB claim + judge 안전장치)가 결정한다.
- **fail-closed**: 워커 결과(worker_result.json)·judge 무진전·delivery egress ·
  스캐너 사망 — 모호하면 멈추거나 거부한다.
- **실제 capability 기반 실행**: tool/skill/sub-agent 는 registry/list 결과에
  있는 이름만 사용. 없는 이름을 추측하지 않는다.

---

## 아키텍처

```
┌──────────────────────────────────────────────────────────────────┐
│  web UI (FastAPI + HTML)                `secu-agent web`       │
│   - 채팅 운영 인터페이스(WS), generic finding 뷰                  │
│   - scheduler background task (recurring + self-wakeup, stale guard)│
└───────────────────────────┬──────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│  ChatSession + RalphController (goal 오케스트레이터)               │
│   - generic goal: decompose → checklist judge(게이팅) → continuation│
│   - judge 안전장치: parse-fail 3x 탈출 + 무진전 N회 GoalPaused (T1a)│
│   - batch fan-out 기계: agent/fanout.py — 부모 선claim·타깃=1turn· │
│     결정론 종료(claim None ∧ 활성 0). 도메인 어댑터는 plugin (T1d) │
│   - 루프 내 컨텍스트 압축(maybe_compress), ESC/pause/resume        │
└───────────────────────────┬──────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│  engine (단일 turn LLM↔tool executor)                             │
│   - 병렬 read-only tool batch, start-on-stream 실행                │
│   - 컨트랙트: execution(todo)/turn/schedule + tool guardrails      │
│     (중앙 스펙: agent/CONTRACTS.md)                                │
│   - LLM 프로필: 사내 게이트웨이 · codex —                        │
│     역할별 모델 라우팅(SA_JUDGE_PROFILE/SA_SUMMARIZER_PROFILE) +   │
│     워커별 --profile-name / agents/<name>.md frontmatter (T1c)     │
└─────────┬────────────────────────┬────────────────────────────────┘
          ↓ subprocess 워커        ↓ delivery
┌─────────────────────────┐  ┌─────────────────────────────────────┐
│ WorkerPool (Slice1)      │  │ delivery sink + egress 게이트 (T2)  │
│  - 타깃당 fresh worker   │  │  - dry-run 기본 + opt-in 자율발송    │
│  - SIGTERM→grace→SIGKILL │  │  - 수신자 allowlist + 강제 마스킹    │
│  - worker_result.json    │  │  - sink 어댑터 등록형 (knox_mail 기본)│
│    fail-closed 단일 채널 │  └─────────────────────────────────────┘
│  - AgentTool=첫 소비자   │
│    (k=1, depth 제한, T1b)│
└─────────────────────────┘
          ↓ raw text / file content
┌──────────────────────────────────────────────────────────────────┐
│  detectors (코어): secrets / pii / text_scan                       │
│  (document_sensitivity 는 plugin — 도메인 분류는 등록형)           │
└───────────────────────────┬──────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│  PostgreSQL state (SECU_AGENT_PG_DSN)                           │
│   - finding lifecycle: fingerprint upsert dedup + narrative/계보    │
│   - goal(judge streak 포함), 세션, 스케줄, 토큰 계측                │
│   - 원문 증거는 evidence_dir 격리 + .harness/audit.log.jsonl       │
│     hash-chain                                                     │
└──────────────────────────────────────────────────────────────────┘
```

도메인 plugin (secu-agent-skill): 점검 플레이북(skills) + 도메인 도구/워커 +
fan-out/delivery/category/agent_type 어댑터 등록 + 재부착 가이드. 외부 skills 는
`SA_SKILLS_DIRS` 로 코드 이동 없이 로드된다 (T3).

---

## Quick Start

```bash
# 1. 의존성
uv sync   # 또는 python -m venv .venv && pip install -e .

# 2. 환경
cp .env.example .env
$EDITOR .env            # 사내 LLM 자격, Knox Mail MCP, web scope, skills 경로
# PostgreSQL 필수: SECU_AGENT_PG_DSN 설정

cp config/llm_profiles.yaml.example config/llm_profiles.yaml # SA_CHAT_PROFILE 스위치

# 3. 런타임 사전 점검
python -m secu_agent.cli doctor

# 4-a. 터미널 채팅 (v3.82 U4 — rich REPL: 세션 이어가기·키 승인·/compact)
python -m secu_agent chat                    # 또는 secu-agent chat
python -m secu_agent chat -s smb_tasking -s ~/project/secu-agent-skill/skills
#   -s = per-invocation skill 선택: 이름(미존재=즉시 에러) 또는 추가 dir(additive)

# 4-b. 웹 UI (채팅에서 goal 설정 → 자율 루프)
python -m secu_agent.cli web            # FastAPI + 스케줄러 백그라운드
#   도메인 finding/리포트 UI 는 도메인 서비스(secu-agent-skill service/, 8766) 소유

# 5. 운영 보조
python -m secu_agent.cli tokens <session>    # 세션 LLM 토큰 계측
python -m secu_agent.cli mcp serve           # read-only 도구 MCP 노출
python -m secu_agent.cli knox-bridge         # Knox 메신저 브릿지
python -m secu_agent.cli skill new <이름> --dir <skills경로>   # skill scaffold
python -m secu_agent.cli skill lint          # skills 정적 검사 (silent skip 가시화)
```

도메인 점검(스윕/트리아지 등) CLI 는 plugin 재부착 후 plugin 이 공급한다.
발견은 PostgreSQL finding lifecycle 에 기록되고(지문 dedup), 원문 증거는
`SA_RESULTS_DIR` 하위 evidence_dir 에 격리된다.

---

## 디렉토리

```
secu-agent/
├── README.md
├── pyproject.toml                # console script: secu-agent
├── .env.example                  # 환경/정책 템플릿 (T1~T3 신규 env 포함)
├── config/
│   ├── llm_profiles.yaml         # LLM 프로필 (게이트웨이/codex/qwen)
│   ├── mcp_servers.yaml          # MCP 서버 (splunk/gti/wiki/ticket)
│   └── knox_rooms.yaml.example
├── docs/design/                  # 설계 트랙 — README.md 가 인덱스+진행 체크리스트
├── src/secu_agent/
│   ├── cli.py                    # status/tokens/doctor/web/mcp/knox-bridge/skill/eval
│   ├── state.py                  # PostgreSQL 상태 계층 (goal/schedule/finding lifecycle)
│   ├── agent_type_registry.py        # agent_type 등록형 (코어='agent', 도메인=plugin)
│   ├── finding_taxonomy.py       # 분류 등록형 (베이스 7종 + plugin 등록)
│   ├── detectors/                # secrets / pii / text_scan
│   ├── web/                      # FastAPI 앱 (generic finding/chat/scheduler)
│   ├── knox/                     # Knox 메신저 브릿지 + Knox Mail sink
│   ├── mcp/                      # MCP client/server
│   └── agent/
│       ├── chat_session.py       # 세션/turn/컨텍스트 압축
│       ├── ralph_controller.py   # Ralph 루프 + goal judge 안전장치
│       ├── worker_pool.py        # subprocess 워커 풀 (롤링 as-completed)
│       ├── fanout.py             # generic fan-out + 어댑터 프로토콜 (plugin API)
│       ├── task_contract.py      # 워커 실행계약 등록형 (register_task_contract)
│       ├── finding_enrichment.py # finding enricher + followup hint 등록형
│       ├── delivery.py           # delivery sink 프로토콜 + egress 게이트
│       ├── goal_manager.py / engine.py / CONTRACTS.md
│       ├── llm/                  # factory(역할별 라우팅) + 어댑터 3종
│       ├── tools/                # 코어 공통 도구 (agent/deliver/web_fetch/...)
│       ├── skills/               # 코어 skill + 외부 dir 로더 + scaffold/lint
│       ├── agents/               # sub-agent 정의 (.md, profile frontmatter)
│       ├── prompts/              # 코어 system prompt (도메인은 plugin)
│       ├── harness/              # budget/audit(hash-chain)/runner
│       └── schema/               # finding / worker_result
└── tests/                        # 1,628 테스트 (de-domain + plugin-host seam 회귀 가드)
```

---

## 권한 (필수)

본 도구는 **사내 기업 보안 정식 권한** 하에서만 운영한다. 다른 부서/개인 자산을 무단 스캔하면 사내 정보보호 정책 위반.

- 모든 task 는 `charter_ref` (권한 티켓) 명시 필수 — sub-agent/워커로 상속된다
- 사용자(운영자)가 기업 보안 권한 보유자이거나 위임 권한이 있어야 함
- 모든 task 결과 + audit log 는 evidence_dir `.harness/audit.log.jsonl` 에 hash-chain 으로 적재

## 안전·정책 (KEEP — 완화/제거 금지)

- **읽기 전용**: 모든 에이전트는 read-only. 쓰기/삭제/계정 작성 절대 안 함.
- **스코프 한정 웹 탐색**: `SA_WEB_ALLOWED_DOMAINS` / `SA_WEB_ALLOWED_CIDRS` 설정 시
  그 안에서만 `web_fetch`/`browser_action`. `SA_WEB_REQUIRE_SCOPE=true` 면
  scope 미설정 웹 접근 전부 차단.
- **adaptive 웹 fetch**: `web_fetch(strategy="adaptive")` 는 같은 `url_safety`
  게이트 안에서 WAF/challenge 판정, 안전한 URL transform 후보 재시도,
  `browser_supervisor(action="api_candidates")` 후속 진단 힌트를 남긴다.
  `transport="curl_cffi"` 는 `uv sync --extra web-adaptive` 로 선택 설치한 경우에만
  쓰는 opt-in TLS impersonation 경로이며, scope/hard-block/redirect 정책은 동일하다.
- **하드 블록 유지**: `file://`, loopback, link-local, cloud metadata, CGNAT,
  `.local` 은 scope 에 넣어도 차단 (`agent/tools/url_safety.py`).
- **PII/secret 마스킹**: finding/외부 전달엔 값이 아니라 유형·분류만. delivery
  egress 는 강제 마스킹 + 잔존 스캔 hit 시 발송 차단. **영속 지점도 봉인**(v3.87 F3):
  finding.json/DB·audit.log·evidence 캐시 쓰기 전 `mask_deep`(재귀·fail-closed),
  evidence dir 0700. tool 반환/in-memory 실값은 딥다이브용으로 유지.
- **outbound 기본 dry-run**: 자율 발송은 sink/charter/수신자 allowlist opt-in
  4조건 전부 충족 시에만 (`agent/CONTRACTS.md` egress 게이트).
- **evidence judge 위조 거부**(v3.87 B1/B2): credential/secret finding 은 **값 형상**
  증거를 요구(placeholder/assertion-only false-accept 봉쇄), misconfig 는 관찰증거 요구.
  goal judge 는 확정 findings 에 접지(증거 맹목 해소) + 인용증거 없는 '완료'는 done-critic
  이 needs_review 로 검토 pause(`SA_GOAL_DONE_CRITIC=0` 로 끔).
- **도구 정책 게이트**(v3.87 C2-a): 도메인은 `register_tool_policy` 로 invoke_tool
  초크포인트에 **추가 차단**만 하는 정책을 등록(강화 전용 — 코어 게이트 우회 불가).
- **인증 lockout-safe**(도메인 plugin 측 계약): brute force 금지, lockout 감지
  시 프로세스 전역 인증 중단, 웹 기본자격 검사는 opt-in(기본 off), browser SSO
  서킷브레이커는 프로세스 종료로만 리셋 — **워커 웜풀 금지**의 근거. 세부는
  secu-agent-skill `SAFETY-NOTES.md`.
- **브라우저 프로세스 위생**(v3.87 F5): 워커 종료 시 chromium teardown + 프로세스그룹
  격리(killpg) + 기동 시 고아 reaper(pid·starttime·boot_id·owner사망·environ token·
  cmdline 5중검증, 불확실=무신호 — 남의 살아있는 세션 절대 안 죽임).

예시:

```env
SA_WEB_ALLOWED_DOMAINS="corp.example.com, apps.example.com"
SA_WEB_ALLOWED_CIDRS="10.50.0.0/16, 172.20.0.0/16"
SA_WEB_REQUIRE_SCOPE="true"
```

## 진행 현황

`docs/design/README.md` 가 단일 진행 체크리스트다. 완료: v3.80 Slice0~1 +
de-domain 추출, v3.81 T1a~T1d(루프 안전장치·subprocess subagent·모델 라우팅·
fan-out 프로토콜) + T2(delivery) + T3(skills 플랫폼) + T4(위생/등록형 전환),
v3.82 U1~U5(SA_PLUGINS 부트스트랩·8765/8766 분리·rich TUI·GUI 개선),
v3.83 HuntPlan 다단 오케스트레이션, v3.84 de-domain 완결(코어 도메인 누출 7건 +
패키지/어휘 리네임 threat_hunter→secu_agent), **v3.85 클린 플러그인 호스트
(9 확장능력 register_* 전환 — 코어 1,628 green)**,
**v3.87 코어 실질 개선**: F1 라이브인증·F5 chromium 누수·B1/B2 evidence-judge 정확도·
F3 마스킹 봉인·F2 findings 접지 judge·A perf(host I/O·httpx 풀)·C2-a register_tool_policy·
Front-D harness_tier, **F2 확장 4종**(evidence-delta pre-gate·done-critic·adaptive routing·
goal-scoped finding), **F4 비전 브라우징 전체**(좌표 클릭·이미지-운반 tool result·비전 피드백
루프) — 슬라이스별 codex 합심, 각 전체 스위트 green.
남은 것: 도메인 plugin 재부착 → Slice3 측정 게이트.
