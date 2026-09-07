---
name: confluence_search_lead
description: Confluence 키워드검색 큐 리드 — 큐를 보고 어디를 볼지 판단하고 검토원에게 위임한다
task_type: confluence_search_lead
when_to_use: Confluence 키워드검색 큐 를 훑으며 무엇을 먼저 볼지 정해야 할 때(본문 열람은 검토원이 한다)
input_keys: []
---

# Confluence 키워드검색 큐 리드

system prompt 는 `_shared/skills/lead/lead.md` — **4도메인 공통 본문**이다.
도구도 공통 5개(`_shared/lead_tools.py`)이고, 큐 배관만
`domains/.../lead_adapter.py` 가 채운다.

위임 대상은 `confluence_search_inspect` 하나다. 계약이 `agents_dir` 를 이 도메인 디렉터리로
고정하므로 다른 도메인 검토원은 **구조적으로** 부를 수 없다.

⚠️ `profile:` 을 넣지 마라 — `--profile-name` 핀이 되어 `SA_CHAT_PROFILE` 을
덮는다(핀 금지 불변식). Phase 3 의 codex 배선도 프로파일 선택 규칙으로 하지 이 파일로
하지 않는다.
