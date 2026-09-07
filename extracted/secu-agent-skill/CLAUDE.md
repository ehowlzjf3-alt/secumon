# secu-agent-skill — 구조 지도

> **기준일 2026-08-26.** 이 문서는 "설계 의도" 가 아니라 **지금 코드와 DB 가 그런가**를
> 적는다. 숫자는 전부 실측이다. 틀린 걸 발견하면 이 파일부터 고친다.

엔진(`~/project/secu-agent`, **무수정 대상**)에 붙는 도메인 콘텐츠 + 그걸 돌리는 서비스 층.
도메인은 넷: **smb · dev_web · github · confluence**.

> ## ⚠️ 숫자를 말하기 전에 — `.claude/skills/measure-first`
>
> 이 레포에서 **기술적 결함보다 재는 방법이 더 자주 틀렸다**(8/23 네 번, 8/28 다섯 번).
> 규모를 보고하거나 · 배선이 있다/없다고 판정하거나 · 로그를 세거나 · 스위트를 돌리기 전에
> 그 스킬을 읽어라. 핵심 하나만 옮기면:
>
> **잰 값이 0이면 대상이 없는 게 아니라 내가 잘못 재고 있을 가능성이 먼저다.**
> `grep -rl` 은 주석을 소비자로 세고, 감사 로그의 도구 이름은 `payload.name` 이며,
> 리드 큐는 `status=None` 이 아니라 `claimable_statuses` 별로 물어야 보인다.
> pytest 는 절대 두 개 동시에 돌리지 않는다(공유 DB TRUNCATE → 오진).

---

## 3층 — 러너 / 리드 / 워커

```
┌ ① 러너 ─────────────────────────────── 코드 · LLM 없음
│   무엇을 언제 돌릴지 정한다. control_flag 게이트 · pipeline_run 기록.
│   **태스크 큐에서는 타깃을 고르지 않는다** — 리드 1개를 띄우고 물러난다.
│   discovery·report·recheck 은 여전히 팬아웃(claim N → 워커 N).
└──────────────────────────────────────────────────────────
                    ↓ 서브프로세스
┌ ② 리드 ─────────────────────────────── LLM · **판단**
│   어디를 볼지 정하고 검토원에게 위임한다. **본문을 못 본다**(도구가 없다).
│   러너: `service/agents/lead_pipeline_runner.py` (플래그 전부 기본 off)
└──────────────────────────────────────────────────────────
                    ↓ open_inspection / delegate_inspect
┌ ③ 워커(=검토원) ────────────────────── LLM · **실행**
│   실제로 열어보고 finding 을 제출한다. 본문을 본다.
│   지금은 리드 없이 **러너가 직접** 띄운다(단층).
└──────────────────────────────────────────────────────────
```

**태스크 큐의 시작점은 리드다**(사용자 결정 2026-08-26). 예전의 평면 경로
(`러너 → claim N개 → 워커 N개`)는 **은퇴했다** — 검토원과 평면 워커는 같은 워커였고
(같은 스킬·도구셋) 달랐던 건 누가 띄우느냐뿐이라, 진입점이 둘일 이유가 없다.

⚠️ **지금 리드 플래그 5개가 전부 off 라 태스크 큐가 정지 상태다.** 코드는 리드 전용이
되었지만 리드를 켜는 것은 별도 결정이다 — 아래 「컷오버」 참조.

---

## ① 러너 — 코드

LLM 이 한 줄도 안 돈다. 스케줄·claim·프로세스 관리만 한다.

### 상시 프로세스

| 도메인 | 진입점 | 형태 |
|---|---|---|
| github | `service/agents/github_pipeline_runner.py` | 파이썬 상시 루프 |
| confluence | `service/agents/confluence_pipeline_runner.py` | 파이썬 상시 루프 |
| smb | `service/agents/smb_task_loop.py` · `report_mail_loop.py` · `reply_verify_loop.py` | 루프 3개 |
| dev_web | `scripts/dev_web_loop.sh` | **셸 루프** (혼자 다르다) |

### 게이트 — `platform.control_flag`

컴포넌트별 `enabled` + `interval_seconds`. 러너는 매 폴링마다 이걸 읽는다.
`control_flag_consume_run_now()` 로 즉시 실행도 받는다.

⚠️ **셸 러너의 플래그 조회는 자기 env 를 직접 로드해야 한다.** `dev_web_loop.sh` 는
`load_runtime_env()` 없이 읽다가 조용히 fail-closed 로 12시간 멈춰 있었다.
지금은 `flag_probe` 가 off(0) / on(1) / **못 읽음(2)** 을 구분한다.

### 패스 → 팬아웃 → 서브프로세스

```
run_*_pass()                      service/agents/*_{discovery,scan,report,recheck}_agent.py
  → 팬아웃 어댑터                  domains/*/application/fanout.py
      claim N targets              (상태 전이 + claimed_by/claimed_at)
      WorkerSpec(argv=…, timeout_sec=…, evidence_dir=…)
  → 서브프로세스                   python -m service.agents.<worker> <evidence_dir>
  → worker_result.json            ★ 성공 판정의 유일한 근거
```

`domains/*/runners/*.py` 는 8줄짜리 **얇은 진입점**이다(`service.agents.*_loop.main` 재수출).
로직을 여기서 찾지 마라.

⚠️ **드라이버의 `status='ok'` 는 워커가 죽어도 ok 다.** 판정은 evidence 의
`worker_result.json` 으로만 한다.

### 기록

`platform.pipeline_run`(런 이력) · `platform.pipeline_heartbeat`(컴포넌트 생존).
heartbeat 이 stale 하면 화면에서 **숨기지 말고 회색으로** 보여준다.

---

## ② 리드 — LLM · 판단 (등록됨, 미기동)

### 프롬프트는 하나다

`_shared/skills/lead/lead.md` **258줄 · 4도메인 공용**.
도메인 지식은 프롬프트에 없다 — `lead_adapter.py`(코드)가 주입한다.
`domains/*/agents/*_lead.md` 는 20줄짜리 껍데기다(`system prompt 는 _shared/…` 라고만 적힘).

### 어댑터 5개 — 전부 등록됨

`plugin/bootstrap.py:339 _register_lead_layer()`

| 리드 | 큐 | 검토원 |
|---|---|---|
| `smb_lead` | `public.smb_share` | `smb_file_inspect` |
| `dev_web_lead` | `public.dev_web_target` | `dev_web_inspect` |
| `github_lead` | `platform.devops_target` (service='github') | `github_inspect` |
| `confluence_lead` | `public.confluence_space_target` | `confluence_inspect` |
| `confluence_search_lead` | `public.confluence_search_target` | `confluence_search_inspect` |

⚠️ **`github_repo_target`(22,207건)을 보는 리드가 없다.** github 리드는 SSO 큐에만 걸려 있다.

### 도구 9개 — `_shared/lead_tools.py`

`list_targets` · `target_detail` · `target_hit_summary` · `verify` ·
`open_inspection` / `ask_inspector` / `close_inspection` · `delegate_inspect` ·
`record_pivot` · `set_target_status`(종료)

**본문을 반환하는 도구가 없다.** 이건 규칙이 아니라 도구면의 사실이다.
마스킹은 `LeadTool.execute` 기반 클래스가 강제한다(`_shared/lead_masking.py`).
리드가 받는 대체 재료: `shape`(`<len=11 entropy=3.3>`) · `fingerprint`(8자 해시) · `context`(≤5줄).

### 예산·스위치

| env | 기본 | 뜻 |
|---|---|---|
| `SA_LEAD_MAX_SESSIONS` | 4 | 동시에 살아있는 검토원 프로세스 |
| `SA_LEAD_SESSIONS` | on | 0 이면 세션 도구 미등록 + **계약 본문도 같이 바뀐다** |
| `SA_LEAD_PROFILE` | `gemma`(2026-09-01~) | 리드 모델 핀. 전엔 `codex`(사외) — 배선은 그대로라 값만 되돌리면 복귀 |
| `SA_LEAD_PROFILE_CHAIN` | 미설정=폴백없음 | 명시해야 폴백 |

### 러너 (2026-08-26 배선)

```
service/agents/lead_agent.py             run_lead_pass(domain) — 리드 1회
service/agents/lead_pipeline_runner.py   5개 리드를 control_flag 로 게이트하며 폴링
```

팬아웃 어댑터를 **안 쓴다.** 팬아웃은 `claim N → 타깃 1개짜리 워커 N개` 모델인데, 리드는
큐 전체를 보고 스스로 고르는 것이 일이다(`list_targets` 는 claim 하지 않는다). 러너는
리드 **프로세스 하나**를 띄우고 물러난다. `run_agent` 로도 못 띄운다 — 계약 훅
(egress 캡처·세션 정리·`agents_dir` 고정)은 코어 워커 CLI 경로에서만 발동한다.

| 리드 컴포넌트 | 큐 | 은퇴한 평면 컴포넌트 |
|---|---|---|
| `smb.lead` | `smb_share` | `task` |
| `dev_web.lead` | `dev_web_target` | `dev_web_task` |
| `github.lead` | `devops_target`(github) | `github.sso_task` |
| `confluence.lead` | `confluence_space_target` | `confluence.space_task` |
| `confluence_search.lead` | `confluence_search_target` | `confluence.search_task` |

**은퇴 관문은 패스 함수 안에 있다** (`lead_agent.retired_flat_pass`). 러너에 걸면 샌다 —
dev_web 은 셸 루프가 부르고(`scripts/dev_web_loop.sh`) 수동 CLI 경로도 있다.
조용히 멈추지 않고 heartbeat 를 `retired` 로 갱신해 무엇으로 넘어갔는지 남긴다.

★ **은퇴한 것은 태스크 레인뿐이다.** discovery·report·recheck·mail 은 타깃 큐가 아니라
스레드/메일 큐라 "어디를 볼지 정한다" 가 없다 — 그대로 팬아웃으로 돈다.

⚠️ **리드 플래그는 off 로 심는다.** `control_flag_get()` 은 없는 행을 `enabled=1` 로 자동
생성하므로(`state_domain.py:6196`), 그냥 조회하면 리드 5개가 라이브 큐에서 켜진다.
`ensure_flags_default_off()` 가 조회 **전에** 직접 INSERT 한다.

```bash
python -m service.agents.lead_pipeline_runner --once          # 켜진 것만 1회
python -m service.agents.lead_agent smb --charter-ref SECOPS   # 한 도메인 강제 1회
```

### 컷오버 — 아직 안 했다

코드는 리드 전용이지만 **리드 플래그가 전부 off** 라 태스크 큐는 지금 정지 상태다.
은퇴 직전 24시간 처리량(실측): `task` 511런 · `confluence.space_task` 255 ·
`confluence.search_task` 255 · `dev_web_task` 22 · `github.sso_task` 0.

리드는 지금까지 **수동 2회**만 돌았다(2026-08-26 smb 완주 8턴 / github 예산컷 3턴).
운영 투입 전에 도메인별 1회씩 감시하며 돌려 보는 것이 맞다.

```bash
# 도메인 하나씩 켠다
psql "$SECU_AGENT_PG_DSN" -c "UPDATE platform.control_flag SET enabled=1 WHERE component='smb.lead'"
# 은퇴한 평면 플래그는 꺼둔다 (동작엔 영향 없지만 잔재다)
psql "$SECU_AGENT_PG_DSN" -c "UPDATE platform.control_flag SET enabled=0 WHERE component='task'"
```

**평면 코드는 아직 지우지 않았다.** 리드가 운영에서 검증되면 그때 지운다 —
`smb_task_agent.run_task_pass` · `dev_web_task_agent.run_task_pass` ·
두 `_run_plan_pass` 의 태스크 분기 · 관련 팬아웃 어댑터. 그때까지 테스트도 남긴다
(남은 코드에 테스트가 없으면 조용히 썩는다).

---

## ③ 워커 — LLM · 실행

### LLM 이 실제로 도는 곳은 **9군데**뿐이다

`run_agent()` 호출 지점 전수(2026-08-26):

| 도메인 | 점검(task) | 조치요청(report) | 재검증(recheck) |
|---|---|---|---|
| smb | 검토원 (`_shared/inspect_contract.py`) ※ | `report_mail_agent.py` | `reply_verify_agent.py` |
| dev_web | 검토원 (`_shared/inspect_contract.py`) ※ | `dev_web_report_agent.py` | `dev_web_reverify_agent.py` |
| github | 검토원 ※ <br>`github_scan_worker.py`(repo) | **없음** (결정론) | **없음** (결정론) |
| confluence | 검토원 ※ <br>`confluence_task_worker.py`(SSO) | **없음** (결정론) | **없음** (결정론) |

※ smb·dev_web·github(SSO)·confluence(space/keyword) 점검의 `run_agent()` 는 2026-08-28
부터 **검토원 계약**이 부른다. 평면 레인은 은퇴했고 모듈에는 프롬프트·도구셋(smb 는 claim
sentinel 도)만 남았다. 리드가 대상 하나당 검토원 하나를 띄우고, 검토원 서브프로세스는
엔진(`secu_agent.agent`)이지 스킬의 `*_worker.py` 가 아니다.

⚠️ **예외 하나: `confluence.sso_task` 는 은퇴하지 않았다.** `lead_agent._LEADS` 에 없고
대체 리드가 없어 평면 팬아웃 그대로 돈다 — 그래서 `confluence_task_worker.py` 만 `main`
진입점을 유지한다(다른 셋은 지웠다).

★ **github·confluence 는 조치요청·재검증에 LLM 이 없다.** smb·dev_web 과의 실제 격차는
프롬프트 품질이 아니라 **층이 없는 것**이다.

### ⚠️ 파일 이름 함정 — `*_agent.py` 가 LLM 이 아닐 수 있다

`service/agents/` 안에서 이름과 역할이 **일관되지 않다**:

```
smb_task_agent.py       = **러너 아님**. 검토원 프롬프트·도구셋·claim sentinel 만
                          (평면 레인 은퇴 2026-08-28, 진입점 `smb_task_worker.py` 삭제)
dev_web_task_agent.py   = **러너 아님**. 검토원 프롬프트·도구셋만
                          (평면 레인 은퇴 2026-08-28, 진입점 `dev_web_task_worker.py` 삭제)
report_mail_worker.py   = 서브프로세스 진입점        →  report_mail_agent.py  = run_agent 본체

github_task_worker.py   = **러너 아님**. 검토원 프롬프트·도구셋만
                          (평면 SSO 레인 은퇴 2026-08-28, `main` 삭제)
confluence_task_worker.py = 진입점 겸 본체 — **셋 중 유일하게 `main` 이 산다**
                          (sso_task 레인이 은퇴 대상이 아니라서. space/keyword 분기는
                           검토원 계약이 `_build_user_text` 로 직접 쓴다)

github_scan_agent.py    = **결정론 패스**(run_scan_pass · LLM 없음)   ← 이름이 반대다
github_scan_worker.py   = run_agent 본체
```

**판정 방법은 하나다: `grep -c "run_agent(" <파일>`.** 이름으로 판단하지 마라.

### 검토원 계약 5개 — 등록됨

`plugin/bootstrap.py` — `smb_inspect_contract` · `dev_web_inspect_contract` ·
`github_inspect_contract` · `confluence_inspect_contract` · `confluence_search_inspect_contract`.

검토원의 system prompt 는 **기존 워커 skill 을 그대로 쓴다**(`skills/<domain>_task/worker.md`).
즉 **검토원 = 워커**다. 새 프롬프트를 안 만든 게 아니라 안 만든 것이 설계다.

### 위임되면 종료 동작이 바뀐다

`is_delegated_inspector()`(= `SA_AGENT_DEPTH ≥ 1`) 가 켜지면 검토원은 큐를 닫지 않고
`recommended_status.json` 만 쓴다. **닫는 건 리드**다. 권고를 뒤집으려면 `reason` 이 필요하다.

### 프롬프트 분량

| | 파일 | 줄 |
|---|---|---|
| 리드 | `_shared/skills/lead/lead.md` (공용 1개) | 258 |
| 워커 | `github_task/worker.md` | 231 |
| | `smb_task/worker.md` (+`api.md` 216) | 182 |
| | `confluence_task/worker.md` | 201 |
| | `dev_web_task/worker.md` | 88 |

⚠️ 워커 프롬프트에 **"어디를 볼지 정하는" 내용이 섞여 있다**(예: github worker.md 의
"트리를 걷지 마라 · 검색부터 해라"). 리드를 얹으면 그 판단이 두 곳에 중복된다 —
리드가 좁혀준 범위를 검토원이 자기 프롬프트대로 다시 넓힌다.

---

## 지금 상태 (2026-08-26 실측)

### 큐

| 큐 | 총계 | 내역 |
|---|---|---|
| `public.github_repo_target` | **22,207** | error 12,354 · pending 5,706 · tasked 4,017 · skipped 129 |
| `platform.devops_target` (github) | 1,352 | pending 511 · tasked 463 · skipped 258 · error 112 |
| `platform.devops_target` (confluence) | 15 | skipped 10 · pending 4 |
| `public.dev_web_target` | 2,606 | skipped 1,763 · tasked 796 · pending 46 |
| `public.smb_share` | 4,160 | ignored 3,910 · triaged_completed 249 |
| `public.confluence_space_target` | 25 | skipped 25 |
| `public.confluence_search_target` | 87 | tasked 87 |
| `public.smb_target_subnet` | 1,637 | 전량 swept |

### finding — `core.finding_lifecycle`

github **30,277** · smb 250 · dev_web 72 · confluence 11

⚠️ github 이 99% 다. **밀도 차가 120:1** 이라 화면·보고를 도메인 4열로 짜면 무너진다.
그리고 github 30,277 중 대부분은 **판정자를 안 탄 스캐너 산출**이다(아래 참조).

### control_flag (ON 만)

`collector.sweep` · `collector.walk` · `confluence.report` · `confluence.search_task` ·
`confluence.space_discovery` · `confluence.space_task` · `dev_web_discovery` ·
`dev_web_report` · `dev_web_task` · `github.collector` · `github.discovery` ·
`github.report` · `hunt` · `mail` · `task` · `walk`

**off**: `github.scan`(사용자 지시로 중단) · `github.recheck` · 모든 `*.sso_*` ·
`confluence.recheck` · `reply` · `reply_verify` · `reverify` · `dev_web_reverify`

---

## 리드가 보는 것 / 못 보는 것 (사용자 결정 2026-08-26)

> ⚠️ **2026-09-01: 리드는 이제 `SA_LEAD_PROFILE=gemma`(사내) 다**(사용자 결정).
> 아래 절은 **경계가 왜 이 모양인지**를 설명하므로 그대로 둔다 — codex 배선도 지우지
> 않았고 값만 되돌리면 복귀한다. **모델이 사내로 왔다고 마스킹을 풀지 않는다**:
> 경계는 "지금 누가 앉아 있나" 가 아니라 "누가 앉을 수 있나" 로 정한다.

리드는 (2026-09-01 전까지) `SA_LEAD_PROFILE=codex` 로 돌았고, codex 는
`https://chatgpt.com/backend-api/codex` 다 — **그때 리드가 곧 사외 계층**이었고
마스킹 경계는 그래서 있다. 사용자가 그 경계를 좁혔다:

> "codex 는 엔터프라이즈라 이 정도 정보까지는 괜찮다.
>  실제 사내 공정 레시피 파일 읽는 것만 안 나가면 된다."

**레포트(메일) 본문은 열려 있다.** 실측으로 본문에는 원문이 없다 — 경로·유형·건수·
설명뿐이고, 본문 자체가 이렇게 못박고 있다:

```
github/confluence  "보안상 파일 경로와 값은 메일에 포함하지 않습니다"
dev_web            "보안상 응답 본문은 메일에 포함하지 않습니다"
```

⚠️ **`finding_lifecycle.extra_json.hits` 의 `preview` 와 메일 본문을 혼동하지 마라.**
hits 는 DB 에만 있고 메일 HTML 에 렌더되지 않는다. 한 번 그걸 섞어 읽고 잘못된
전제로 관문을 설계한 적이 있다(2026-08-26).

**막는 것은 하나다 — 공정 레시피 파일의 원문 줄.** 관문은 `lead_masking.mask_tool_content`
한 곳이고(리드 도구 반환과 검토원 답변이 전부 여기를 지난다), 실제로 덮는 채널은
`report_inspection` 의 `notable[].context` ≤5줄이다. 파일을 직접 읽은 내용이 리드로
가는 자리는 거기뿐이다.

```
지나간다   경로·종류·라인번호·건수·검토원 narrative      ← 좌표와 판단
막힌다     context / preview / line_preview 중 레시피    ← 그 파일의 원문 줄
```

⚠️ `document_sensitivity` 의 `semiconductor_process` 전체를 쓰지 않는다. 거기엔
`mask`·`fab`·`photo`·`euv` 같은 넓은 낱말이 있어 `github:org/mask-service/…` 까지 잡는다.
**넓게 막으면 리드가 판단을 못 해 검토원에게 다 떠넘긴다** — 리드 층을 만든 이유의 반대다.
실 DB 레포트 400건 대상 오탐 0건을 테스트가 고정한다.

## 알려진 구조적 갭

1. **github repo 큐에 리드가 없다.** 22,207건이 리드 밖 — `github.lead` 는 SSO 큐(1,352건)에만 걸려 있다.
2. **finding 생성 경로가 셋인데 판정을 타는 건 하나다.**
   - `github_e2e_scan`(scanner.py) → `finding_upsert` **직행**
   - `github_task_scan` 도구 → `_persist_scanned_findings` → `finding_upsert` **직행**
   - `github_submit_finding` → `judge_task_finding` → 범주 판정자 ✅
   → 그래서 github finding 30,277건 대부분이 **판정 없이** 들어왔다.
3. **`pii_evidence_judge` R1 이 `kr_phone` 을 못 건다.** `_leading_digits` 가 하이픈에서
   멈춰 3자리를 주는데 `_is_decimal_fraction_context` 가 `len < 4` 에서 빠진다.
   실측 757 hit 대상 차단율 **0.0%**.
4. **github·confluence 는 report/recheck 에 LLM 이 없다.** (사용자 지시: 붙일 것)
5. **`github_repo_target.default_branch` 오염** — 22,207행이 `or "main"` 폴백값.
   `/repositories` 는 `default_branch` 를 안 준다(`/search/repositories` 는 준다).
6. **`roles/`(hr·orchestrator·strategy) 도 미기동.** `plugin/bootstrap.py` 에 등록이 없고
   자기 자신 말고 부르는 코드가 없다. 리드 층과 **같은 종류의 갭**이다 —
   저작은 끝났고 배선이 없다.

---

## 불변식 (깨면 사고)

- **엔진은 무수정.** 필요하면 `docs/core-ask-*.md` 로 요청한다.
- **`SA_CHAT_PROFILE` 을 스킬 `.env` 에서 핀하지 마라** (v3.90 split-brain 재발).
  `agents/*.md` 에 `profile:` 도 금지 — `--profile-name` 핀이 된다.
- **예산은 요청 타임아웃보다 커야 한다.** `LLMProfile.timeout`=300(codex/qwen 600)이므로
  `max_idle_sec`/`max_wall_clock_sec` 이 그보다 작으면 백스톱이 안 된다.
  엔진 기본값(idle 120 / wall 300)은 **충돌한다** — 호출부마다 명시할 것.
  `service/tests/agents/test_agent_idle_budget_wired.py` 가 강제한다.
- **테스트를 동시에 두 개 돌리지 마라.** `conftest.py:81` 이 DSN 을 공유 테스트 DB 로
  돌리고 `tmp_db` 가 truncate 한다 — 서로를 지운다.
  전체 스위트 범위는 `pytest service/tests domains`(2,096건, ~13분).
- **메일**: 수신처 = 담당자(To) + DSSOC(Cc). 폴백 없음. 담당자 이름·소속은 **마스킹 대상이 아니다**.
  자율발송은 이미 켜져 있다 — `docs/MAIL-EGRESS-POLICY.md` 가 SSOT.
- **커밋 메시지에 Claude 출처표기(Co-Authored-By / 🤖)를 넣지 않는다.**

---

## 실행

```bash
# 컨테이너 워커 — .env 를 이미지에서 뺐으므로 주입이 필수다. 이게 유일한 정문.
~/project/digisecu-employee/deploy/engine/run-worker.sh --verify          # 키 주입 게이트만
~/project/digisecu-employee/deploy/engine/run-worker.sh --domain smb -- task --plan smb_task

# 파이프라인 초기화 (★ 백업 먼저. 산출물만 지우고 대상은 상태만 되돌린다)
psql "$SECU_AGENT_PG_DSN" -v ON_ERROR_STOP=1 -f scripts/reset_pipeline_data.sql

# 전체 스위트
pytest service/tests domains        # 2,096건 · ~13분 · 동시 실행 금지
```

파이썬은 **엔진 venv** 를 쓴다: `~/project/secu-agent/.venv/bin/python`.

---

## 더 볼 것

- `docs/CONFIG-OWNERSHIP.md` — 설정 키 소유권 SSOT (판정은 "누가 읽느냐")
- `docs/MAIL-EGRESS-POLICY.md` — 메일 제약 SSOT
- `docs/LESSONS-LEARNED.md` — 실제로 틀렸던 것만
- `_shared/README.md` — 도메인 횡단 콘텐츠
- `README.md` — 도메인별 파이프라인 상세 (SMB/GitHub/dev_web/Confluence)
