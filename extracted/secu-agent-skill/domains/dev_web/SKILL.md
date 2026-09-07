---
name: dev_web
domain: dev_web
description: E2E pipeline skill for internal development web exposure tasking, reporting, and reverify.
when_to_use: Internal dev/stage/test web exposure review and remediation tracking.
triggers: dev_web, dev web, 개발 웹, stage web, test web, cdep dev
---

> ⚠️ 이 파일은 **로드되는 skill 이 아니다**. `domains/` 는 skill 탐색 경로가 아니라
> (`_skill_search_dirs()` 는 `domains/<d>/skills` 만 본다) 여기 있는 SKILL.md 는
> `skill(action='view', ...)` 로 열 수 없다. 사람이 읽는 도메인 개요다.
> 워커가 실제로 여는 계약은 `skills/<name>/` 아래에 있다.


# dev_web_tasking

dev_web is an E2E domain pipeline modeled after SMB E2E but optimized for web
targets. It owns discovery, per-site inspection, report queueing, remediation
mail, and reverify state in this repository. The secu-agent engine remains
domain-neutral.

## Threat Model

Targets are authorized internal dev/stage/test websites. Findings must describe
internal unauthenticated or under-authorized access, not internet exposure unless
that was separately verified. Treat keyword matches as leads only.

## Required Evidence

- Render the page or use `web_site_sweep`; do not submit from static keyword hits.
- Confirm exposed resources with `web_resource_probe` or bounded `web_fetch`.
- Submit only masked values and concrete fields, filenames, route names, counts,
  or screenshots/evidence references.
- Use `dev_web_submit_finding` for confirmed issues so report threads are queued.
- Mark the target with `dev_web_target_set_status` when the site is complete.

## E2E Plans

- `dev_web_task`: claim one `dev_web_target`, inspect, submit findings, queue report.
- `dev_web_report`: build and deliver one remediation report.
- `dev_web_reply_verify`: recheck one replied report thread.
- `dev_web_e2e_agents`: run task, report, and reply/reverify phases sequentially.

Resources: `api.md`, `schema.md`, `safety.md`.
