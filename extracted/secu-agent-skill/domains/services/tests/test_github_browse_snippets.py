"""github_browse 컨텍스트 절약 계약 (v3.95).

고정하는 것 두 가지.

1. **절약**: patterns 를 주면 매칭 줄 ± 3줄만 온다. 안 주면 앞 4,000자만 온다.
   실측 배경 — 이 도구가 도구 반환 총량의 88% 였고, 그게 매 턴 재전송돼
   input_tokens 1,108,687(예산 500,000의 2.26배)을 만들었다.

2. **무손실**: 뭘 잘라 보내든 전체 본문은 evidence 파일에 남는다.
   이게 깨지면 "절약"이 곧 "증거 유실"이 된다 — 게이트 무약화 금지와 같은 계열의 불변식.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from domains.services.github.plugin.tools import github_browse_tool as gbt


# ── 스니펫 추출 ───────────────────────────────────────────────────────────
def test_snippet_returns_matched_line_with_context():
    body = "\n".join(f"line{i}" for i in range(20))
    body = body.replace("line10", 'PROD_TOKEN = "c230c01d-abcd"')
    snippets, matched = gbt._extract_snippets(body, ["PROD_TOKEN"])
    assert matched == 1
    assert len(snippets) == 1
    text = snippets[0]["text"]
    assert 'PROD_TOKEN = "c230c01d-abcd"' in text
    # ± 3줄 맥락 — 자리표시자/샘플 판단에 필요하다.
    assert "line7" in text and "line13" in text
    assert "line6" not in text and "line14" not in text
    assert snippets[0]["start_line"] == 8      # 1-indexed
    assert snippets[0]["matched"] == ["PROD_TOKEN"]


def test_snippet_is_far_smaller_than_the_whole_page():
    """절약이 실제로 일어나는지 — 이 테스트가 도구의 존재 이유다."""
    body = "\n".join(["filler line with plenty of text"] * 500)
    body += '\nAWS_KEY = "AKIAIOSFODNN7EXAMPLE"\n'
    body += "\n".join(["more filler"] * 500)
    snippets, matched = gbt._extract_snippets(body, ["AKIA"])
    rendered = json.dumps(snippets, ensure_ascii=False)
    assert matched == 1
    assert len(rendered) < len(body) / 10


def test_adjacent_matches_merge_into_one_block():
    """겹치는 맥락을 두 번 실어 보내지 않는다."""
    body = "\n".join(["a", "b", "SECRET=1", "c", "SECRET=2", "d", "e"])
    snippets, matched = gbt._extract_snippets(body, ["SECRET"])
    assert matched == 2
    assert len(snippets) == 1                  # 인접이라 병합
    assert snippets[0]["text"].count("SECRET") == 2


def test_distant_matches_stay_separate():
    body = "\n".join(["SECRET=1"] + ["pad"] * 50 + ["SECRET=2"])
    snippets, _ = gbt._extract_snippets(body, ["SECRET"])
    assert len(snippets) == 2


def test_patterns_are_literal_not_regex():
    """⚠️ 모델이 넘기는 값엔 정규식 메타문자가 섞인다 — `xoxb-`·`$VAR`·`a.b`."""
    body = 'token = "xoxb-123"\nother = "xoxbZ123"'
    snippets, matched = gbt._extract_snippets(body, ["xoxb-"])
    assert matched == 1
    assert "xoxb-123" in snippets[0]["text"]

    # 디코이는 ±3줄 맥락 **밖**에 둔다 — 맥락으로 딸려오는 건 누수가 아니다.
    body2 = "cost = a.b" + ("\npad" * 10) + "\nliteral = aXb"
    snippets2, matched2 = gbt._extract_snippets(body2, ["a.b"])
    assert matched2 == 1                       # `.` 가 와일드카드였다면 aXb 도 매칭된다
    assert len(snippets2) == 1
    assert "aXb" not in snippets2[0]["text"]


def test_pattern_matching_is_case_insensitive():
    snippets, matched = gbt._extract_snippets('Prod_Token = "x"', ["prod_token"])
    assert matched == 1


def test_no_match_returns_empty():
    snippets, matched = gbt._extract_snippets("nothing here", ["AKIA"])
    assert snippets == [] and matched == 0


def test_blank_patterns_are_ignored():
    """빈 문자열이 모든 줄에 매칭돼 전체를 되돌려주면 절약이 무의미해진다."""
    body = "\n".join(f"line{i}" for i in range(50))
    snippets, matched = gbt._extract_snippets(body, ["", "   "])
    assert snippets == [] and matched == 0


# ── 무손실 (전체 본문 보존) ───────────────────────────────────────────────
class _Ctx:
    def __init__(self, d): self.evidence_dir = d


def test_full_body_is_written_even_when_response_is_truncated(tmp_path):
    body = "SECRET_VALUE=1\n" + ("x" * 60000)
    rel = gbt._write_snapshot(body, _Ctx(tmp_path))
    assert rel is not None
    assert (tmp_path / rel).read_text(encoding="utf-8") == body


def test_snapshot_path_is_relative_to_evidence_dir(tmp_path):
    """read_file(path=...) 에 그대로 넘길 수 있어야 한다."""
    rel = gbt._write_snapshot("body", _Ctx(tmp_path))
    assert not Path(rel).is_absolute()


def test_missing_evidence_dir_does_not_break_the_tool(tmp_path):
    """evidence_dir 이 없어도 열람 자체는 계속돼야 한다(경로만 None)."""
    class _NoDir:
        evidence_dir = None
    assert gbt._write_snapshot("body", _NoDir()) is None


def test_two_snapshots_do_not_collide(tmp_path):
    ctx = _Ctx(tmp_path)
    a = gbt._write_snapshot("first", ctx)
    b = gbt._write_snapshot("second", ctx)
    assert a != b
    assert (tmp_path / a).read_text() == "first"
    assert (tmp_path / b).read_text() == "second"


# ── 배선 계약 ─────────────────────────────────────────────────────────────
def test_input_model_exposes_patterns_with_safe_default():
    m = gbt.GithubBrowseInput(url="https://github.samsungds.net/o/r")
    assert m.patterns == []                    # 기본은 기존 동작(훑어보기)
    assert m.max_chars == 12000                # 하위호환 유지


def test_no_pattern_inline_cap_is_smaller_than_max_chars():
    """patterns 없이 부를 때 12,000자가 그대로 나가면 절약이 안 된다."""
    assert gbt._NO_PATTERN_INLINE_CHARS < 12000


def test_prompt_section_tells_the_worker_to_pass_patterns():
    """배선이 사라지면 워커가 patterns 를 안 넘겨 절약이 死코드가 된다."""
    assert "patterns" in gbt.GithubBrowseTool.prompt_section
    assert "snapshot_path" in gbt.GithubBrowseTool.prompt_section


def test_worker_md_documents_the_patterns_contract():
    src = (Path(__file__).resolve().parents[3]
           / "domains/services/github/skills/github_task/worker.md").read_text(encoding="utf-8")
    assert "patterns=[...]" in src
    assert "snapshot_path" in src
