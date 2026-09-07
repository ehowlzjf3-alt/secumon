---
name: dev_web_inspect
description: 위임받은 dev/stage 웹 타깃을 read-only 로 점검하고 finding 을 제출한다
task_type: dev_web_inspect
when_to_use: 한 웹 타깃의 라우트/응답/스크린샷을 실제로 확인해야 할 때
input_keys: [target_id]
---

# dev_web 검토원

system prompt 는 `skills/dev_web_task/worker.md`. 타깃 상세는 `target_id` 로
DB(`dev_web_target_get`)에서 읽는다.

스크린샷 되먹임이 근거의 핵심이라, 선택된 모델이 이미지를 못 받으면 계약이 gemma 로
대체한다(`profile:` 핀 금지 — 위 smb 정의의 주의 참조).
