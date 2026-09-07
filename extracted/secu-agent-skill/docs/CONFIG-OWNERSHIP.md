# 설정 소유권 — 단일 기준 (SSOT)

세 저장소가 같은 키를 각자 정의하다가 값이 갈리고, **먼저 읽힌 쪽이 조용히 이기는** 사고가
반복됐다(v3.90 split-brain, 2026-08-15 SMB 계정 불일치). 이 문서가 "어느 키를 어디에 두는가"의
기준이고, `service/tests/test_env_hygiene.py` 가 이를 **강제**한다.

## 규칙 한 줄

> **키는 그것을 읽는 저장소에만 정의한다. 같은 키가 두 곳에 있으면 그것이 버그다.**

값이 같은 중복도 금지다 — 값이 같은 중복은 *아직 안 갈라진* 중복일 뿐이고,
갈라지는 순간 아무 에러도 안 난다.

## ⚠️ 왜 조용한가 — 병합 순서

`service/runtime_env.py::load_runtime_env` 는

```
skill/.env  →  engine/.env      (각 줄마다 `if key not in os.environ`)
```

순으로 읽는다. **먼저 잡힌 값이 이긴다.** 즉 양쪽에 있으면 **엔진 값은 죽고 경고도 없다.**
실제 피해: 워커 LLM 이 구 모델로 남고(v3.90), SMB 접속 계정이 갈렸다(AD lockout 위험).

## ⚠️⚠️ 중복을 없앨 땐 **가려져 있던 死값**이 드러난다

중복 제거는 "같은 값 하나 지우기"가 아니다. **지금까지 이기고 있던 쪽을 지우면, 져 있던 쪽이
처음으로 실제로 쓰인다.** 그게 깨진 값이면 그때 처음 터진다.

실증(2026-08-15): engine/.env 의 `SA_PLUGINS="${HOME}/…/bootstrap.py"` 는 원래부터 깨진
값이었다 — `load_runtime_env` 는 값을 **원문 그대로** 대입하고 `expandvars` 를 하지 않는다.
skill/.env 의 절대경로가 first-wins 로 이겨서 여태 가려져 있었을 뿐이다. 중복을 지우자마자

```
PluginLoadError: plugin 파일 없음: ${HOME}/project/secu-agent-skill/plugin/bootstrap.py
```

로 터졌다. 플러그인 0 = 도메인 능력 0 = 워커 전멸이다.

**더 나쁜 건 사전 점검이 이걸 놓쳤다는 것이다.** 값 동일성을 `os.path.expandvars` 로 비교했더니
`same=True` 로 나왔다 — 런타임이 안 펼치는데 비교만 펼쳤다. 그래서 규칙은 둘이다:

1. 값 비교는 **런타임과 똑같이** 한다(펼치지 않는다). `test_env_values_have_no_unexpanded_variable_references`
2. 중복 제거 후에는 **문법 검사가 아니라 실기동**으로 확인한다 —
   `load_runtime_env(load_plugins=True)` + TaskPlan 개수 + DB 연결.
   스위트 1898 통과는 이걸 못 잡았다(테스트는 플러그인을 conftest 로 따로 붙인다).

## 소유권 매트릭스

| 소유 | 저장소 | 무엇 | 판정 기준 |
|---|---|---|---|
| ① 에이전트 / 코어 런타임 | `secu-agent/.env` | LLM 키·프로파일·추론노브, 코어 DB, 플러그인 로더, **코어 도구가 읽는 것** | 엔진 `src/` 가 읽는가 |
| ② 도메인 / 스킬 | `secu-agent-skill/.env` | 도메인 크리덴셜(GitHub·Confluence·Jenkins·SMB), 메일·POP3, 수집기, 도메인 웹서비스 | 스킬 `domains/`·`service/` 가 읽는가 |
| ③ 배포 / 인프라 | `digisecu-employee` | 컨트롤플레인·게이트웨이 자체 설정, **파드 주입 목록** | digisecu 프로세스가 읽는가 |

### ⚠️ 이름이 아니라 "읽는 쪽"으로 판정한다

이름에 도메인이 붙어도 **코어 도구가 읽으면 코어 소유**다. 실제로 헷갈렸던 것들:

| 키 | 이름만 보면 | 실제 | 소유 |
|---|---|---|---|
| `WEB_USER_AGENT`, `WEB_REQUEST_TIMEOUT` | web 도메인 | 코어 `web_fetch_tool`·`url_safety` | **코어** |
| `SA_WEB_SSO_USER/PASS` | web 도메인 | 코어 `browser_tool.py:1524` | **코어** |
| `MCP_INTERNAL_HOST` | 인프라 | 엔진 `config/mcp_servers.yaml` 치환 | **코어** |
| `SA_TASK_REASONING_EFFORT` | 스킬 워커 노브 | 엔진 `harness/runner.py:153` **만** | **코어** |
| `WEB_MAX_PAGES_PER_DOMAIN`, `WEB_VULN_PROBE_ENABLED` | 코어 web 헌팅 | 엔진 참조 0곳, 스킬만 | **스킬** |
| `GITHUB_*`, `CONFLUENCE_*`, `JENKINS_*` | 코어가 발급 | 엔진 참조 0곳, 스킬 `domains/` 만 | **스킬** |

## 현재 상태 (2026-08-15 재배치 후)

**중복 0.** 이전엔 7개(값 불일치 3개, 그중 SMB 는 계정 자체가 달랐다).

### `secu-agent/.env` — 19키
```
에이전트/LLM   OPENAI_CRED_KEY SOC_USER_ID LITELLM_API_KEY
              SA_CHAT_PROFILE SA_CHAT_PROFILE_CHAIN SA_TASK_REASONING_EFFORT
              OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL   (external 프로파일용 — 사용 금지 중)
코어 런타임    SECU_AGENT_PG_DSN SECU_AGENT_DB_BACKEND SA_PLUGINS SA_RESULTS_DIR
              MCP_INTERNAL_HOST KNOX_OWN_SINGLEID
코어 도구      WEB_USER_AGENT WEB_REQUEST_TIMEOUT SA_WEB_SSO_USER SA_WEB_SSO_PASS
```

### `secu-agent-skill/.env` — 44키
```
도메인 크리덴셜 GITHUB_* CONFLUENCE_* JENKINS_* SMB_USERNAME SMB_PASSWORD
도메인 노브     SMB_MAX_* SMB_HUNT_* SMB_*_MAX_TURNS WEB_MAX_PAGES_PER_DOMAIN WEB_VULN_PROBE_ENABLED
메일/수신       MAIL_SENDER_EMAIL SA_KNOX_MAIL_MCP_URL MCP_SERVER_URL POP3_*
                SA_DELIVERY_* SMB_REMEDIATION_*        ← 정책은 docs/MAIL-EGRESS-POLICY.md
운영            COLLECTOR_* MCP_SPLUNK_URL SA_SMB_* SA_ENGINE_DIR DEFAULT_CHARTER_REF
```

### `digisecu-employee/.env.example`
컨트롤플레인·게이트웨이 자체 값(`CONTROL_PG_DSN`, `GATEWAY_*`, `APPROVER_TOKEN`, …) +
**파드 주입 목록**. 목록은 "무엇을 주입해야 하는가"의 문서이지 **값의 소유처가 아니다.**

- ⚠️ `SA_CHAT_PROFILE` 은 여기서 **의도적으로 뺐다.** 세 번째 소스가 생기면 split-brain 이 재발한다.
- ✅ `SECU_AGENT_PG_DSN` 이 engine/.env 와 **다른 것은 정상**이다 — 게이트웨이는 같은 DB 를
  read-only 롤(`digisecu_gw_ro`)로 읽는다. 중복이 아니라 **권한 분리**다. 통일하지 마라.

## 왜 파일 개수는 못 줄이나

역할이 다르다 — `engine/.env`(엔진 소유·별도 트랙) · `skill/.env`(로컬 실비밀·gitignore) ·
k8s ConfigMap(파일이 아니라 클러스터 오브젝트) · `.env.example`(문서).
**문제는 개수가 아니라 같은 키가 여러 곳에 있는 것**이었고, 그건 위 매트릭스로 해결됐다.

## 재발 방지

`service/tests/test_env_hygiene.py` — 값은 출력하지 않고 키 이름만 본다.

| 테스트 | 막는 것 |
|---|---|
| `test_no_key_is_defined_in_both_env_files` | 중복 자체 (값 일치 여부 무관) |
| `test_core_owned_keys_are_not_defined_in_skill_env` | 스킬이 LLM/코어 설정을 이기는 것 |
| `test_skill_owned_keys_are_not_defined_in_engine_env` | 엔진에 도메인 死값이 쌓이는 것 |
| `test_digisecu_template_does_not_pin_the_llm_profile` | 세 번째 LLM 소스 |
| `test_recipient_allowlist_has_no_bare_domain_entry` | `@도메인` 전사 개방 |
| `test_env_values_have_no_unexpanded_variable_references` | `${HOME}` 미전개 死값 (런타임은 안 펼친다) |

키를 새로 추가할 땐 **먼저 `grep -rn <KEY>` 로 읽는 쪽을 확인하고** 그 저장소에만 넣는다.
매트릭스가 바뀌면 이 문서와 테스트의 `_CORE_OWNED` / `_SKILL_OWNED_*` 를 같이 고친다.

## 2026-08-15 이관 이력

| 조치 | 키 |
|---|---|
| engine → skill | `GITHUB_BASE_URL` `CONFLUENCE_BASE_URL/USER/API_TOKEN` `JENKINS_BASE_URL/USER/API_TOKEN` `WEB_MAX_PAGES_PER_DOMAIN` `WEB_VULN_PROBE_ENABLED` |
| skill → engine | `SA_TASK_REASONING_EFFORT` `SECU_AGENT_DB_BACKEND` |
| engine 중복 제거 | `GITHUB_TOKEN` `SMB_MAX_FILES_PER_SHARE` `SMB_MAX_FILE_MB` |
| skill 중복 제거 | `SECU_AGENT_PG_DSN` `SA_PLUGINS` (엔진 폴백으로 해결) |
| 死값 제거 | `SA_LOOP_INTERVAL_SEC` `SA_MAX_PARALLEL` `ANTHROPIC_BEDROCK_BASE_URL` `ANTHROPIC_DEFAULT_SONNET_MODEL` `ANTHROPIC_DEFAULT_HAIKU_MODEL` `AWS_REGION` `AWS_CA_BUNDLE` |
| digisecu 제거 | `SA_CHAT_PROFILE`(주석화) |
| 값 수정 | `SA_PLUGINS` `SA_RESULTS_DIR` — `${HOME}` → 절대경로 (런타임 미전개, 위 절 참고) |
| 이전 조치 | `SMB_USERNAME` `SMB_PASSWORD` — engine/.env 에서 제거(2026-08-15 오전) |

## 2026-08-28 평면 레인 은퇴 — 소비자를 잃은 키 제거

`grep` 으로 "읽는 쪽"을 확인하고 지웠다. ⚠️ **언급과 읽기는 다르다** — 주석·docstring 에만
나오는 키를 "쓰이는 중"으로 세면 死값이 남는다(`DEV_WEB_TASK_PARALLEL` 이 그랬다: 유일한
참조가 `_shared/session_registry.py:17` 주석이었다).

| 조치 | 키 |
|---|---|
| 평면 레인 은퇴로 死 | `SMB_TASK_PARALLEL` `DEV_WEB_TASK_PARALLEL` `CONFLUENCE_SPACE_PARALLEL` `CONFLUENCE_SEARCH_PARALLEL` `CONFLUENCE_SPACE_BATCH`(example) |
| 선존 死값 | `SMB_MAX_FILES_PER_SHARE` `SMB_MAX_FILE_MB` `SMB_PERSONAL_OWNER` `SMB_HUNT_PARALLEL` `SMB_HUNT_MAX_TURNS` `POP3_POLL_SECONDS` |

점검 동시성은 이제 `lead_agent._DEFAULT_MAX_SESSIONS`(리드당 워커 2)가 정한다.
`POP3_POLL_SECONDS` 는 `mail_inbound` docstring 이 쓴다고 적어 뒀지만 읽는 코드가 없었다 —
실제 주기는 `COLLECTOR_POLL_SECONDS` 다. 문구도 같이 고쳤다.

**지우지 않은 것** (읽기가 상수 우회라 grep 이 놓치기 쉽다 — 전부 안전 계열):

| 키 | 실제 읽는 곳 |
|---|---|
| `SA_DELIVERY_RECIPIENT_ALLOW` | 엔진 `agent/delivery.py:41` `RECIPIENT_ALLOW_ENV` |
| `SA_DELIVERY_AUTOSEND_SINKS` | `service/services/owner_recipients.py:201` `AUTOSEND_SINKS_ENV` |
| `*_REMEDIATION_MAIL_MODE` (4개) | `*_report_mail_tools.py` 의 `mode_env=` 인자 |

## 중복 제거 후 필수 스모크

```bash
cd ~/project/secu-agent-skill
PYTHONPATH=$PWD SA_ENGINE_DIR=~/project/secu-agent ~/project/secu-agent/.venv/bin/python - <<'PY'
from service.runtime_env import load_runtime_env
load_runtime_env(load_plugins=True)          # ← 플러그인 실제 로드가 핵심
import os
from secu_agent.agent.task_plan import list_task_plans
print("TaskPlan:", len(list_task_plans()))   # 4도메인 정상 = 16 (2026-08-28 평면 레인 은퇴 전엔 21)
print("profile:", os.environ.get("SA_CHAT_PROFILE"))
from secu_agent import state
with state.connect() as c:
    print("DB:", c.execute("select current_user, current_database()").fetchone())
PY
```

관련: `docs/MAIL-EGRESS-POLICY.md` · `docs/LESSONS-LEARNED.md` 3-5b·3-5c·3-5d
