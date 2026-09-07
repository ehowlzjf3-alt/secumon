"""paste_format.detect_format — 가벼운 regex 기반 구조 감지.

샘플링: 첫 1000 chars, 최대 30줄. 70%+ 매치되는 패턴이 있으면 hint 반환.
"""
from __future__ import annotations


def test_detect_cidr_list():
    from secu_agent.agent.paste_format import detect_format
    text = "\n".join(f"198.51.100.{i}.0/24" for i in range(15))
    hint = detect_format(text)
    assert hint is not None
    assert hint.startswith("cidr_list")


def test_detect_cidr_with_header_line():
    """첫 줄이 'IP대역' 같은 헤더 — 그래도 cidr_list 인식."""
    from secu_agent.agent.paste_format import detect_format
    text = "IP대역\n" + "\n".join(f"198.51.100.{i}.0/24" for i in range(20))
    hint = detect_format(text)
    assert hint is not None
    assert "cidr" in hint


def test_detect_ip_list_not_cidr():
    from secu_agent.agent.paste_format import detect_format
    text = "\n".join(f"192.0.2.{i}" for i in range(15))
    hint = detect_format(text)
    assert hint is not None
    assert hint.startswith("ip_list")


def test_detect_hostname_list():
    from secu_agent.agent.paste_format import detect_format
    text = "\n".join(f"srv{i:02d}.samsung.net" for i in range(15))
    hint = detect_format(text)
    assert hint is not None
    assert "hostname" in hint


def test_detect_url_list():
    from secu_agent.agent.paste_format import detect_format
    text = "\n".join(f"https://example.com/page{i}" for i in range(10))
    hint = detect_format(text)
    assert hint is not None
    assert "url" in hint


def test_detect_hash_list_sha256():
    from secu_agent.agent.paste_format import detect_format
    text = "\n".join("a" * 64 for _ in range(10))
    hint = detect_format(text)
    assert hint is not None
    assert "hash" in hint


def test_detect_json():
    from secu_agent.agent.paste_format import detect_format
    text = '{"shares": [{"host": "x", "share": "y"}], "count": 1}'
    hint = detect_format(text)
    assert hint == "json"


def test_detect_json_array():
    from secu_agent.agent.paste_format import detect_format
    text = '[\n  {"a": 1},\n  {"a": 2}\n]'
    hint = detect_format(text)
    assert hint == "json"


def test_detect_yaml():
    from secu_agent.agent.paste_format import detect_format
    text = """---
name: foo
version: 1
deps:
  - bar
  - baz
"""
    hint = detect_format(text)
    assert hint is not None
    assert "yaml" in hint


def test_detect_python_code():
    from secu_agent.agent.paste_format import detect_format
    text = """import os
import sys
def main():
    return 1
class Foo:
    pass
"""
    hint = detect_format(text)
    assert hint is not None
    assert "python" in hint


def test_detect_csv():
    from secu_agent.agent.paste_format import detect_format
    text = "a,b,c\n1,2,3\n4,5,6\n7,8,9\n10,11,12"
    hint = detect_format(text)
    assert hint is not None
    assert "csv" in hint


def test_detect_log_lines_iso_timestamp():
    from secu_agent.agent.paste_format import detect_format
    text = "\n".join(
        f"2026-05-13T10:11:{i:02d}Z [INFO] something happened"
        for i in range(10)
    )
    hint = detect_format(text)
    assert hint is not None
    assert "log" in hint


def test_detect_mixed_returns_none_or_low_confidence():
    """뒤죽박죽이면 None — 헤더 1줄 + 자연어 + 코드 등."""
    from secu_agent.agent.paste_format import detect_format
    text = "this is some text\nanother line\nyet another sentence\nrandom stuff"
    hint = detect_format(text)
    # natural language — no specific pattern
    assert hint is None or "unknown" in (hint or "")


def test_detect_short_text_returns_none():
    from secu_agent.agent.paste_format import detect_format
    assert detect_format("hi") is None
    assert detect_format("") is None


def test_detect_includes_confidence_percent():
    """hint 안에 confidence 정보가 들어있는지 — 'cidr_list (95%)' 같은 형식."""
    from secu_agent.agent.paste_format import detect_format
    text = "\n".join(f"198.51.100.{i}.0/24" for i in range(20))
    hint = detect_format(text)
    assert hint is not None
    # 형식: "cidr_list (NN%)" or "cidr_list" — confidence 포함이 권장
    assert "%" in hint or "cidr_list" == hint
