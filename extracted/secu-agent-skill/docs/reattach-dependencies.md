# 재부착 시 필요한 의존성 (엔진 pyproject 에서 제거됨)

엔진 de-domain 과정에서 코어 의존성 목록에서 빠진 도메인 전용 패키지. 도메인별 skill
번들 재배치(v3.81) 후 **각 의존성이 어느 도메인 `plugin/` 경로에 격리됐는지** 명시.

## 도메인별 plugin 경로 ↔ 의존성

| 패키지 | 도메인 | 격리 위치 (plugin) | 사용처 |
|---|---|---|---|
| `impacket>=0.12` | smb | `domains/smb/plugin/agent_types/smb.py` | SMB enumerate/walk/fetch (lazy `from impacket.smbconnection import SMBConnection`) |
| `pymupdf>=1.24` (fitz) | smb | `domains/smb/plugin/agent_types/smb.py` | 문서/이미지 텍스트 추출 (lazy `import fitz`) |
| `pypdf>=5.0` | smb | `domains/smb/plugin/agent_types/smb.py` | PDF 추출 (lazy `from pypdf import PdfReader`) |
| `beautifulsoup4>=4.12` (bs4) | web | `domains/web/plugin/agent_types/webdomain.py` | web HTML 파싱 (`from bs4 import BeautifulSoup`) |
| `httpx` | web · services | `domains/web/plugin/agent_types/webdomain.py`, `domains/web/plugin/tools/web_tools.py`, `domains/services/{github,confluence,jenkins}/plugin/agent_types/*.py` | HTTP fetch / REST API enumerate. **엔진 코어에도 잔류**(url_safety probe) — web/services 는 같은 라이브러리 공유. |
| 외부 `git` 바이너리 (subprocess) | services/github | `domains/services/github/plugin/agent_types/github_scan.py` | repo clone + worktree/history 스캔 (pip dep 아님, git CLI 필요) |

> **smb 의 외부 dep(impacket/pdf)은 `domains/smb/plugin/agent_types/smb.py` 한 파일에만** 모인다.
> smb tool 레이어(`plugin/tools/*`)는 이 dep 을 직접 import 하지 않고 `agent_types.smb` 함수
> 호출로 **전이** 사용한다. web 의 bs4 도 `webdomain.py` 한 곳, services 는 REST httpx +
> git subprocess 뿐(impacket/bs4/pdf 없음).

## 엔진 코어 잔류 (도메인 plugin 소유 아님)

- `httpx` — url_safety probe (코어). web/services plugin 과 공유.
- `playwright` — `browser_tool`(코어, SSO 서킷브레이커 포함). web 점검이 경유하나 plugin 소유 아님.
- `url_safety` — `secu_agent.agent.tools.url_safety` (코어). web `plugin/tools/web_tools.py`
  가 **재import 만**(`# noqa: F401`) — 하드블록(file://·loopback·link-local·metadata·.local)은 안전하중.
- `detectors.scan_text` / `detectors.secrets` — 코어. 키워드 사전(`document_sensitivity`/
  `sensitive_terms`)은 `_shared/detectors/`(엔진이 try/except 옵셔널 import, 부재 시 graceful degrade).

## 패키징

plugin 패키징 시 이 repo 의 pyproject/requirements 로 선언:
- 공통: `httpx`
- smb extra: `impacket`, `pymupdf`, `pypdf`
- web extra: `beautifulsoup4`
- services: 추가 pip dep 없음 (httpx 공통 + git CLI 런타임 요구)

각 도메인 plugin 을 독립 extra 로 두면 미사용 도메인의 무거운 의존성(impacket 등)을
설치 안 해도 된다 = (P) 면적·의존성 최소화 목표(reorg 명령문 §1).
