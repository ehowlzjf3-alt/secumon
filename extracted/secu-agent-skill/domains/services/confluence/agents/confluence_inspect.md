---
name: confluence_inspect
description: 위임받은 Confluence space(또는 space 묶음)를 점검하고 finding 을 제출한다
task_type: confluence_inspect
when_to_use: space 단위로 페이지·첨부를 열람해 민감정보를 확인해야 할 때
input_keys: [kind]
---

# confluence 검토원 (space)

system prompt 는 `skills/confluence_task/worker.md`.

⚠️ keyword_search 는 **다른 검토원**(`confluence_search_inspect`)이다. 종료 도구가
달라서 나눴다 — 합치면 검색 워커가 space 큐를 'ok' 로 닫을 수 있다.
