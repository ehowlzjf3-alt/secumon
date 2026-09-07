"""service.collector — LLM-free SMB E2E 수집기 (smb_domain_e2e 요구 1·2).

코드 cron 러너 패키지. 토큰 0. secu-agent 코어 무수정 — discovery 오케스트레이션을
skill repo 가 소유하고 이미 있는 `domains/smb/plugin/agent_types/smb.py` +
`service/state_domain.py` 만 직접 호출한다. 구 모놀리스 `cli.run_smb_discovery_core`
패턴을 skill repo 로 재구성한 것(재구현 아님 — 같은 smb.py/state 함수 재사용).

실행: `python -m service.collector.runner`
"""
