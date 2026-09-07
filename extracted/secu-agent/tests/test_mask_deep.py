"""F3: mask_deep — 영속/egress 경계 재귀 마스킹 (평문 PII/secret 봉쇄, fail-closed)."""
from __future__ import annotations

from secu_agent.detectors import text_scan
from secu_agent.detectors.text_scan import mask_deep


def test_mask_deep_masks_string_leaves_recursively():
    out = mask_deep({"a": {"b": ["AKIA1234567890ABCDEF", "clean text"]},
                     "s": "password=hunter2secret"})
    assert "AKIA1234567890ABCDEF" not in str(out)
    assert "hunter2secret" not in str(out)
    assert out["a"]["b"][1] == "clean text"  # 비민감 보존


def test_mask_deep_preserves_non_str_and_none():
    out = mask_deep({"n": 5, "f": 1.5, "b": True, "z": None})
    assert out == {"n": 5, "f": 1.5, "b": True, "z": None}


def test_mask_deep_preserve_keys_verbatim():
    out = mask_deep({"kind": "aws_access_key_id", "val": "AKIA1234567890ABCDEF"},
                    preserve_keys=frozenset({"kind"}))
    assert out["kind"] == "aws_access_key_id"
    assert "AKIA1234567890ABCDEF" not in out["val"]


def test_mask_deep_cycle_guard():
    c: dict = {}
    c["self"] = c
    out = mask_deep(c)
    assert out["self"] == text_scan._MASK_DEEP_FAILCLOSED


def test_mask_deep_fail_closed_on_masker_error(monkeypatch):
    def _boom(s):
        raise RuntimeError("scanner dead")
    monkeypatch.setattr(text_scan, "mask_scanned_text", _boom)
    out = mask_deep({"secret": "raw-plaintext-value"})
    # 마스킹 실패 시 원문이 아니라 placeholder (평문 유출 금지)
    assert out["secret"] == text_scan._MASK_DEEP_FAILCLOSED
    assert "raw-plaintext-value" not in str(out)


def test_mask_deep_max_depth_fail_closed():
    # 과깊은 중첩 → placeholder (원문 유출 금지)
    deep = cur = {}
    for _ in range(60):
        cur["x"] = {}
        cur = cur["x"]
    cur["leaf"] = "AKIA1234567890ABCDEF"
    assert "AKIA1234567890ABCDEF" not in str(mask_deep(deep))
