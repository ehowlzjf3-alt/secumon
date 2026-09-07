# web 도메인 — 재부착 맵 (엔진 hook + dep + 3축 라벨)

엔진(`~/project/secu-agent`)이 plugin API 를 갖추면 재공급할 hook·의존성. 엔진 트리 불가침.

## 외부 의존성 (P) — 격리 위치

| dep | 붙는 파일 | 비고 |
|---|---|---|
| `beautifulsoup4>=4.12` (bs4) | `plugin/agent_types/webdomain.py` (`from bs4 import BeautifulSoup`, line 26; 사용 line 160) | HTML 파싱. **이 도메인 유일 bs4 사용처.** |
| `httpx` | `plugin/agent_types/webdomain.py`, `plugin/tools/web_tools.py` | HTTP fetch. 엔진 코어에도 잔류(url_safety probe). |

> playwright(browser_tool)·url_safety 는 **코어 잔류** — 이 도메인 plugin 소유 아님.

## 3축 라벨

### (P) 잔여 plugin
- `plugin/agent_types/webdomain.py` — bs4 HTML 파싱. **순수 (P).**
- `plugin/tools/web_tools.py` — bs4 전이(webdomain 경유) + httpx. **(P).**
  단 `url_safety` 는 코어 잔류라 **import 만 재연결(기계적)**:
  `from secu_agent.agent.tools.url_safety import (validate_url_safe, _is_internal_host, URLSafetyError, _probe_web_resources, ...)  # noqa: F401`.
- `plugin/tools/web_site_sweep_tool.py` — browser/web_tools 오케스트레이션 + scan. (P/G) — sweep 절차 일부 (G) 이나 browser 라이드.

### (G) 가이드化 후보
- `plugin/tools/web_discovery_tool.py` (G) — splunk SPL → state upsert. 절차는 generic(상단 TODO 주석). splunk MCP 의존만 외부.
- `prompts/system_web.txt` (G) — SKILL.md 로 흡수 대상.
- `SKILL.md` — 이미 풍부한 skill 본체. `api/schema/snippets/safety.md` 는 재배치 시 stub 신설(TODO 채움).

## 엔진 hook (재부착 시 plugin 재공급)

원형은 repo 루트 `engine_extracts/`. web 슬라이스:

| hook | engine_extracts 위치 | 내용 |
|---|---|---|
| **tool registry branch** | — | web task_type 에 등록: `web_site_sweep`/`web_fetch`/`web_resource_probe`/`web_vuln_probe`/`web_task_scan`/`run_web_discovery`/`web_target_set_status`. |
| **prompt candidate** | `prompts/system_web.txt` | web 에이전트 system 프롬프트. |
| **ralph phase** | `ralph_domain_phases.py` | `_web_batch_phase` — judge 우회, web_target 1개씩 claim, 완료=pending 0. |
| **goal builder** | `goal_manager_domain.py` | `is_web_batch_goal` 분류기 + `build_web_continuation_prompt` + `WEB_SINGLE_TARGET_TEMPLATE`. markers: `web-batch`/`웹 점검`/`cdep`/`websites`... |
| **unlock mapping** | `skill_default_unlock_tools.py` | (현재 web_tasking 항목 없음 — 재부착 시 web_site_sweep 등 추가 후보.) |

## 엔진 import seam (`secu_agent.*`)
- `secu_agent.agent.tools.base` — 전 tool 공통.
- `secu_agent.state` — web_target_domain 등 (테이블 DDL 은 엔진 잔류).
- `secu_agent.agent.tools.url_safety` — **코어 잔류, plugin 재import only**. 하드블록=안전하중.
- `secu_agent.agent.evidence_judgment` (`judge_web_finding`), `semantic_validation` (`validate_web_resource`) — 코어.
- `secu_agent.agent.tools.browser_tool` — 코어(SSO 서킷브레이커 포함).
- `secu_agent.agent_types.webdomain` — 이 plugin 의 agent_type.

## 안전 하중 (KEEP) — `safety.md` 참조
SSO 서킷브레이커(`browser_tool._SESSION_STATE`, 프로세스 종료로만 리셋 — warm worker pool 금지 근거),
default-credential opt-in(기본 off), url_safety scope 게이트/하드블록(코어 소유, plugin 완화 금지).
