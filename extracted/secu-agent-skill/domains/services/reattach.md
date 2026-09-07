# services 도메인 — 재부착 맵 (github + jenkins + confluence)

협업 시스템 우산 1개 + 내부 per-service sub-skill 3개. 공통 service 레이어는 services
본체(`domains/services/`)가 소유, per-service agent_type/tool 은 각 서브디렉토리. 엔진 트리 불가침.

## 레이아웃

```
domains/services/
  SKILL.md                      # 공통 service 레이어 (← service_tasking.md)
  safety.md                     # 공통 KEEP 하중
  prompts/system_services.txt   # (G) 공통 프롬프트
  plugin/tools/                 # (G) 공통 레이어 도구
    service_task_tools.py       #   github/jenkins/confluence task_scan 오케스트레이터
    devops_discovery_tool.py    #   프록시로그 → devops_target 적재 (SSO 큐)
  github/   SKILL.md  plugin/{agent_types/{github,github_scan}, tools/{github_tools,github_repo_discovery_tool}, github_verify.py}
  confluence/ SKILL.md plugin/{agent_types/confluence, tools/{confluence_tools,confluence_space_discovery_tool}}
  jenkins/  SKILL.md(신설) plugin/{agent_types/jenkins, tools/jenkins_tools}
  tests/ eval/ reattach.md
```

## 외부 의존성 (P) — 격리 위치

| dep | 붙는 파일 | 비고 |
|---|---|---|
| `httpx` | `github/plugin/agent_types/github.py`, `confluence/plugin/agent_types/confluence.py`, `jenkins/plugin/agent_types/jenkins.py` | REST API enumerate (GitHub v3 / Confluence v1 / Jenkins XML). |
| git subprocess | `github/plugin/agent_types/github_scan.py` | clone + worktree/history 스캔. 외부 `git` 바이너리 의존(impacket 같은 pip dep 아님). |

> impacket/bs4/pdf 는 이 도메인에 **없음** — services 는 REST API(httpx) + git subprocess 만.
> `detectors.scan_text`/`secrets` 는 코어/`_shared` 사전 경유(엔진 잔류).

## 3축 라벨

### (P) 잔여 plugin — REST 프로토콜 enumerate
- `*/plugin/agent_types/{github,confluence,jenkins}.py` — httpx REST 열거. **순수 (P).**
- `github/plugin/agent_types/github_scan.py` — clone+스캔. git 프로토콜(P) + detectors(G). **(P/G).**
- `github/plugin/tools/github_tools.py`, `confluence/.../confluence_tools.py`,
  `jenkins/.../jenkins_tools.py` — agent_type 얇은 래퍼. API 라이드. **(P).**

### (G) 가이드化 후보
- `plugin/tools/service_task_tools.py` (G) — **공통 레이어**. artifact→scan→evidence→persist→signal 오케스트레이션, 빌딩블록 generic.
- `plugin/tools/devops_discovery_tool.py` (G/P) — splunk SPL→URL normalize→state upsert. splunk MCP 의존만.
- `github/plugin/github_verify.py` (G) — verify-pivot HEAD 재scan 분류.
- `github/plugin/tools/github_repo_discovery_tool.py` (P/G) — enum(P) + 큐 upsert(G).
- `confluence/plugin/tools/confluence_space_discovery_tool.py` (P/G) — 위 미러.
- `prompts/system_services.txt` (G) — services SKILL.md 흡수 대상.
- `SKILL.md`(공통) + `{github,confluence}/SKILL.md`(기존) + `jenkins/SKILL.md`(신설) — skill 번들.

> (G)/(G/P) tool 상단에 `[REORG 3축=...]` TODO 주석 부착.

## 엔진 hook (재부착 시 plugin 재공급)

원형은 repo 루트 `engine_extracts/`. services 슬라이스:

| hook | engine_extracts 위치 | 내용 |
|---|---|---|
| **tool registry branch** | — | github/jenkins/confluence task_type 에 등록: `*_task_scan`, agent_type 래퍼 도구들, `run_github_repo_discovery`/`github_repo_set_status`, `run_confluence_space_discovery`/`confluence_space_set_status`, `run_devops_discovery`/`devops_target_set_status`. |
| **prompt candidate** | `prompts/system_services.txt` | 협업 시스템 에이전트 공통 프롬프트. |
| **ralph phase** | `ralph_domain_phases.py` | `_devops_batch_phase`(SSO 단일타깃), `_github_batch_phase`(API repo rolling ↔ SSO 교대), `_confluence_batch_phase`(API space rolling ↔ SSO 교대). dispatch: github→confluence→generic devops. |
| **goal builder** | `goal_manager_domain.py` | `is_github_batch_goal`/`is_confluence_batch_goal`/`is_devops_batch_goal` + `batch_service_for_goal` + `build_service_batch_continuation`(=`build_devops_continuation_prompt` alias)/`build_github_repo_continuation`/`build_confluence_space_continuation` + 템플릿(`DEVOPS_SINGLE_TARGET`/`GITHUB_REPO_BATCH`/`CONFLUENCE_SPACE_BATCH`). |
| **unlock mapping** | `skill_default_unlock_tools.py` | (현재 github/confluence/jenkins 항목 없음 — 재부착 시 task_scan/discovery 도구 추가 후보.) |

## 엔진 import seam (`secu_agent.*`)
- `secu_agent.agent.tools.base` — 전 tool 공통.
- `secu_agent.state` — devops_target/github_repo_target/confluence_space_target 큐 (DDL 엔진 잔류).
- `secu_agent.detectors.scan_text` / `.detectors.secrets`(find_high_entropy/mask_secret) — 코어/`_shared` 사전.
- `secu_agent.agent.evidence_judgment.is_low_value_only` — 이메일-only 노이즈 게이트(코어).
- `secu_agent.agent.finding_followup` / `finding_provenance` — generic finding signal/provenance.
- `secu_agent.agent.pivot` — generic live-surface pivot lazy import.
- `domains.services.github.plugin.github_verify` — GitHub HEAD recheck helper.

## 안전 하중 (KEEP) — `safety.md` 참조
read-only·charter_ref 필수·PII 마스킹·credential record-only(능동 사용 금지)·MWG 우회 직결,
SSO 로그인은 코어 browser_tool 서킷브레이커 적용(우회 금지). 사내 호스트 한정(github.com 금지).
