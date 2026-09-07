---
name: confluence_search_inspect
description: 위임받은 Confluence 키워드 검색을 수행하고 finding 을 제출한다
task_type: confluence_search_inspect
when_to_use: space 를 훑는 대신 키워드로 전역 검색해야 할 때
input_keys: [kind]
---

# confluence 검토원 (keyword_search)

system prompt 는 `skills/confluence_task/worker.md` (space 검토원과 같은 계약 본문).

종료 도구는 `confluence_search_set_status` **하나뿐**이다 — 검색 큐만 닫을 수 있고
space/devops 큐는 건드릴 수 없다. 이 격리가 task_type 을 둘로 나눈 이유다.
