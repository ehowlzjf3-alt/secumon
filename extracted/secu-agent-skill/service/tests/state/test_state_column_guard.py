"""v3.51-S2: state.py dynamic column kwargs key 검증 — SQLi defense."""
from __future__ import annotations

import pytest

import service.state_domain as sd
from secu_agent import state


def test_share_set_status_rejects_bad_column():
    with pytest.raises(ValueError, match="invalid column"):
        sd.share_set_status(1, "walked", **{"status WHERE 1=1--": "x"})


def test_share_set_status_rejects_uppercase():
    with pytest.raises(ValueError):
        sd.share_set_status(1, "walked", BadColumn="x")


def test_share_set_status_rejects_dash():
    with pytest.raises(ValueError):
        sd.share_set_status(1, "walked", **{"my-col": "x"})


def test_schedule_update_rejects_unknown_field():
    """schedule_update 는 자체 whitelist 가드 있음 — 다른 메커니즘이지만 같은 효과."""
    with pytest.raises(ValueError, match="cannot update field"):
        state.schedule_update(1, **{"injected_col": "y"})


def test_valid_column_name_accepted_validator():
    # validator 자체 단위 — 정상 이름 통과
    from secu_agent.state import _validate_column_names
    _validate_column_names(["status", "summary", "updated_at"])  # no raise


def test_validator_rejects_empty():
    from secu_agent.state import _validate_column_names
    with pytest.raises(ValueError):
        _validate_column_names([""])
