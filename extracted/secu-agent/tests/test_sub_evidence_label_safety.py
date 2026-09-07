"""sub-agent evidence dir 이름은 **경로 안전**해야 한다.

label 은 호출자 input 에서 파생되고, 그 input 은 LLM 이 쓴 자유 텍스트일 수 있다
(v3.95 리드가 넘기는 question/scope). 2026-08-21 실측: 한국어 질문 한 문장이 통째로
디렉터리 이름이 됐고, 그 경로를 읽던 쉘 스크립트가 공백에서 깨졌다.

이름은 사람이 훑기 위한 힌트일 뿐이다 — 식별은 ts+nonce 가 한다. 그러니 접어도 잃는 게 없다.
"""
from __future__ import annotations

import pytest

from secu_agent.agent.tools.base import _sanitize_sub_label, make_sub_evidence_dir


@pytest.mark.parametrize("raw", [
    "이 space 내에 실제 배포 크리덴셜, API 키가 있나?",
    'a"b;rm -rf /',
    "with space and\ttab\nnewline",
    "https://github.samsungds.net/org/repo",
    "../../escape",
])
def test_label_has_no_path_or_shell_hostile_chars(raw):
    out = _sanitize_sub_label(raw)
    assert out
    assert not (set(out) - set(
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._-"))
    assert "/" not in out and ".." not in out.strip("._-")


def test_empty_label_still_yields_a_dir(tmp_path):
    d = make_sub_evidence_dir(tmp_path, "")
    assert d.is_dir() and d.name.endswith("-spawn")


def test_label_is_length_bounded(tmp_path):
    d = make_sub_evidence_dir(tmp_path, "x" * 500)
    assert d.is_dir()
    assert len(d.name) < 120


def test_free_text_label_produces_a_usable_dir(tmp_path):
    d = make_sub_evidence_dir(tmp_path, "confluence_inspect-이 space 에 크리덴셜 있나?")
    assert d.is_dir()
    assert " " not in d.name
    # 부모가 glob 으로 되찾을 수 있어야 한다(리드 delegate_inspect 가 이 방식으로 찾는다).
    assert [p.name for p in tmp_path.glob("sub-*")] == [d.name]
