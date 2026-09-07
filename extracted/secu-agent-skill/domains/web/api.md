# web_tasking / api — 함수·도구 시그니처 (stub)

> 재배치 시 신설한 stub. smb_tasking/api.md 패턴을 web 으로 채울 자리.
> 정확한 시그니처는 `plugin/agent_types/webdomain.py` · `plugin/tools/web_tools.py` 본문 참조.

## 노출 도구 (plugin/tools/)

| 도구 | 파일 | 용도 |
|---|---|---|
| `web_site_sweep(target_id= / domain=)` | `web_site_sweep_tool.py` | navigate→(SSO 로그인)→route snapshot→scan→probe 자동, 구조화 digest 반환. 점검 시작점. |
| `web_fetch(url)` | `web_tools.py` | bounded 단일 fetch (본문 확인). url_safety 통과 필수. |
| `web_resource_probe(urls)` | `web_tools.py` | 경량 배치 probe (status/content-type). 대량 동일패턴 표본화에. |
| `web_vuln_probe(url)` | `web_tools.py` | 비파괴 vuln probe (resource 의미 확인 후만). |
| `web_task_scan(...)` | `web_tools.py` | 페이지 소스 키워드 스캔 (lead 용 — 단독 finding 금지). |
| `run_web_discovery(siem_filter=)` | `web_discovery_tool.py` | splunk SPL → web_target_domain upsert. |
| `web_target_set_status(target_id, status, finding_count, reason)` | `web_site_sweep_tool.py` | tasked/skipped 마킹. |

## agent_type (plugin/agent_types/webdomain.py)

- `WebFinding`, `CrawledPage` dataclass.
- bs4(`BeautifulSoup`) HTML 파싱 — 이 도메인 유일 bs4 사용처(P).

## 엔진 코어 잔류 (재import only — plugin 소유 아님)

- `url_safety`: `validate_url_safe` / `_is_internal_host` / `URLSafetyError` / `_probe_web_resources`
  (`secu_agent.agent.tools.url_safety`). 하드블록(file://·loopback·link-local·metadata·.local)은 안전하중, 코어 잔류.
- `evidence_judgment.judge_web_finding`, `semantic_validation.validate_web_resource` — 코어.
- `browser_tool` (playwright) — 코어 잔류(SSO 서킷브레이커 포함).

> TODO: 실제 시그니처(인자/반환 타입)를 본문에서 추출해 채울 것.
