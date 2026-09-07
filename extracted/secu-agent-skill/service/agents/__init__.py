"""service.agents — SMB E2E LLM 에이전트 3종 (점검·조치요청·답장재검증).

엔진 무수정 원리: 엔진 worker entrypoint(cli.py)는 generic/finding_narrator/
package_sandbox task_type 만 알고 build_registry_for_task 는 하드코딩이다(=(C) 병목).
따라서 skill repo 가 **자체 에이전트 런타임**(runtime.py)을 소유해 도메인 도구 +
skill 프롬프트로 GuardedHarness 를 직접 구동한다. 엔진은 그대로 둔다.

깨우개 = service.collector 의 cron/poll 러너(또는 신규 서비스). 핸드오프 = DB status.
"""
