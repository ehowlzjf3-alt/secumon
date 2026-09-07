"""크리덴셜 핸들 — 도메인 중립 (Phase 2c).

## 문제

리드가 "이 크리덴셜로 저기 들어가 봐" 라고 지시하려면 크리덴셜을 **가리킬** 수 있어야
한다. 그런데 리드는 Phase 3 에서 사외(codex)다 — 값을 보면 안 된다.

## 답: 좌표만 준다

`CredHandle` 은 **값이 없다.** id·종류·출처좌표·검증여부·쓰인 범위 수뿐이다.
리드는 `delegate_inspect(..., use_cred=<id>)` 로 id 만 넘기고, 값 재료화는 검토원
프로세스 안에서만 일어난다(`cred_resolve_password` 는 state 함수이고, 리드 도구셋에는
그걸 부를 수 있는 도구가 없다 — 임의 실행 도구가 없다).

이 패턴은 새로 발명한 게 아니다. `smb_credential_login_probe_tool` 이 이미 정확히
그렇게 한다: 좌표(share/path/line_no)만 받고, 원문은 **도구가 내부에서 재-fetch** 하며,
raw 비번은 반환/저장하지 않고, 닫힌 enum(`authenticated`/`auth_failed`)만 돌려준다.
여기서는 그 계약을 도메인 중립 형태로 올린 것뿐이다.

## ⚠️ `password_ref` 도 내보내지 않는다

DB 는 평문을 저장하지 않고 `env:VAR_NAME` 만 갖는다(`cred_add`). 값은 아니지만 **env 변수
이름**이고, 그건 사외에 줄 이유가 없는 내부 구성 정보다. 핸들은 `source_ref` 로
`smb_credential#7` 같은 **테이블 좌표**만 준다.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

# 핸들에 절대 들어가면 안 되는 키 — 테스트가 이 목록으로 검사한다.
FORBIDDEN_HANDLE_KEYS: frozenset[str] = frozenset({
    "password", "passwd", "pwd", "secret", "token", "password_ref",
    "api_key", "private_key", "value", "raw",
})


@dataclass(frozen=True, slots=True)
class CredHandle:
    """리드가 볼 수 있는 크리덴셜의 전부."""

    id: int
    type: str            # "smb_account" 등 — 어떤 종류의 크리덴셜인가
    source_ref: str      # 어디 있는가 (테이블 좌표). env 변수명·값 아님.
    validated: bool      # 유효성 검증을 통과한 적이 있는가
    scope_count: int     # 이 크리덴셜이 붙어 있는 타깃 수 (재사용 폭 = 위험도 신호)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def smb_cred_handles(*, enabled_only: bool = True) -> list[dict[str, Any]]:
    """SMB 크리덴셜 → 값 없는 핸들 목록.

    현재 크리덴셜 테이블을 가진 도메인은 smb 뿐이다. 다른 도메인이 생기면 같은 모양의
    함수를 추가하고 어댑터가 그것을 부른다 — 핸들 **모양**은 공통이다.
    """
    from service import state_domain as state

    out: list[dict[str, Any]] = []
    for row in state.cred_list(enabled_only=enabled_only):
        cid = int(row["id"])
        out.append(CredHandle(
            id=cid,
            type="smb_account",
            source_ref=f"smb_credential#{cid}",
            # auth_login_ok=1 인 공유가 하나라도 있으면 "실제로 통했다".
            validated=_smb_cred_validated(cid),
            scope_count=_smb_cred_scope_count(cid),
        ).as_dict())
    return out


def _smb_cred_scope_count(cred_id: int) -> int:
    from service import state_domain as state

    try:
        with state.connect() as c:
            r = c.execute(
                "SELECT COUNT(*) AS n FROM smb_share WHERE auth_credential_id=?",
                (cred_id,),
            ).fetchone()
        return int(r["n"]) if r else 0
    except Exception:  # noqa: BLE001 — 핸들 조회 실패가 리드를 막지 않는다
        return 0


def _smb_cred_validated(cred_id: int) -> bool:
    from service import state_domain as state

    try:
        with state.connect() as c:
            r = c.execute(
                "SELECT COUNT(*) AS n FROM smb_share "
                "WHERE auth_credential_id=? AND auth_login_ok=1",
                (cred_id,),
            ).fetchone()
        return bool(r and int(r["n"]) > 0)
    except Exception:  # noqa: BLE001
        return False
