"""v3.80 Slice0a: make_sub_evidence_dir — sub-agent evidence dir 초단위 충돌 제거.

기존 회귀: `sub-{%Y%m%dT%H%M%S}-{label}` + mkdir(exist_ok=True) 는 같은 초에
2개 spawn 시 같은 dir 를 **조용히 재사용** — 두 sub-agent 의 task_spec/result 가
한 dir 에 혼입. 보장해야 할 것:
① 같은 초 spawn 도 항상 서로 다른 dir, ② fail-closed (재사용 없음),
③ nonce 소진(인위적 충돌) 시 명시적 에러, ④ 이름 포맷 sub-{ts}-{nonce}-{label}.
"""
from __future__ import annotations

import re

import pytest

from secu_agent.agent.tools import base as tools_base
from secu_agent.agent.tools.base import make_sub_evidence_dir

_NAME_RE = re.compile(r"^sub-\d{8}T\d{6}-[0-9a-f]{6}-.+$")


def test_same_second_spawns_get_distinct_dirs(tmp_path, monkeypatch):
    # 같은 초로 고정 — 기존 구현이면 두 호출이 같은 이름.
    monkeypatch.setattr(tools_base.time, "strftime", lambda fmt: "20260612T140000")
    a = make_sub_evidence_dir(tmp_path, "smb_file_inspect-42")
    b = make_sub_evidence_dir(tmp_path, "smb_file_inspect-42")
    assert a != b
    assert a.is_dir() and b.is_dir()
    assert _NAME_RE.match(a.name) and _NAME_RE.match(b.name)


def test_collision_retries_with_new_nonce(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_base.time, "strftime", lambda fmt: "20260612T140000")
    # nonce 시퀀스: 1번째 호출 aaaaaa → 2번째 호출 aaaaaa(충돌)→bbbbbb(성공)
    seq = iter(["aaaaaa" + "0" * 26, "aaaaaa" + "0" * 26, "bbbbbb" + "0" * 26])

    class _U:
        def __init__(self, h: str) -> None:
            self.hex = h

    monkeypatch.setattr(tools_base.uuid, "uuid4", lambda: _U(next(seq)))
    first = make_sub_evidence_dir(tmp_path, "x")
    second = make_sub_evidence_dir(tmp_path, "x")
    assert first.name.split("-")[2] == "aaaaaa"
    assert second.name.split("-")[2] == "bbbbbb"


def test_exhausted_retries_raise(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_base.time, "strftime", lambda fmt: "20260612T140000")

    class _U:
        hex = "cccccc" + "0" * 26

    monkeypatch.setattr(tools_base.uuid, "uuid4", lambda: _U())
    make_sub_evidence_dir(tmp_path, "y")  # cccccc 선점
    with pytest.raises(RuntimeError, match="3회"):
        make_sub_evidence_dir(tmp_path, "y")  # 3회 전부 cccccc → fail-closed


def test_nonce_is_real_uuid_by_default(tmp_path):
    p = make_sub_evidence_dir(tmp_path, "z")
    nonce = p.name.split("-")[2]
    assert len(nonce) == 6
    int(nonce, 16)  # hex 가 아니면 ValueError
    # uuid 실호출 경로 sanity — 같은 부모에 100회 생성해도 전부 distinct.
    names = {make_sub_evidence_dir(tmp_path, "z").name for _ in range(100)}
    assert len(names) == 100
