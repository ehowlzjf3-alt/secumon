# SMB 도메인 E2E 파이프라인 재설계 — 설계 문서

> 출처: `smb_domain_e2e.md` (repo 상위). 승인 설계(2026-06-13).
> **구현 상태: 완료(2026-06-13)** — 아래 설계대로 구현됨. 실행/레이아웃은 README "SMB E2E
> 파이프라인" 절 참조. 엔진(`~/project/secu-agent`) git status clean 유지(무수정 검증).
> 효율 = **시스템 런타임 동작 효율**(토큰·벽시계·네트워크부하·락경합·중복작업 최소화).
> 엔진 표면 검증 근거: `docs/design-archive/engine-surface-verified.md`.
>
> **구현 시 확정된 비자명 사실**: (1) 런타임은 **de-domain 엔진**(`PYTHONPATH=secu-agent/src`)
> 이라야 plugin `register_*`/`fanout`/`deliver`/`knox` API 가 살아있다(모놀리스엔 없음).
> (2) 빠진 한 조각 `detectors.document_sensitivity` 는 bootstrap 이 `_shared/detectors/`
> 에서 `sys.modules` 로 seam 연결(엔진 무수정). (3) 엔진 cli.py 워커는 도메인 task_type 을
> 안 받아 3 에이전트는 skill-repo `service/agents/runtime.py` 가 GuardedHarness 를 직접
> 구동(엔진 무수정). (4) Splunk 는 REST+token 이 아니라 **MCP-over-SSE `splunk_search`**
> 가 1차(REST 는 fallback). (5) 점검 도구는 skill-repo 모듈(`service.state_domain`/
> `domains.smb.plugin.agent_types.smb`)에 바인딩(기존 monolith-바인딩 도구는 de-domain 에서
> import 불가).

## Context — 왜 이 변경인가

현재 SMB 도메인은 **agent 가 직접 `smb_python` 으로 subnet sweep/scan/walk 를 매 turn 돌리는** 구조다. 이는 (a) 무거운 네트워크 I/O 를 LLM turn 안에서 직렬 수행해 토큰·벽시계가 폭증하고(회사 규모: 수십 subnet × 수백 host, 텍스트후보 1,651개/미스캔 778개 사례), (b) 발견 후 담당자 통지·조치확인·재검증이 전혀 자동화돼 있지 않다(메일 송신만 있고 POP3 수신·재검증 walk 부재).

`smb_domain_e2e.md` 는 이를 **E2E 파이프라인**으로 재설계할 것을 요구한다: 코드 cron 이 지속 수집(주간) → 큐를 LLM 점검 에이전트가 적대적 판정 → HTML 리포트+스크린샷 → `[보안취약점 조치요청](IP)` 메일 → POP3 답장 확인 → 실제 walk 재검증 → 완결/재요청. 별도 UI/DB 와 파이프라인 대시보드 포함.

**설계 토대(사용자 확정):**
- **엔진(`~/project/secu-agent` de-domain 코어) 절대 무수정.** 모든 도메인 코드는 `secu-agent-skill` 에. (런타임 venv 가 현재 구 `secu-agent` 모놀리스로 해석되나, 설계·구현 대상은 skill repo 이고 secu-agent 코어 트리는 안 건드린다.)
- **contract layer = "skill" 단위.** 엔진에 task_type→tool registry hook 을 추가하지 **않는다**(검증결과 그 hook 부재 = (C) 병목). 대신 엔진이 주는 **generic 도구**(`smb_python`=임의 script 실행, `scan_text`, `submit_finding`, `deliver`, `skill`, `tool_search`, `todo`)만 쓰고, 각 에이전트는 **자기 전용 SKILL.md + 그 skill 이 unlock 하는 도구 + 동적 생성/재사용 script**(Claude Code 가 generic 도구로 무엇이든 하고 작성 script 를 tmp 재사용하듯)로 행위를 규정한다. → 엔진 오염 0, 청결 유지.
- **`smb_python` = read 용도 그대로.** smb 모듈이 write API 미노출 + skill 의 read-only 지침이 근거(도구레벨 별도 강제 불필요).
- **메일 자동 발송** (egress autosend opt-in: `SA_DELIVERY_AUTOSEND_SINKS=knox_mail` + `SA_DELIVERY_RECIPIENT_ALLOW` 에 shaneee.baek; redaction/PII-scan/allowlist gate 유지).
- E2E = **3 에이전트**. **신규 독립 서비스(8767)** 가 UI/DB/대시보드, **기존 8766 service/ 는 끈다**(검증된 Postgres 스키마·`smb.py`·`smb_reports.py` read 로직은 활용).

---

## 아키텍처 한눈에

```
[코드 cron 수집기]  (LLM 0, 독립 러너) ──writes──┐
  주간 subnet sweep → host 3모드 → smb_share         │
  walk → smb_directory/smb_file (메타, print 제외)    │   ┌──────────────────────┐
  Splunk 담당자 → asset_owner                         ├──▶│  Postgres 도메인 DB    │◀── 큐이자 SSOT
                                                      │   │ (smb_* + 신규 테이블) │   (claim/status 핸드오프)
[#1 점검 에이전트]  task skill + per-share fanout ─────┤   └──────────────────────┘
  큐(walked share) claim → 적대적 판정 → submit_finding │              ▲
[#2 조치요청 에이전트] report/mail skill ───────────────┤              │ read/control
  confirmed → HTML리포트+스크린샷 → 자동메일 [조치요청](IP)│   ┌──────────────────────┐
[#3 답장·재검증] reply skill (POP3 passive) ────────────┘   │  신규 서비스 8767      │
  답장 → 조치주장 판단 → 재검증 walk → 회신/완결            │  UI·대시보드·cron제어 │
                                                            └──────────────────────┘
   ※ 세 에이전트를 깨우는 주체 = 신규 서비스의 독립 cron/poll 러너 (상태머신=결정적 라우팅)
```

핵심 원리: **무거운 수집은 코드(LLM 0), 판단만 LLM, 핸드오프는 DB status, 에이전트 구분은 skill, 깨우개는 코드 러너.**

---

## A. 코드 cron 수집기 (요구 1·2) — `service/collector/`

LLM·토큰 0 의 독립 러너. **secu-agent 코어 무수정**이라 discovery 오케스트레이션은 skill repo 가 소유하고 이미 skill repo 에 있는 `domains/smb/plugin/agent_types/smb.py` + `service/state_domain.py` 만 직접 호출한다.

- `service/collector/runner.py` (NEW) — `python -m service.collector.runner`. asyncio poll 루프: 매 tick (a) `pipeline_heartbeat` upsert, (b) `control_flag`(enabled/run_now) 1-row SELECT, (c) due(주간 7d, 또는 run_now) 면 `pipeline_run` 열고 1 pass 실행, (d) run_now 소비(0 리셋). **단일-run 가드**: 명명된 singleton 락 row 로 manual+scheduled 중복·장기 walk 다중폴 방지.
- `service/collector/sweep_core.py` (NEW) — per-subnet: `smb.reset_auth_lockout_flag()` **pass 시작 1회만**(러너 소유, core 안에서 호출 금지 — KEEP 불변식), `smb.enumerate_hosts(subnet, concurrency=64)` → ThreadPool `smb.list_shares_modes(host, modes=null/guest/auth)` → `state_domain.upsert_smb_share(access_modes=...)` → `subnet_mark_swept` → `close_unseen_since(subnets=[subnet])`(subnet-scoped) → `scan_start/finish`. 기존 `smb.py`+`state_domain` 함수만 활용(재구현 아님; 구 모놀리스 `cli.run_smb_discovery_core` 패턴을 skill repo 로 재구성).
- `service/collector/walk_core.py` (NEW) — 메타데이터 전용(fetch/scan 은 #1 의 몫). claim 단위=HOST(`smb_host_claim_next`) → `smb.walk_share_detailed(checkpoint=)` → `upsert_smb_directory`/`upsert_smb_file`(size·is_text_candidate·suspicious_name via `listing_patterns.suspicious`). truncation 시 checkpoint 재개 루프로 소진. `share_set_status('walked')`.
- `service/collector/print_filter.py` (NEW) — **print/spool 폴더 제외**(요구 2). share명 `print$`/`prnproc$`/`drivers`, dir명 정규식(`print`,`프린터`,`spool`,`PCL`,driver-store). 매칭 시 하강 안 하고 파일 upsert 안 함 + `smb_directory.error='excluded:print'` 마커(스키마 변경 0). 패턴은 env/config.
- **Splunk 담당자 적재** — `smb_owner_lookup_tool` 은 agent/MCP 전용(ctx.registry 필요)이라 cron 에서 못 돈다. → `service/collector/splunk_owner.py` (NEW): Splunk **REST API + 토큰 env** 직접 호출(동일 SPL `LOOKUP_CONTEXT_ASSET_LIST_V2`) → `asset_owner_upsert`. (REST 불가 시 owner-enrich 만 #1 에이전트 step 으로 이관 — env 로 토글.)

**claim 정체성 수정(비평 #2)**: LLM-free 러너는 `chat_session` row 가 없어 기존 `smb_reclaim_stale_host_claims`(archived session 기준)가 회수 못 함 → 러너가 **sentinel 식별자**를 쓰고 skill repo 에 **시간기반 collector reclaim**(claimed_at < now-stale) 추가. crash 시 큐 영구 점유 방지.

**런타임 효율**: 수집을 LLM 에서 떼어내 토큰 0; ThreadPool 병렬 네트워크 I/O(직렬 LLM turn 대비 수십배 벽시계); 64 동시 cap=IDS 마진; host claim 으로 같은 host 다중로그인 lockout 회피; 7d cooldown+checkpoint 재개로 중복작업 0.

---

## B. 3 에이전트 — contract layer = skill (요구 3·10)

**task_type 을 나누지 않는다**(엔진 hook 부재 우회). 세 에이전트는 동일 generic 경로로 돌되, **신규 서비스 러너가 spawn 시 각자 다른 SKILL.md 만 로드**(SkillsSelection)하고 `register_skill_unlock_tools(skill, …)` 로 그 skill 이 unlock 하는 도구만 노출한다. 도메인 행위는 **skill 본문 + `smb_python` 으로 짜는 script(evidence_dir/tmp 저장→재사용)** 로 표현. = contract 분리·토큰 절감을 skill 레벨에서 달성, 엔진 무수정.

| 에이전트 | skill (unlock 도구) | 행위 | 입력 큐 → 출력 status |
|---|---|---|---|
| **#1 점검** | `smb_task` (smb_python(read)·smb_fetch_file·smb_inspect_image/pdf·scan_text·smb_credential_probe·**smb_submit_finding**) | 적대적 판정. **메일/POP3 도구 미unlock** | `walked` → `confirmed`(finding) |
| **#2 조치요청** | `smb_report_mail` (build_remediation_report·report_screenshot·deliver) | HTML리포트+스크린샷+자동메일. **sweep/walk·POP3 미unlock** | `confirmed` → `reported`/`awaiting_reply` |
| **#3 답장·재검증** | `smb_reply_verify` (read_inbox·reverify_walk·deliver) | 조치주장 판단+재검증 walk+회신. **점검/리포트 미unlock** | `reply_received` → `remediated`/`re_requested` |

### #1 점검 에이전트 (요구 3)
- **재작성** `domains/smb/SKILL.md`(또는 신규 `smb_task` skill): 기존 sweep/discovery 안내 **전면 삭제**, "DB `smb_file_hit`/메타 읽고 판정 → 의심 파일 deepdive → 반도체 위험기준 → credential 도달성검증 → `submit_finding`" 큐소비형으로. KEEP 안전룰 포함(print 제외 인지, auth-read=부서열람 간주, lockout reactive, **read-only**, record-only).
- **per-share 병렬** = `register_fanout_adapter('smb_task', factory)`(public, 엔진 무수정) + `domains/smb/application/fanout.py`. `domains/smb/plugin/fanout_adapter.py` 는 core 등록용 얇은 adapter 이고, claim/spec/release 정책은 application layer 가 포트로 DB/runtime 을 호출한다. claim_next=`smb_task_claim_next`(SHARE 단위), 1 share=1 subprocess worker, 부모는 worker_result(요약≤500자)만 — share 가 많아도 부모 컨텍스트 bounded. IP/host 단위 메일 리포트는 모든 task-ready share 가 끝난 뒤 draft 를 승격한다.
- **`smb_python` = read.** skill 이 "read-only, write/state-changing 금지" 명시; smb 모듈 write 미노출이 근거.
- **credential 도달성검증** = `smb_credential_probe`(NEW 얇은 래퍼) → 엔진 `safe_probe.enrich_hits_with_safe_probes`(GET·login-form POST only, PUT/PATCH/DELETE 안 보냄, follow_redirects=False) **그대로 활용**. `max_hits=5`·`timeout=2s` **하드캡 명시**, relay/재사용 금지(record-only). 결과 → `smb_file_hit.validation_json`(컬럼 존재).
- **적대적 false-positive 게이트** = 기존 `plugin/smb_evidence_judge.judge_smb_credential_hit`(register_evidence_judge 등록) 그대로 — `${SECRET}`/example/template/value_present-only reject. 그 위에 goal/adversarial checklist 가 "공정/경영/대량인사 실본문 확인? print 제외? credential 상향?" 평가.
- **finding 제출 = SMB 파이프라인이 상속(소유)** — 사용자 결정: `submit_finding` 을 generic 엔진 도구로 **그대로 쓰지 않고**, SMB 파이프라인 전용 `smb_submit_finding`(NEW, `domains/smb/plugin/tools/smb_submit_finding_tool.py`)이 엔진 `SubmitFindingTool`(`domain="core"`, `judge_task_finding`→`canonical_task_type`→`finding_upsert`)을 **서브클래스/래핑**해 상속한다. 상속 도구가 한 호출에서 (1) 부모 generic 경로(게이트+`finding_upsert`, cross-domain dedup/identity) 위임, (2) **SMB 도메인 영속**(`file_set_review`/`share_set_listing_review`/`smb_host_set_status`), (3) **E2E 상태머신 전이**(`walked`/`triaged_completed`의 finding → `mail_thread`/remediation `confirmed` 적재 = #2 큐 진입), (4) **스크린샷 artifact 연결**(점검 중 evidence_dir 에 남긴 PNG → `screenshot` row, finding 과 묶음)을 묶어 처리한다. 즉 finding 제출이 곧 다음 단계(#2 조치요청) 트리거. 엔진 무수정: 상속/래핑은 skill repo 측, `smb_task` skill 이 unlock 하는 도구는 generic `submit_finding` 이 아니라 이 `smb_submit_finding` 이다.
- **공유 dssoc 계정 백프레셔(비평 안전)**: 병렬 worker 는 별 프로세스라 `_AUTH_DISABLED_REASON`(프로세스 전역) 비공유 → 부모가 worker_result 의 lockout status 보고 첫 신호에 **K→1 낮추고 claim 중단**. reset 은 어느 곳에서도 호출 안 함.

### #2 조치요청 에이전트 (요구 4·5·6·7)
- **live SMB I/O 0** — confirmed finding 의 DB 행 + evidence_dir 기존 자료만. 네트워크 0·lockout 0·점검토큰 0.
- `service/services/smb_remediation_report.py`(NEW, `smb_reports.smb_host_report`/`_auth_scope`/`_share_risk_flags` **확장**) → 조치요청사항(공유폴더 설정변경) 포함 HTML. LLM 은 문안 슬롯만.
- **스크린샷 2~3장(요구 4)** — **#1(점검)이 walk/inspect 중 evidence_dir 에 artifact 저장 + `screenshot` row insert**(SMB·render 컨텍스트 보유, 재fetch 회피); **#2 는 기존 artifact 에서 2~3장 select+필요시 렌더만**. 렌더러 `shot_renderer.py`(NEW, Playwright headless) 는 **graceful-degrade**(미설치 시 추출이미지/텍스트만, `render_pdf_pages_as_images` try/except 패턴) — 발송은 계속. 단일 evidence_dir **path-jail**(realpath+`.png` allowlist) 공유.
- **메일** = `owner_mail.build_smb_owner_mail_draft` 확장(제목 `[보안취약점 조치요청](IP)`, 수신자 현재 shaneee.baek 고정→차후 `asset_owner_get`). **자동 발송**: `deliver`(sink=`knox_mail`) 게이트 통과(redaction/PII-scan/allowlist) + autosend env opt-in. 스크린샷은 신규 서비스 정적 URL 임베드(첨부 왕복 회피), data-uri 폴백.
- **제목 IP = correlation 키**: redaction 이 bare IPv4 미매칭 확인됨. 단 매칭은 본문 텍스트가 아니라 **DB `mail_thread.subject_tag` 정규화 키**로(요구 8 대비).

### #3 답장·재검증 에이전트 (요구 8·9) — 최대 신규 갭
- **POP3 수신 신규 구축**(두 repo 0). `service/collector/mail_inbound.py`(NEW): `poplib` over TLS, **passive**(RETR 헤더+본문, DELE/flag 변경 금지), `[보안취약점 조치요청](IP)` 제목 파싱(RE:/FW: 허용), **dedup UNIQUE(message_id)→spawn/send 전에 체크**(POP3 leave-on-server 재처리 방지=KEEP). 메일계정 lockout 도 SMB 철학 미러(`_POP3_DISABLED_REASON` 프로세스 전역, reactive, operator reset).
- **역할 분담**: LLM 은 "답장이 조치주장인가/방법문의인가" 자연어 판단만. **"실제 닫혔는지"는 코드 `reverify_walk`** 결정.
- `domains/smb/plugin/tools/smb_reverify_tool.py`(NEW): finding 의 **이전 노출 share/path 만 좁게** 재검증(신규 prefix-filter 로직 — `walk_share` 에 path-scope 인자 없음). HOST claim(`smb_host_claim`, file-level 금지), `_AUTH_DISABLED_REASON` 셋이면 abort(reset 안 함), **3모드 전부 테스트**(auth-read=부서열람이면 still_open — KEEP). 반환 still_open/now_closed/partially_closed.
- 회신 3종(`service/services/remediation_mail.py` NEW): 미조치(RE: 태그 유지)/window·linux 조치방법 안내(차후 '양식 메뉴' 확장 여지)/조치확인 감사. 전부 egress gate+knox.
- **multi-round cap**: `attempt_count` 상한 N 초과 시 operator 에스컬레이션(무한 reverify 방지).

---

## C. DB — 마스터 스키마 (비평 #5 통일)

기존 `smb_share/smb_directory/smb_file/smb_file_hit/asset_owner/scan/smb_target_subnet` **그대로 활용**(변경 0). 점검 큐는 기존 `pending→in_progress→walked→triaged_completed` 재사용, 7d 재순회는 `triaged_completed→pending`(병렬 status 소스 안 만듦). 신규 테이블(전부 `state_domain` 패턴: DOUBLE PRECISION epoch, CREATE IF NOT EXISTS, core_connect 풀 공유):

- **`mail_thread`** — 키 `(finding_id, host)`(※ ip-UNIQUE 금지: 7d 재순회로 한 IP 다중 finding). `subject_tag`(정규화 correlation 키), `status`(통일 어휘: `reported→awaiting_reply→reply_received→reverifying→remediated|re_requested`), `request_message_id`, `severity`, `claimed_by/claimed_at`(host-level), ts. INDEX(status,claimed_at)/(subject_tag)/(finding_id).
- **`mail_message`** — `thread_id`, `direction`, `message_id` UNIQUE(dedup 1차), `in_reply_to`, `subject`, `from/to`, `body_excerpt`(마스킹·격리), `agent_verdict`(`claims_remediated|asks_how|other|pending`), `received_at`.
- **`screenshot`** — `finding_id`, `share_id`, `file_id`, `kind`, `rel_path`(evidence_dir 상대, raw 격리), `sha256`, `ordinal`(1..3). 바이트는 DB 아님(파일+정적URL=경량).
- **`control_flag`**(singleton, register_idless) — `enabled`, `run_now`, `updated_by/at`. UI 1-row UPDATE.
- **`pipeline_heartbeat`**(component PK, register_idless) — `last_beat`, `phase`, `pid`. liveness.
- **`pipeline_run`** — cycle 스냅샷(collect/task/mail/reverify 카운트). 대시보드 기본뷰가 무거운 GROUP BY 회피.

**핸드오프 = finding/mail_thread status 상태머신.** 각 에이전트는 자기 status 큐만 claim(SKIP LOCKED). 상태=결정적 라우팅(LLM 라우터 토큰 0). **#1→#2 전이의 출처 = 상속 도구 `smb_submit_finding`** — finding 제출이 부모 generic `finding_upsert` 위임과 동시에 `mail_thread`(또는 remediation) `confirmed` row 를 적재해 #2 큐로 넘긴다(별도 polling/추론 불필요, 제출=트리거).

---

## D. 신규 독립 서비스 8767 (요구 0·11·12) — `webapp/`

> ⚠️ **경로 최신화(2026-08-15)**: 이 절의 `webapp/…` 는 설계 당시 경로다. 실제 코드는
> `domains/smb/webapp/` 로 이전했고 루트 `webapp/` 는 제거했다. 아래 파일명을 그대로
> 만들지 말 것 — `docs/CONFIG-OWNERSHIP.md` 와 같은 취지로 **원본은 도메인 아래 하나뿐**이다.

- `webapp/app.py`(NEW) — FastAPI, `SA_SMB_WEB_PORT=8767`. **8766 service/ 는 라우터 include 중단(끔)**. DB 는 신규 풀 안 만들고 `state_domain.connect()`(=엔진 core_connect 싱글톤 풀) 공유.
- routes(NEW): `pipeline.py`(6단계 종합 — collect=scan/swept, task=smb_share.status, mail=mail_thread.status, reply=last_inbound, reverify=reverify, 완결=finding; 기본 스냅샷 + `?live=1` 실시간), `cron_control.py`(on/off·run_now), `mail_thread.py`(스레드/조치추적), `admin.py`(subnet/cred — password_ref=`env:` 강제), `screenshot.py`(path-jail 서빙), `smb_reports.py`(기존 `smb_reports.py`/`dashboard.py`/`shares.py`/`files.py` **그대로 import 재사용**).
- `webapp/ui/index.html`(NEW SPA) — 탭: 파이프라인 대시보드(단계 진행바·하트비트·큐깊이·cron on/off·수동실행)/Findings(레포트+스크린샷 갤러리)/메일 스레드/관리. 기존 `index_orig.html` 의 `renderSmbShareReport`/`renderSmbTree`/`renderSmbHits`/dark CSS **추출 재사용**, WS chat/composer 폐기.
- **cron 제어 = control_flag 폴링**(HTTP 트리거 아님): UI 1-row UPDATE, 러너 tick SELECT. 러너에 인바운드 서버 강제 안 함(런타임 표면 최소).
- **대시보드 liveness 수정(비평)**: 기본뷰를 heartbeat-phase 기반으로 — 진행 중 tasking/walk 단계가 stale 스냅샷에 묻히지 않게.

---

## E. 환경 변수 (`.env.example` 확장)

- SMB auth: `SMB_USERNAME=dssoc`, `SMB_PASSWORD=zxc135!!`(env only, DB 평문 금지). 기존 `SMB_USERNAME/PASSWORD` 의미 그대로(null/guest/auth 3모드).
- Splunk REST: `SPLUNK_REST_URL`, `SPLUNK_TOKEN`.
- POP3: `POP3_HOST/PORT/USER/PASSWORD`(TLS), `POP3_POLL_SECONDS`.
- 메일 자동발송: `SA_DELIVERY_AUTOSEND_SINKS=knox_mail`, `SA_DELIVERY_RECIPIENT_ALLOW`(shaneee.baek), charter_ref 표준 문자열.
- 수집기: `COLLECTOR_POLL_SECONDS`, 주간 cron 시각, `SA_SMB_WEB_PORT=8767`.

---

## 안전 KEEP 불변식 (약화·역전 금지 — 설계 전반 강제)

1. **lockout**: `_AUTH_DISABLED_REASON` reactive, `reset_auth_lockout_flag()` 는 **pass 시작 1회**(러너 소유, core/agent 호출 금지). 병렬 fanout 은 부모 백프레셔(lockout 시 K→1·claim 중단).
2. **claim 단위 = host/subnet** (file-level 금지). reverify 도 host claim.
3. **read-only 점검**: smb 모듈 write 미노출 + skill 지침. `smb_python` 은 read 용도.
4. **credential record-only**: 도달성검증은 GET·login-form POST·헬스체크 한정 + `max_hits=5`·`timeout=2s` 캡, relay/재사용·state-changing 금지.
5. **auth-read ≠ 안전**: ACL 개인계정 명시 없으면 부서/전사 열람 간주. 재검증도 3모드 전부 테스트.
6. **POP3 passive**: 헤더/본문 fetch 만, DELE/flag 금지, dedup→spawn/send **전에** 체크. 메일계정 lockout 미러.
7. **PII 마스킹**: raw evidence 는 evidence_dir 격리(path-jail). 스크린샷·body_excerpt 마스킹분만.
8. **charter_ref** 없는 점검 금지(표준 문자열 부여).

---

## 미해결(구현 전 확인 필요)

- **Splunk REST 경로 실재 여부** — 없으면 owner-enrich 를 #1 에이전트 step 으로(토큰 비용 감수). env 토글.
- **POP3 vs IMAP/Exchange** — 사내 메일이 POP3 노출하는지, 수신함이 dssoc/shaneee.baek 인지(수신 0 갭, 최대 미지수).
- **Knox `send_owner_mail` 의 Message-ID 노출** — 현재 `knox_result` 만 반환(미surface). reply correlation 1차 = subject 태그(IP)+수신자+시간창, message-id 는 가능하면 보조.
- **런타임 venv** — `secu-agent/.venv` 가 구 `secu-agent` 모놀리스로 해석. 설계는 skill repo 대상이나, 실제 기동 시 어느 트리에 plugin 부착할지 배포 단계 확정.

---

## 검증 방법 (구현 후, pytest 금지 — 공유 PG 오염)

- **수집기**: `python -m service.collector.runner` 1 pass → `smb_share`/`smb_directory`/`smb_file`/`asset_owner` row 증가, `pipeline_run` 스냅샷, print 폴더 `excluded:print` 마커, heartbeat 갱신 확인. control_flag on/off·run_now 반영.
- **#1 점검**: walked share 큐에 대해 에이전트 1 host claim→fanout worker→`finding_lifecycle` + `file_set_review` 적재, false-positive(`${SECRET}`) reject, credential probe validation_json, lockout 시 K→1 백프레셔.
- **#2 메일**: confirmed finding → HTML 리포트 + 스크린샷 2~3장(graceful-degrade) → `mail_thread.status='reported'`, deliver dry-run/sent 구분, 제목 `[보안취약점 조치요청](IP)`.
- **#3 답장**: 테스트 메일박스에 `RE: [보안취약점 조치요청](IP)` → dedup→`mail_message` 1건, reverify_walk(3모드, host claim, lockout 존중) still_open/now_closed, 회신 3종 분기, status 전이.
- **신규 서비스**: 8767 기동, `/api/pipeline/overview` 6단계 카운트, cron 제어, 스크린샷 path-jail(`../` 차단), 8766 미기동 확인.
- **엔진 무수정**: `git -C ~/project/secu-agent status` clean 유지.
