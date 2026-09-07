"""finding identity/discovery 테스트 — 엔진 코어에서 이동 (v3.82 U3b→U3d 활성화).

대상 함수(discovery_method/github_identity/confluence_identity)는
service/services/finding_identity.py 소유. classify 는 코어 taxonomy 잔존분.
"""
from __future__ import annotations

from secu_agent.finding_taxonomy import classify

from service.services.finding_identity import (
    confluence_identity, discovery_method, github_identity,
)


def test_discovery_method():
    assert discovery_method("github:org/repo/x") == "api"
    assert discovery_method("https://github.samsungds.net/raw/o/r/main/x") == "sso"
    assert discovery_method("smb://fs/share/f") == "api"
    assert discovery_method("repo/app") == ""


def test_github_identity_api_and_sso_match():
    # v3.75: API(github:) 와 SSO(https raw) 폼이 같은 org/repo::파일명 키로 정규화 → 교차확인 dedup
    api = github_identity("github:RSIP/recipe_encoder/config/config.yaml")
    sso = github_identity(
        "https://github.samsungds.net/raw/RSIP/recipe_encoder/main/config/config.yaml")
    assert api == sso == "rsip/recipe_encoder::config.yaml"
    assert github_identity("smb://x/y") is None
    assert github_identity("https://confluence.samsungds.net/display/X/P") is None


def test_confluence_identity_api_and_sso_match():
    # v3.76: API(confluence:SPACE:..) 와 SSO(/display/SPACE) 가 같은 bare 소문자 space key 로 정규화
    api = confluence_identity("confluence:RSIP:12345")
    sso_display = confluence_identity("https://confluence.samsungds.net/display/RSIP/Recipe-Page")
    sso_spaces = confluence_identity("https://confluence.samsungds.net/spaces/RSIP/pages/9")
    assert api == sso_display == sso_spaces == "rsip"


def test_confluence_identity_api_with_suffix():
    # comment/version/attachment suffix 있어도 첫 세그먼트 space key.
    assert confluence_identity("confluence:OPS:42/comment/0") == "ops"
    assert confluence_identity("confluence:OPS:42/version/3") == "ops"


def test_confluence_identity_legacy_and_non_confluence_none():
    # space 없는 legacy(CQL/page_ids 폴백) → None.
    assert confluence_identity("confluence:42") is None
    assert confluence_identity("confluence:42/comment/0") is None
    # 비-confluence → None.
    assert confluence_identity("github:org/repo/x") is None
    assert confluence_identity("https://github.samsungds.net/o/r") is None
    assert confluence_identity("smb://fs/share/x") is None
    assert confluence_identity("") is None


def test_classify_no_hits_is_uncategorized():
    # category 는 고정 enum — hit/category 없으면 enum 밖 분류를 지어내지 않고 '미분류'.
    assert classify(hits=[], asset_kind="url") == {"key": "uncategorized", "label": "미분류"}
    assert classify(hits=None, asset_kind="page") == {"key": "uncategorized", "label": "미분류"}
    assert classify(hits=[{"kind": "x"}], asset_kind="repository")["key"] == "uncategorized"


