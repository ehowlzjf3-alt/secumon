"""게이트웨이 설정 — fail-closed. 엔진 DSN 재사용, 신규 DSN 생성 금지.

경계(§3-3·ADR 0005): 게이트웨이는 control-plane과 별개 프로세스이며, 도메인 DB
threat_hunter를 엔진과 **동일한** `SECU_AGENT_PG_DSN`으로 **읽기만** 한다. control-plane의
CONTROL_PG_DSN(digisecu_control)과 물리·논리적으로 분리된다.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """설정 누락/오류 — fail-closed(기동 중단)."""


def _require(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise ConfigError(
            f"{name} 미설정 — 게이트웨이는 fail-closed로 기동을 거부한다."
        )
    return v


@dataclass(frozen=True)
class Config:
    # 엔진과 공유하는 도메인 DB(threat_hunter) DSN. 신규 DSN 생성 금지 — 엔진과 동일 값 주입.
    pg_dsn: str
    # /gw authz 공유 토큰. 미설정=fail-closed(모든 요청 거부). 프로덕션 authn/authz/tenant 격리는 후속(하드닝).
    token: str
    host: str = "127.0.0.1"  # 기본 localhost 바인드 — 공개 노출 금지(read-only는 기밀성 경계가 아님, codex #5)
    port: int = 8091
    # 쿼리 비용 제한 — 폭주 SELECT/공유 DB 부하 방지(codex #5).
    statement_timeout_ms: int = 5000
    idle_in_txn_timeout_ms: int = 10000
    pool_min: int = 1
    pool_max: int = 4
    # search_path — v3.88 StatePort 스키마 분리 대응. P1이 finding_lifecycle 등 코어 16테이블을
    # public→core 로 옮겼고(RO 롤 기본 search_path엔 core 부재 → unqualified 쿼리 42P01), P2가
    # 스킬/platform 테이블을 skill_*/platform 으로 옮긴다. 존재하지 않는 스키마는 PG가 조용히 무시하므로
    # 최종 스키마 집합을 미리 나열해도 안전하고, public 을 마지막에 둬 이관 창 동안 미이관 테이블도 resolve.
    # (USAGE 권한은 sql/001_readonly_role.sql 이 별도 부여 — search_path 는 해소 순서만 정한다.)
    search_path: str = "core,platform,skill_smb,skill_dev_web,skill_github,skill_confluence,skill_quality,public"

    @staticmethod
    def load() -> "Config":
        return Config(
            pg_dsn=_require("SECU_AGENT_PG_DSN"),
            token=_require("GATEWAY_TOKEN"),
            host=os.environ.get("GATEWAY_HOST", "127.0.0.1").strip() or "127.0.0.1",
            port=int(os.environ.get("GATEWAY_PORT", "8091")),
            statement_timeout_ms=int(os.environ.get("GATEWAY_STATEMENT_TIMEOUT_MS", "5000")),
            idle_in_txn_timeout_ms=int(os.environ.get("GATEWAY_IDLE_IN_TXN_MS", "10000")),
            pool_min=int(os.environ.get("GATEWAY_POOL_MIN", "1")),
            pool_max=int(os.environ.get("GATEWAY_POOL_MAX", "4")),
            search_path=(
                os.environ.get(
                    "GATEWAY_SEARCH_PATH",
                    "core,platform,skill_smb,skill_dev_web,skill_github,skill_confluence,skill_quality,public",
                ).strip()
                or "core,public"
            ),
        )
