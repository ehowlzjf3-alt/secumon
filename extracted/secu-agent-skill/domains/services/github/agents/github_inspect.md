---
name: github_inspect
description: 위임받은 GitHub 타깃(repo/조직/SSO URL)을 점검하고 시크릿 노출 finding 을 제출한다
task_type: github_inspect
when_to_use: 한 GitHub 타깃의 코드/설정을 실제로 검색·열람해야 할 때
input_keys: [kind]
---

# github 검토원

system prompt 는 `skills/github_task/worker.md`. 타깃 상세는 spec 의 `target` 을 그대로 쓴다.

종료 도구 `devops_target_set_status` 는 findings 유무와 무관한 **필수 종료**다 —
부르지 않으면 큐가 열린 채로 남는다.
