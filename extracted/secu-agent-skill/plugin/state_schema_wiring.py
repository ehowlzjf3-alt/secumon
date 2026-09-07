"""스킬 state 네임스페이스 등록 — bootstrap 과 테스트가 공유하는 단일 진입점.

`plugin/bootstrap.py` 는 import 시 module-level `register_all()` 을 실행해 evidence_judge/
agent_type 까지 등록하므로, state-schema 등록만 필요한 테스트가 `import plugin.bootstrap` 하면
그 self-registering 테스트들과 `ValueError`(중복 등록) 충돌한다. state 네임스페이스 등록 로직을
이 모듈로 분리해, 테스트/conftest 가 **register_all() 을 트리거하지 않고** 등록할 수 있게 한다.
bootstrap 은 이 함수에 위임한다(단일 소스 — codex-F-#4 계약 검증도 이 함수를 그대로 탄다).
"""
from __future__ import annotations

from secu_agent.state import register_schema


def register_state_schemas() -> None:
    """P2 W2: 스킬 state 네임스페이스(skill_smb/dev_web/github/confluence/quality)를 코어 StatePort 에 순수 메모리 등록.

    additive — register 는 DB 무접근(schema_orchestrator). 실제 DDL apply 는 첫 connection(ns)/
    apply_schema 때만이라 현 런타임(connect()=baseline)엔 무영향(dormant registration). **platform 은
    등록하지 않는다** — 코어 소유. MIGRATIONS [(note, ddl)] → orchestrator 가 기대하는
    [(version:int, ddl)] 로 enumerate(1-based) 변환(append-only 불변식). checksum-멱등이라 재호출 no-op.
    repo-root 상대 import 는 함수 안에서(파일 플러그인 로더 sys.path 삽입 뒤 실행되도록).
    """
    from service.state_split import (  # noqa: PLC0415 — sys.path 삽입 후 지연 import
        skill_confluence,
        skill_dev_web,
        skill_github,
        skill_quality,
        skill_smb,
    )

    for module in (skill_smb, skill_dev_web, skill_github, skill_confluence, skill_quality):
        register_schema(
            module.NAMESPACE,
            module.BASELINE_DDL,
            migrations=[(i, ddl) for i, (_note, ddl) in enumerate(module.MIGRATIONS, 1)],
            idless_tables=module.IDLESS_TABLES,
        )
