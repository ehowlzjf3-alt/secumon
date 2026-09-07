# secu-agent-skill — secu-agent 도메인 plugin 콘텐츠

> **먼저 볼 것: [`CLAUDE.md`](CLAUDE.md)** — 러너/리드/워커 3층 구조 지도 + 실측 현황.
> 이 README 는 도메인별 파이프라인 **상세**를 담는다. 아래 「레이아웃」절은 추출 당시
> (v3.81)의 기록이라 현재 디렉터리와 다르다 — 현재 구조는 CLAUDE.md 를 보라.

secu-agent 엔진의 v3.80 de-domain 추출로 분리된 도메인(점검) 콘텐츠 전부.
엔진은 도메인-프리 코어(operator/finding_narrator/package_sandbox + WorkerPool 트랙)로
유지되고, 이 repo 가 재부착 plugin API(후속 설계)의 콘텐츠 소스가 된다.

## 레이아웃 (v3.81 추출 시점 기록 — ⚠️ 현재와 다름)

> 현재 도메인 집합은 **smb · dev_web · services/{github,confluence,jenkins}** 이고,
> `domains/web/` 은 dev_web 이전 후 남은 잔재다. 아래는 추출 당시의 원본 대응표로만 쓴다.
> 지금 구조·현황은 [`CLAUDE.md`](CLAUDE.md).

레이어별 평면 구조(agent_types/tools/prompts/…)를 **도메인별 skill 번들**로 재배치했다
(reorg 명령문). 각 도메인은 자기완결 번들이고, 외부 의존성(impacket/bs4/pdf/REST)은
각 `plugin/` 안에만 격리된다.

```
domains/
  smb/        SKILL+api+schema+snippets+safety.md · plugin/{agent_types,tools} · prompts/ agents/ tests/ eval/ reattach.md
  web/        SKILL+api+schema+snippets+safety.md · plugin/{agent_types,tools} · prompts/ tests/ eval/ reattach.md
  services/   SKILL+safety.md · prompts/ · plugin/tools/(공통) · github/ confluence/ jenkins/(per-service sub-skill+plugin) · tests/ eval/ reattach.md
_shared/      detectors/ skills/ config/ eval/ tests/   # 도메인 횡단 (README.md 참조)
engine_extracts/   # 도메인 batch phase/goal 빌더 적출 원형 — 분할 말고 그대로 유지
tools/  tests/     # (C) 코어 환원 후보만 잔류 (operator/domain_report/entity_tools + ralph_orig 테스트)
docs/  SAFETY-NOTES.md  README.md
```

| 위치 | 원위치 (엔진) | 내용 |
|---|---|---|
| `domains/<d>/SKILL.md …` | `agent/skills/<d>_tasking/` | 도메인 skill 번들 (entry + api/schema/snippets/safety) |
| `domains/<d>/plugin/agent_types/` | `src/secu_agent/agent_types/` | (P) 프로토콜 에이전트 — 외부 의존성 격리 |
| `domains/<d>/plugin/tools/` | `agent/tools/` | (P)/(G) 도메인 Tool .py |
| `domains/<d>/prompts/ agents/` | `agent/prompts/`·`agent/agents/` | (G) system 프롬프트·sub-agent md (SKILL.md 흡수 후보) |
| `domains/<d>/tests/ eval/` | `tests/`·`agent/eval/scenarios/` | 도메인 테스트·eval (재부착 전 inert) |
| `domains/<d>/reattach.md` | — | 3축 라벨 + 그 도메인이 재공급할 엔진 hook + dep |
| `_shared/` | detectors/·skills/·config/ | 도메인 횡단 (키워드 사전·core 참조 skill·targets·공용 테스트) |
| `engine_extracts/` | ralph_controller/goal_manager | 도메인 batch phase + goal 분류기/빌더 적출 원형 |
| `tools/`·`tests/` (루트) | `agent/tools/` | (C) 코어 환원 후보 3종 + ralph 원형 테스트 (이동 안 함) |
| `docs/` | — | 추출 플랜, 재부착 의존성, 설계 원자료(design-archive) |

도메인 집합: **smb · web · services(github/jenkins/confluence) · _shared**.

## Kubernetes 배포 스캐폴딩

도메인별 독립 실행 단위는 `deploy/k8s/domains/<domain>/` 아래에 분리했다. 공통
namespace/runtime/env/PVC는 `deploy/k8s/base/`, 전체 조합은
`deploy/k8s/overlays/all/`에서 렌더한다. 컨테이너 이미지는
`deploy/container/Dockerfile`로 skill repo와 engine repo를 함께 넣어 빌드한다.

```bash
cd ~/project/secu-agent-skill
deploy/k8s/bin/secu-k8s preflight local all
deploy/k8s/bin/secu-k8s build-image
deploy/k8s/bin/secu-k8s preflight deploy all
deploy/k8s/bin/secu-k8s apply all
deploy/k8s/bin/secu-k8s wait all
```

시각화는 Headlamp/Kubeshark/K9s 설정을 `deploy/k8s/addons/`와 `deploy/k9s/`에 둔다.
상세 절차와 운영 스크립트는 `deploy/k8s/README.md`와 `deploy/k8s/bin/secu-k8s`를
따른다.

## SMB E2E 파이프라인 (구현 완료)

`smb_domain_e2e.md` 요구의 E2E 파이프라인 **구현 완료** (설계: `docs/smb-e2e-redesign.md`).
**엔진(`~/project/secu-agent`) 무수정** — 런타임은 de-domain 엔진(`PYTHONPATH=secu-agent/src`)
이고, 도메인은 전부 `plugin/bootstrap.py`(`SA_PLUGINS`)의 등록형 주입으로 붙는다.

```
[코드 cron 수집기]  service/collector/   (LLM 0)
  runner.py        poll 루프(하트비트·control_flag·run_now·7d due·단일-run 가드)
  sweep_core.py    enumerate_hosts→list_shares_modes(3모드)→upsert_smb_share (lockout reset=러너 1회)
  walk_core.py     host claim→walk_share_detailed(checkpoint)→메타 적재 (print 폴더 제외)
  print_filter.py  print$/spool/driver 제외(error='excluded:print' 마커)
  splunk_owner.py  MCP splunk_search(LOOKUP_CONTEXT_ASSET_LIST_V2)→asset_owner
  mail_inbound.py  POP3S passive(STAT/UIDL/TOP/RETR, DELE 금지)→조치요청 답장 적재(dedup)

[3 에이전트]  service/agents/  (skill = contract layer, 도구 화이트리스트 분리)
  task_agent.py         #1 walked 큐→적대적 판정→smb_submit_finding (share-scoped bounded 병렬)
  report_mail_agent.py  #2 confirmed→HTML 리포트+스크린샷→deliver(knox_mail) 자동발송
  reply_verify_agent.py #3 답장 판단→smb_reverify_walk(실제 재검증)→회신 3종
  runtime.py            GuardedHarness 직접 구동(엔진 cli.py 미사용 — task_type hook 부재 우회)
  task_worker.py        fanout 워커 entrypoint(재부착 시)

[도메인 실행 adapter] domains/smb/
  runners/{collector,task,report_mail,reply_verify}.py
  webapp/app.py        # SMB FastAPI 구현 (루트 webapp/·dev_webapp/ 호환 shim 은 2026-08-15 제거)

[신규 서비스 8767]  domains/smb/webapp/   (기존 8766 service/ 는 끔)
  app.py + routes/{pipeline,cron_control,mail_thread,admin,screenshot}.py + ui/index.html(SPA)
```

Clean Architecture 배치:

- `domains/smb/application/` — SMB 유스케이스와 포트. fanout plan/adapters,
  pipeline read model, report/mail polling loop, 공유 constants 를 소유한다.
- `domains/smb/infrastructure/` — 기존 DB/state, evidence dir, worker env, core
  TaskPlan 실행 API 를 application 포트에 맞춰 감싸는 adapter.
- `domains/smb/plugin/`, `domains/smb/runners/`, `domains/smb/webapp/` — core 등록, CLI/process,
  HTTP/UI adapter 만 둔다. 이 레이어는 application 을 호출하지만 application 은
  `service`/`webapp` 을 import 하지 않는다. 루트 `webapp/`·`dev_webapp/` 하위호환
  entrypoint 는 **2026-08-15 제거**했다(부르는 곳이 자기 테스트뿐이었고 UI 파일 사본까지
  이중으로 들고 있었다). 진입점은 `domains/<도메인>/webapp/` 하나뿐이다.

도구(`domains/smb/plugin/tools/`): `smb_submit_finding`(엔진 SubmitFindingTool 상속 →
finding 제출=#2 큐 트리거), `smb_credential_probe`(safe_probe 래퍼, GET/login-form,
max_hits=5·2s 하드캡), `smb_task_python`/`smb_fetch_scan`(read-only, skill-repo 바인딩),
`smb_build_remediation_report`/`smb_report_screenshot`, `smb_reverify_walk`,
`smb_read_inbox`/`smb_build_reply`. skill: `domains/smb/skills/{smb_task,smb_report_mail,
smb_reply_verify}/SKILL.md`. 신규 DB 테이블(`service/state_domain.py`): mail_thread/
mail_message/screenshot/control_flag/pipeline_heartbeat/pipeline_run.

```bash
cd ~/project/secu-agent-skill
export PYTHONPATH=~/project/secu-agent/src:.
export SA_PLUGINS="$PWD/plugin/bootstrap.py"
python -m domains.smb.runners.collector       # 수집기(주간 cron, --once/--dry-run/--pass)
python -m domains.smb.runners.task            # #1 점검 loop (walked 큐 소비)
python -m domains.smb.runners.report_mail     # #2 조치요청 메일 fan-out 상주 runner
python -m domains.smb.runners.reply_verify    # #3 답장·재검증 상주 runner(POP3 주기 폴)
python -m domains.smb.webapp.app              # 신규 서비스 :8767 (대시보드/제어/스레드/관리)
```

core orchestration 경로:

```bash
export PYTHONPATH=~/project/secu-agent/src:.
export SA_PLUGINS="$PWD/plugin/bootstrap.py"
export SA_SKILLS_DIRS="$PWD/domains/smb/skills"
python -m secu_agent task --list-plans
python -m secu_agent task --plan smb_task          # #1 share fan-out
python -m secu_agent task --plan smb_report_mail   # #2 mail_thread fan-out
python -m secu_agent task --plan smb_reply_verify  # #3 reply/reverify fan-out
python -m secu_agent task --plan smb_e2e_agents    # #1 → #2 → #3 sequential phases
```

위 경로에서는 코어가 `TaskPlan`/`FanoutAdapter`/`WorkerPool` 만 소유하고,
SMB target claim·worker argv·skill contract 는 이 repo 의 skill/plugin 이 공급한다.
각 worker 는 해당 skill 의 `worker.md` 하나만 시스템 계약으로 로드한다.

안전 KEEP 불변식(약화·역전 금지)은 설계문서 §"안전 KEEP" + 각 SKILL.md/safety.md 참조:
lockout reactive(reset=러너 1회), task claim=share, discovery claim=host/subnet, read-only, credential record-only,
auth-read≠안전, POP3 passive+dedup, PII 마스킹/path-jail, charter 없는 점검 금지.

## GitHub E2E 파이프라인 (별도 서버)

SMB 8767 서비스에 붙이지 않고 `domains/services/github/webapp/` 독립 FastAPI 서버로
실행한다. 엔진(`~/project/secu-agent`)은 수정하지 않고, 도메인 등록은
`plugin/bootstrap.py`(`SA_PLUGINS`)를 통해 주입된다.

```
[GitHub E2E] domains/services/github/
  application/     fanout plan·pipeline projection·repo scan/report/recheck service
  infrastructure/  state/runtime adapters
  skills/          github_scan · github_report · github_recheck worker 계약

[러너] domains/services/github/runners/
  pipeline.py           # GitHub 전용 persistent runner(control_flag 소비)
  service/agents/*.py   # 기존 개별 pass 구현(호환 모듈)
  github_discovery_agent.py   # repo enum → github_repo_target
  github_scan_agent.py        # HEAD+history secret scan → github finding/report thread
  github_report_agent.py      # repo-scoped JSON/HTML report
  github_recheck_agent.py     # current HEAD recheck → remediated/still_open

[신규 서비스 8770] domains/services/github/webapp/
  app.py + routes.py + ui/index.html
```

```bash
cd ~/project/secu-agent-skill
export PYTHONPATH=~/project/secu-agent/src:.
export SA_PLUGINS="$PWD/plugin/bootstrap.py"
export SA_GITHUB_WEB_HOST="0.0.0.0"
python -m domains.services.github.runners.pipeline # GitHub 전용 runner
python -m domains.services.github.webapp.app      # GitHub 독립 서비스 0.0.0.0:8770
```

단발 실행은 같은 runner에 `--once`를 붙이거나 아래 개별 agent를 직접 호출한다.

```bash
python -m domains.services.github.runners.pipeline --once
python -m service.agents.github_discovery_agent
python -m service.agents.github_scan_agent
python -m service.agents.github_report_agent
python -m service.agents.github_recheck_agent
```

core orchestration 경로:

```bash
export PYTHONPATH=~/project/secu-agent/src:.
export SA_PLUGINS="$PWD/plugin/bootstrap.py"
export SA_SKILLS_DIRS="$PWD/domains/services/github/skills"
python -m secu_agent task --plan github_scan
python -m secu_agent task --plan github_report
python -m secu_agent task --plan github_recheck
python -m secu_agent task --plan github_e2e_agents
```

GitHub 보고·검사 방법은 SMB IP/share/mail-thread 모델을 쓰지 않는다. Repo 단위
`github_report_thread`와 `github_recheck_result`가 리포트·재검증 상태를 보존하고,
finding lifecycle에는 `task_type='github'`, `asset_kind='repository_file'|'commit_patch'`
로 마스킹된 증거만 적재한다.

## dev_web E2E 파이프라인 (별도 서버)

SMB 8767 서비스에 붙이지 않고 `domains/dev_web/webapp/` 독립 FastAPI 서버로
실행한다. 엔진(`~/project/secu-agent`)은 수정하지 않고, 도메인 등록은
`plugin/bootstrap.py`(`SA_PLUGINS`)를 통해 주입된다.

```
[dev_web 도메인] domains/dev_web/
  application/     fanout plan·pipeline projection·ports
  infrastructure/  state/runtime adapters
  plugin/tools/    discovery/status/submit/report/reverify 도구
  skills/          dev_web_task · dev_web_report · dev_web_reply_verify worker 계약

[4 에이전트] domains/dev_web/runners/
  discovery.py  # Splunk web-log→dev_web_target 큐
  task.py       # target 큐→web_site_sweep→dev_web_submit_finding
  report.py     # report thread→HTML 리포트→deliver(knox_mail)
  reverify.py   # 답장 후 동일 URL 재검증→recheck_result

[신규 서비스 0.0.0.0:8769] domains/dev_web/webapp/
  app.py + routes/{pipeline,targets,control}.py
```

```bash
cd ~/project/secu-agent-skill
export PYTHONPATH=~/project/secu-agent/src:.
export SA_PLUGINS="$PWD/plugin/bootstrap.py"
python -m domains.dev_web.runners.discovery       # #0 dev_web target discovery
python -m domains.dev_web.runners.task            # #1 dev_web 점검
python -m domains.dev_web.runners.report          # #2 조치요청 리포트/메일
python -m domains.dev_web.runners.reverify        # #3 답장 후 재검증
python -m domains.dev_web.webapp.app              # dev_web 독립 서비스 0.0.0.0:8769
```

core orchestration 경로:

```bash
export PYTHONPATH=~/project/secu-agent/src:.
export SA_PLUGINS="$PWD/plugin/bootstrap.py"
export SA_SKILLS_DIRS="$PWD/domains/dev_web/skills"
python -m secu_agent task --list-plans
python -m secu_agent task --plan dev_web_task
python -m secu_agent task --plan dev_web_report
python -m secu_agent task --plan dev_web_reply_verify
python -m secu_agent task --plan dev_web_e2e_agents
```

검사방법은 기존 `domains/web`의 `web_site_sweep`/`web_fetch`/
`web_resource_probe`를 재사용하지만, 큐·finding 전이·리포팅·재검증은
`dev_web_target`/`dev_web_report_thread`/`dev_web_recheck_result` 전용 테이블로
분리한다. dev/stage/test 웹 리스크는 내부 미인가 접근 관점으로 보고하고, 키워드
매칭만으로 finding을 제출하지 않는다.

`dev_web_discovery_agent --loop`는 `/api/control/dev_web_discovery`의 control flag를
폴링하며, `MCP_SPLUNK_URL` 또는 `SPLUNK_REST_URL`+`SPLUNK_TOKEN`으로 Splunk를 직접
조회한다. SMB 8767 앱이나 collector에 붙지 않는다.

## 도메인 서비스 (service/)

엔진에서 분리된 **standalone 도메인 웹 서비스** (v3.82 U3d) — 도메인 finding
표현/적재(domain-reports·aggregate projection) + SMB 리포트(dashboard/share/
file/host report) + owner-mail draft/send (Knox 전송부는 엔진
`secu_agent.knox.owner_mail` 사용). 엔진 코어 8765 는 이 엔드포인트들을
**더 이상 서빙하지 않는다** (generic finding CRUD 만 코어 잔류).

```bash
cd ~/project/secu-agent-skill
PYTHONPATH=~/project/secu-agent/src:. python -m service.app   # 기본 포트 8766 (env SA_DOMAIN_WEB_PORT)
```

- `service/app.py` — FastAPI 팩토리(`create_app`) + uvicorn 러너. scheduler/MCP/
  browser lifespan 없음 — 순수 DB-read 뷰어 + owner-mail 트리거 (백그라운드 작업은 엔진 소유).
- `service/state_domain.py` — 도메인 테이블 12종 DB 레이어 (도메인 테이블 접근의 유일 경로).
- `service/routes/` + `service/services/` — smb / domains / domain_reports / findings_domain
  (aggregate + owner-mail 3종, `?token=` 쿼리 토큰 패턴 유지).
- 테스트: `service/tests/` (엔진 스위트와 **동시 실행 금지** — 공유 PG, 직렬 only).

## Confluence E2E 파이프라인 (별도 서비스)

Confluence E2E는 SMB 8767 서비스에 붙이지 않는다. 도메인 구현은
`domains/services/confluence/` 아래의 application/fanout/skill/webapp으로 분리하고,
엔진에는 `plugin/bootstrap.py`의 등록형 fanout adapter로만 재부착한다.

```bash
cd ~/project/secu-agent-skill
export PYTHONPATH=~/project/secu-agent/src:.
export SA_PLUGINS="$PWD/plugin/bootstrap.py"
python -m domains.services.confluence.runners.pipeline # discovery → task → report → recheck 상주 runner
python -m domains.services.confluence.webapp.app       # 기본 0.0.0.0:8773 (env SA_CONFLUENCE_WEB_HOST/PORT)

python -m service.agents.confluence_discovery_agent # space + SSO discovery one-shot
python -m secu_agent task --plan confluence_space_task
python -m secu_agent task --plan confluence_sso_task
python -m secu_agent task --plan confluence_report
python -m secu_agent task --plan confluence_recheck
python -m secu_agent task --plan confluence_task
python -m secu_agent task --plan confluence_e2e
```

흐름은 `run_confluence_space_discovery()`가 채우는 `confluence_space_target`
rolling queue와 `run_devops_discovery()`가 채우는 `devops_target(service='confluence')`
SSO URL queue를 별도 worker가 소비한다. 결과 finding은 `confluence_report_thread`
로 space 단위 리포트에 묶이고, `confluence_recheck`가 page/comment/attachment/version
표면을 읽기 전용으로 재검사한다. SMB 8767 앱이나 collector에 붙지 않는다.

## 워커 운영 — 현재 상태 (2026-08-26)

> 워커를 **누가 띄우는가**(러너)와 그 위의 **리드 층**은 [`CLAUDE.md`](CLAUDE.md) 에 있다.
> 이 절은 워커 자체의 계약(모델·제출·실행)만 다룬다.

### LLM 프로파일
워커 LLM 의 **단일소스는 엔진 `.env` 의 `SA_CHAT_PROFILE`** 이다.
스킬 `.env` 에서 이 값을 핀하면 안 된다(v3.90 split-brain 재발).

| | 값 | 비고 |
|---|---|---|
| 코드 기본 | **`gemma`** | `SA_CHAT_PROFILE` 미설정·오타 시 착지점 |
| 현재 운영값 | `deepseek` | 사설 DGX Spark 2노드 (엔진 `.env`) |
| 체인 | `deepseek,gemma` | chat 만 폴백. 워커는 단일 프로파일 |
| vision 미지원 | `deepseek` | `service/agents/vision_compat.py` (실측된 것만 등재) |

**도메인별 모델 특화는 없다.** A/B 1~3차의 도메인 특화 결론(dev_web·smb=gpt-oss,
github=gauss)은 **무효**다 — 그때 측정한 실패가 모델 품질이 아니라 게이트웨이 버그
(텍스트 없는 `tool_use` → LiteLLM 500)였고, 2026-08-20 재측정에서 4모델 모두 통과했다.
워커는 `SA_CHAT_PROFILE` 하나를 따르고, 도메인이 모델을 고르지 않는다.

**유일한 예외는 능력이다.** `deepseek` 는 이미지를 400 으로 거부하므로, 이미지가 근거인
smb·dev_web 워커는 `runtime._build_client` 의 능력 기반 대체로 **`gemma`** 를 쓴다.
즉 지금 `SA_CHAT_PROFILE=deepseek` 이면 실제로는 github·confluence 만 deepseek 로 돈다.
이 자리는 '도메인 전용 모델'이 아니라 **vision 대체 슬롯**이다.

> 은퇴(2026-08-20): `gauss-o32`·`gpt-oss`·`gauss-o41` 은 `config/llm_profiles.yaml` 에서 제거됐다.
> gauss-o32 는 추론 폭주로 빈-content 턴을 만들어(6회 중 5회) `contract_violation` 을
> 유발했고 `max_tokens`·`reasoning_effort`·폴백 어느 것으로도 구제되지 않았다
> (빈-content 는 에러가 아니라 '성공한 스트림'이라 폴백이 안 돈다).
> 근거·재현: `docs/core-ask-gemma-profile-and-default.md`, `docs/probes/`.

⚠️ **기본 프로파일이 바뀌면 새 모델의 이미지 수용을 반드시 재확인**한다 —
`require_vision` 예외는 핀이 미지원 목록에 있을 때만 발동하므로, 새 기본값이 이미지를
거부하면 dev_web/smb 태스크가 400 으로 영구히 죽는다. (`docs/LESSONS-LEARNED.md` 3-1)

### finding 제출 계약
finding 은 **코어 증거계약(all-or-nothing)** 을 통과해야 적재된다 — hit 하나라도 증거가
약하면 제출 **전체**가 거부된다. 워커가 같은 제출을 반복하면 `repeat_error.py`
(같은 도구+같은 에러 2회 연속)가 태스크를 종료시킨다.
각 도메인 `worker.md` 에 거부 대응 규약이 있다(판정 `rejected`=확인 0건 vs
`suspected`=일부 통과를 구분해 행동이 다르다). 이 규약이 빠지면 **찾은 유출까지 통째로 잃는다**.

### 실행
```bash
# 안전 러너 — 메일 autosend 강제 OFF + 엔진 venv + PYTHONPATH=skill
scratchpad/run_worker.sh <driver.py>
```
- 한 번에 **하나만** 실행하고 전체 `available` 메모리로 감시한다(공유 머신).
- 워커 성공 판정은 evidence 의 `worker_result.json` 으로만 한다 —
  드라이버의 `status='ok'` 는 워커가 죽어도 `ok` 다.
- 특정 devops_target 재현은 `cycle_scanned_at=NULL`(claim 1순위 정렬키).

## 핵심 문서

- **`CLAUDE.md` — 구조 지도(러너/리드/워커) + 실측 현황 + 불변식. 새 작업은 여기서 시작한다.**
- `docs/CONFIG-OWNERSHIP.md` — **설정 키 소유권 단일 기준(SSOT)**. 코어/스킬/digisecu 중 어디에 두는가.
  판정은 이름이 아니라 **"누가 읽느냐"**. 중복 0 을 `service/tests/test_env_hygiene.py` 가 강제한다.
- `docs/MAIL-EGRESS-POLICY.md` — **메일 발송 제약 단일 기준(SSOT)**. 2축 게이트·`@도메인` 함정·설정 3곳. 값 바꿀 땐 여기부터.
- `docs/LESSONS-LEARNED.md` — **반복하지 말 것**. 라이브 워커 작업에서 실제로 틀렸던 것만
  (계측·원인진단·라이브운영·게이트규칙·협업). 새 작업 시작 전에 훑을 것.
- `docs/core-ask-*.md` — 엔진(무수정 대상)에 올린 변경 요청 원문. 최신은
  `core-ask-gemma-profile-and-default.md`(gemma 프로파일 + 워커 기본값, **반영 완료**).
- `docs/probes/` — 모델 추론폭주/빈-content 재현 프로브 (⚠️ `external-*` 금지).
- `docs/smb-e2e-redesign.md` — **SMB 도메인 E2E 파이프라인 재설계 (승인 설계)**: cron 수집기 → 3 에이전트(점검/조치요청/답장·재검증) → 신규 서비스(8767)·DB·대시보드. 엔진 무수정·contract=skill·런타임 효율 우선. (출처 `smb_domain_e2e.md`)
- `docs/design-archive/engine-surface-verified.md` — 엔진 무수정 확장 표면 코드 검증 결과 (위 설계의 전제)
- `docs/extraction-plan.md` — 추출 단계/검증 전체 기록
- `SAFETY-NOTES.md` — **도메인 안전 하중 인덱스 (KEEP — 재부착 시 뒤집지 말 것)**.
  도메인별 분배본: `domains/<d>/safety.md` (SMB lockout/claim 단위, web SSO 차단기, scope 게이트).
- `docs/reattach-dependencies.md` — 엔진 pyproject 에서 제거된 도메인 의존성 (impacket/bs4/pdf) + 도메인별 plugin 경로
- `docs/REVIEW-core-candidates.md` — (C) 코어 환원 후보 기록 (엔진 트랙 T4 처리)
- 각 `domains/<d>/reattach.md` — 그 도메인이 재공급할 엔진 hook + dep
- `_shared/README.md` — 횡단 콘텐츠 설명

## 재부착 (후속)

엔진의 plugin API 설계 후: 각 `domains/<d>/reattach.md` 의 도구 registry branch +
prompts candidates + agents md + ralph 디스패치/phase + goal 분류기 + unlock 매핑을
plugin hook 으로 재공급. Slice2 의 어댑터 프로토콜(claim_fn/spec_builder/summary_fn)이
그 첫 조각. 외부 의존성(impacket/bs4/pdf)은 각 `plugin/` 경로로 패키징.
