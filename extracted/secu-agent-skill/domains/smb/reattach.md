# smb 도메인 — 재부착 맵 (엔진 hook + dep + 3축 라벨)

엔진(`~/project/secu-agent`)이 plugin API 를 갖추면 이 도메인이 **재공급**할 hook 과
외부 의존성. 엔진 트리는 불가침 — 여기 명세만.

## 외부 의존성 (P) — 격리 위치

| dep | 붙는 파일 | 비고 |
|---|---|---|
| `impacket>=0.12` | `plugin/agent_types/smb.py` (lazy `from impacket.smbconnection import SMBConnection`, line ~133) | SMB enumerate/walk/fetch. **이 도메인의 유일한 impacket 사용처.** |
| `pymupdf`(fitz) / `pypdf` | `plugin/agent_types/smb.py` (lazy `import fitz` / `from pypdf import PdfReader`) | 문서/이미지 텍스트 추출. 도메인 tool(`inspect_tools`/`smb_tools`)은 이 agent_type 경유로만 pdf 탐 → 전이 의존. |

> 외부 의존성은 `plugin/` 안에만 모인다. tool 레이어(`plugin/tools/*`)는 impacket/pdf 를
> **직접 import 하지 않고** `agent_types.smb` 함수 호출로 전이 사용한다.

## 3축 라벨

### (P) 잔여 plugin — 제네릭 도구로 대체 불가 (프로토콜/추출 의존)
- `plugin/agent_types/smb.py` — impacket SMB I/O + pdf/이미지 추출. **순수 (P).**
- `plugin/tools/smb_tools.py`, `smb_host_sweep_tool.py`, `smb_subnet_sweep_tool.py`,
  `smb_python_tool.py` — SMB 프로토콜 라이드(전이 impacket/pdf). **(P).**
- `plugin/tools/smb_owner_lookup_tool.py` — owner(Splunk asset) 조회. §4=「P — owner 조회」.
  외부 lookup 의존이라 plugin. (generic asset-enrichment 잠재 — 후속 코어화 여지, 단 지금은 smb.)

### (G) 가이드化 후보 — SKILL.md/snippets 로 흡수 지향 (.py 잔여 최소화)
- `plugin/tools/inspect_tools.py` (G) — 파일 read/metadata 절차. SMB fetch 만 (P).
- `plugin/tools/triage_tools.py` (G/P) — hit 분류는 scan_text+md 로 (G), 본문 read 는 (P).
- `plugin/tools/master_tools.py` (G) — share_master 오케스트레이션 = skill flow.
- `plugin/tools/subnet_tools.py` (G/P) — subnet 풀 CRUD(state). §4=「G/P — subnet 풀 관리 state」.
- `plugin/agent_types/listing_patterns.py` (G) — `suspicious()` 휴리스틱 분류. 작아서 snippets 흡수 가능.
- `prompts/system_smb*.txt` ×6 (G) — SKILL.md/snippets 로 흡수 대상.
- `agents/smb_*.md` ×4 (G) — sub-agent 정의 = skill resource.
- `SKILL.md`/`api.md`/`schema.md`/`snippets.md`/`safety.md` — 이미 skill 번들(승격됨).

> (G) tool .py 상단에 `[REORG 3축=G]` TODO 주석 부착. prompts/agents 라벨은 본 문서로 갈음.

## 엔진 hook (재부착 시 plugin 이 재공급)

원형은 repo 루트 `engine_extracts/`(분할 말고 그대로 유지). smb 슬라이스:

| hook | engine_extracts 위치 | 내용 |
|---|---|---|
| **tool registry branch** | — | smb task_type 에 등록할 Tool: `smb_subnet_sweep`/`smb_host_sweep`/`smb_python`/`smb_owner_lookup`/`smb_*`(tools), inspect/triage/master/subnet 도구. |
| **prompt candidate** | `prompts/system_smb*.txt` | operator/master/triage/inspect/listing-review system 프롬프트. |
| **agent md** | `agents/smb_*.md` | smb_agent_type/share_master/file_triage/file_inspect sub-agent. |
| **ralph phase** | `ralph_domain_phases.py` | `_smb_batch_phase`(host 단위), `_smb_subnet_phase`(subnet depth-first). dispatch: `is_smb_subnet_sweep_goal` → `is_smb_batch_goal` 순. |
| **goal builder** | `goal_manager_domain.py` | `is_smb_batch_goal`/`is_smb_subnet_sweep_goal` 분류기 + `build_smb_continuation_prompt`/`build_smb_subnet_discovery_continuation` + `SMB_SINGLE_HOST_TEMPLATE`/`SMB_SUBNET_DISCOVERY_TEMPLATE`. |
| **unlock mapping** | `skill_default_unlock_tools.py` | `smb_tasking` → `(smb_subnet_sweep, smb_host_sweep, smb_owner_lookup, smb_python)`. |

## 엔진 import seam (재부착 시 재연결되는 `secu_agent.*` 참조)
- `secu_agent.agent.tools.base` (Tool/ToolContext/ToolError/ToolResult/ToolSuccess) — 전 tool 공통.
- `secu_agent.state` — DB helper (smb_share/smb_file 등 도메인 테이블; 테이블 DDL 은 엔진 잔류, §3 C.3).
- `secu_agent.detectors.scan_text` — hit 스캔 (smb_host_sweep_tool/smb_tools lazy).
- `secu_agent.agent.safe_probe.enrich_hits_with_safe_probes` — hit 보강.
- `secu_agent.agent.tools.image_tools` — smb_tools 의 이미지 inspect 재사용(코어 잔류).
- `secu_agent.agent.cli` (`run_smb_discovery_core`/`resolve_smb_targets`) — RunSmbDiscovery(=operator, (C) 후보) 경유.
- `secu_agent.agent.tools._untrusted.wrap_untrusted` — 외부 콘텐츠 래핑.

## 안전 하중 (KEEP) — `safety.md` 참조
SMB lockout(`_AUTH_DISABLED_REASON` 프로세스 전역, `reset_auth_lockout_flag()` agent 호출 금지),
**file-level claim 금지(claim 단위=host/subnet)**, guest/anonymous + 등록 자격만·brute 금지.
루트 `SAFETY-NOTES.md` SMB 절과 문구 일치 유지.
