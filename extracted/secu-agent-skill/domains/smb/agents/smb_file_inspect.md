---
name: smb_file_inspect
description: 위임받은 SMB 호스트의 공유를 정밀 검토하고 민감정보 finding 을 제출한다
task_type: smb_file_inspect
when_to_use: 한 호스트의 공유 목록을 실제로 열어 파일 본문까지 확인해야 할 때
input_keys: [host]
---

# smb 검토원

본문은 사람이 읽는 설명이다 — 워커의 system prompt 는 `skills/smb_task/worker.md`
에서 `TaskContract.system_prompt` 로 공급된다(`AgentDef.body` 는 코어가 쓰지 않는다).

입력은 `host` 하나면 된다. 공유 목록·share_ids 는 spec 에 있으면 그대로 쓰고,
없으면 DB(`smb_shares_of_host`)에서 되살린다.

⚠️ `profile:` 을 넣지 마라 — `--profile-name` 으로 argv 에 실려 `SA_CHAT_PROFILE`
보다 우선하는 **핀**이 된다. 모델은 전역 프로파일이 정하고, 이미지가 필요한 경우의
대체(gemma)는 계약이 능력 기준으로 처리한다.
